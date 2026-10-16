// ${VAR} expansion the way the real binary does it (README, "What was verified"; put to Claude Code 2.1.295 and 2.1.299):
//   ${VAR}          the value, also when it is empty; an unset variable leaves the text as it is (and Claude Code warns)
//   ${VAR:-text}    the value when VAR is set (also empty), else text (which may be empty and ends at the first "}")
//   not references  $VAR, %VAR%, ~, ${}, ${VAR (no closing brace), ${VAR-text}; there is no escape: $${VAR} is "$" and the value
//   one pass        the text that replaces a reference is not scanned again
// In a remote server's url and headers some credential variables read as empty, whether they are set or not.
import { describeType } from "./jsonfile.mjs";

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Names that Claude Code reads as empty in the url and the headers of a remote server (so that a project's .mcp.json cannot
 * send them to a server it names). These eleven were seen to arrive empty with Claude Code 2.1.299; its documentation adds
 * HTTPS_PROXY and says the list is not complete. Names such as GITHUB_TOKEN, OPENAI_API_KEY and API_KEY expanded.
 */
export const REMOTE_EMPTY = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "NPM_TOKEN", "NODE_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS", "HTTPS_PROXY",
]);

/** The value of an environment variable; the names are not case sensitive on Windows. */
export function envLookup(env, name, platform = process.platform) {
  if (!env) return undefined;
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (platform === "win32") {
    const lower = name.toLowerCase();
    for (const k of Object.keys(env)) if (k.toLowerCase() === lower) return env[k];
  }
  return undefined;
}

/**
 * Expands the references in a text.
 *   env       the variables that count (see the README: the process environment, with the env of the user settings on top)
 *   extra     placeholders that win over env: a plugin's CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA and CLAUDE_PROJECT_DIR
 *   remote    true for the url and the headers of a remote server
 * Returns { text, refs, missing, empty, defaulted, readAsEmpty }: the names referenced, the ones left as they are because
 * they are not set, the ones that are set to an empty string, the ones that took their default, and the credential names that
 * read as empty by rule.
 */
export function expandString(input, { env = process.env, platform = process.platform, extra = {}, remote = false } = {}) {
  const out = { text: input, refs: [], missing: [], empty: [], defaulted: [], readAsEmpty: [] };
  if (typeof input !== "string") return out;
  const add = (list, name) => { if (!list.includes(name)) list.push(name); };
  out.text = input.replace(REFERENCE, (whole, name, dflt) => {
    add(out.refs, name);
    if (Object.prototype.hasOwnProperty.call(extra, name)) return extra[name];
    if (remote && REMOTE_EMPTY.has(name.toUpperCase())) { add(out.readAsEmpty, name); return ""; }
    const value = envLookup(env, name, platform);
    if (value !== undefined) { if (value === "") add(out.empty, name); return value; }
    if (dflt !== undefined) { add(out.defaulted, name); return dflt; }
    add(out.missing, name);
    return whole;
  });
  return out;
}

/** The names of the references in a text, with nothing expanded. */
export function referencesIn(text) {
  const names = [];
  if (typeof text !== "string") return names;
  for (const m of text.matchAll(REFERENCE)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

/** True when a text is one reference and nothing else, with or without a default (${TOKEN}). */
export const isBareReference = (text) => typeof text === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(text);

/**
 * The variables of the environment that expansion sees: the process environment with the `env` of the user's
 * settings.json on top (put to the binary: the user file's value won over the process, the project and local files'
 * env was not used for expansion). Values that are not strings are turned into strings, as Claude Code does.
 */
export function expansionEnv(processEnv, userSettingsEnv) {
  const env = { ...processEnv };
  for (const [k, v] of Object.entries(userSettingsEnv || {})) env[k] = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
  return env;
}

export { describeType };
