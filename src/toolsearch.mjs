// Whether Claude Code puts the schemas of MCP tools in its request, or defers them behind its tool search so that the model sees
// only the names until it loads a tool. What this file knows was put to the real binary (README, "What was verified"), 2.1.295
// to 2.1.312:
//   ENABLE_TOOL_SEARCH      false, 0, no, off (any case, spaces around it do not matter) and auto:100: the schemas are in the request.
//                           true, 1, yes, on, force, auto:0 and any other text: deferred.
//                           auto and auto:N (these two exactly as written, in lower case, N a number that is clamped to 0..100):
//                           in the request until the MCP tools pass N percent (10 for plain auto) of the context window,
//                           and deferred beyond that. Auto, AUTO:20 and " auto" are only text.
//                           not set, or empty: Claude Code's default, below.
//   CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS  (any truthy value) the schemas are in the request, whatever ENABLE_TOOL_SEARCH says.
//   the default: deferred. Before 2.1.304 only while ANTHROPIC_BASE_URL is not set or names api.anthropic.com; another host got
//   the schemas in the request unless ENABLE_TOOL_SEARCH was set. From 2.1.304 every host is tried with deferral, and an
//   endpoint that answers 400 gets the request again with the schemas in it.
// Settings files' `env` blocks win over the process environment, local over project over user (put to 2.1.310); the caller
// passes the environment with them layered, as Claude Code sees it.

/** The first version that defers by default whatever ANTHROPIC_BASE_URL says. */
export const DEFERS_ON_EVERY_HOST_FROM = "2.1.304";

const WORDS = /^(?:true|false|1|0|yes|no|on|off|force)$/i;
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;
/** What is shown for a value of ENABLE_TOOL_SEARCH that is none of the words above. */
export const OTHER_VALUE = "(other text)";
const TRUE_WORDS = new Set(["1", "true", "yes", "on"]);
const FALSE_WORDS = new Set(["0", "false", "no", "off"]);

/** The version as numbers [2, 1, 309] from "2.1.309", "2.1.310 (Claude Code)", or the AI_AGENT of a session: "claude-code_2-1-309_agent". Null when it holds none. */
export function parseClaudeVersion(text) {
  if (typeof text !== "string") return null;
  const m = /^claude-code[_/](\d+)[-.](\d+)[-.](\d+)(?:[_/].*)?$/.exec(text.trim()) || /^v?(\d+)\.(\d+)\.(\d+)(?:\s.*)?$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** [a, b, c] >= [x, y, z] */
export function versionAtLeast(v, w) {
  for (let i = 0; i < 3; i++) if (v[i] !== w[i]) return v[i] > w[i];
  return true;
}

/**
 * The version of the Claude Code that runs this tool, when it is run inside Claude Code (its Bash tool, a skill's command line, an
 * MCP server): Claude Code sets AI_AGENT to claude-code_<version with dashes>_<kind> for the processes it starts (2.1.295, 2.1.303
 * and 2.1.310 were seen doing it). Run from a terminal there is no such variable and the version is not known.
 */
export function claudeVersionOf(env = {}) {
  const v = parseClaudeVersion(env.AI_AGENT);
  return v && /^claude-code[_/]/.test(String(env.AI_AGENT).trim()) ? { numbers: v, text: v.join("."), source: "AI_AGENT" } : null;
}

/** The host of a URL, never anything else of it (a URL can carry a name, a password, a key in its path). Null when it is not a URL. */
function hostOf(url) {
  try { return new URL(url).host || null; } catch { return null; }
}

const truthy = (value) => TRUE_WORDS.has(String(value).trim().toLowerCase());

/**
 * What Claude Code does with the schemas of MCP tools, from the environment it would run with (the process environment with the
 * `env` of the settings files layered on it).
 * Returns { mode, autoPercent, setting, betasOff, host, version, versionSource, refusable, reason }:
 *   mode      "deferred" (the request carries the names; a schema comes when the model loads the tool), "upfront" (the request
 *             carries every schema), "auto" (up front until the MCP tools pass autoPercent percent of the context window) or
 *             "depends" (a host other than Anthropic's with the setting unset: from 2.1.304 deferred, before that up front, and
 *             the version is not known)
 *   setting   ENABLE_TOOL_SEARCH as written, or null when it is not set or empty
 *   host      the host of ANTHROPIC_BASE_URL when it is not api.anthropic.com, else null
 *   refusable true when deferral is tried on a host that is not Anthropic's: an endpoint that refuses it gets the schemas up front
 */
export function toolSearchOf(env = {}) {
  const asWritten = typeof env.ENABLE_TOOL_SEARCH === "string" ? env.ENABLE_TOOL_SEARCH : "";
  const raw = asWritten.trim();
  const word = raw.toLowerCase();
  // Claude Code reads the words in any case and with spaces around them (put to 2.1.310 and 2.1.303), but takes auto and auto:N
  // exactly as written: Auto, AUTO:20 and " auto" are just text, which switches tool search on
  const isAuto = asWritten === "auto" || asWritten.startsWith("auto:");
  const tail = isAuto && asWritten !== "auto" ? asWritten.slice(5).trim() : null;
  const tailNumber = tail !== null && NUMBER.test(tail) ? Number(tail) : null;
  // the value is shown when it is one Claude Code knows; any other text is only said to be there (it could be anything)
  const setting = raw === "" ? null : isAuto ? (tail === null ? "auto" : tailNumber !== null ? `auto:${tail}` : `auto:${OTHER_VALUE}`) : WORDS.test(raw) ? raw : OTHER_VALUE;
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL.trim() : "";
  const baseHost = baseUrl === "" ? null : hostOf(baseUrl);
  const host = baseUrl !== "" && baseHost !== "api.anthropic.com" ? baseHost || "(not a URL)" : null;
  const version = claudeVersionOf(env);
  const betasOff = env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS !== undefined && truthy(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
  const out = { mode: "deferred", autoPercent: null, setting, betasOff, host, version: version ? version.text : null, versionSource: version ? version.source : null, refusable: false, reason: "" };
  const done = (mode, reason, extra = {}) => Object.assign(out, { mode, reason }, extra);

  if (betasOff) return done("upfront", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is set: Claude Code sends no tool search, whatever ENABLE_TOOL_SEARCH says");
  if (!isAuto && FALSE_WORDS.has(word)) return done("upfront", `ENABLE_TOOL_SEARCH=${setting} switches tool search off`);
  if (isAuto) {
    const n = tailNumber;
    if (n !== null && n >= 100) return done("upfront", `ENABLE_TOOL_SEARCH=${setting} never defers: the threshold is the whole context window`);
    if (n !== null && n <= 0) return done("deferred", `ENABLE_TOOL_SEARCH=${setting} always defers`, { refusable: host !== null });
    const percent = n === null ? 10 : n;
    return done("auto", `ENABLE_TOOL_SEARCH=${setting}: the schemas are in the request until the MCP tools pass ${percent}% of the context window${tail !== null && n === null ? " (the value after auto: is not a number, so Claude Code uses 10)" : ""}`, { autoPercent: percent });
  }
  if (setting !== null) return done("deferred", setting === OTHER_VALUE ? "ENABLE_TOOL_SEARCH is set to text that is none of Claude Code's words, and any such text switches tool search on" : `ENABLE_TOOL_SEARCH=${setting} switches tool search on`, { refusable: host !== null });

  // not set: Claude Code's default
  if (host === null) return done("deferred", "ENABLE_TOOL_SEARCH is not set: Claude Code defers MCP tools by default");
  if (version) {
    if (versionAtLeast(version.numbers, DEFERS_ON_EVERY_HOST_FROM.split(".").map(Number))) return done("deferred", `ENABLE_TOOL_SEARCH is not set: Claude Code ${version.text} defers MCP tools by default, also for ANTHROPIC_BASE_URL host ${host}`, { refusable: true });
    return done("upfront", `ENABLE_TOOL_SEARCH is not set and ANTHROPIC_BASE_URL names ${host}: Claude Code ${version.text} defers only on Anthropic's own host (${DEFERS_ON_EVERY_HOST_FROM} and newer defer on every host)`);
  }
  return done("depends", `ENABLE_TOOL_SEARCH is not set and ANTHROPIC_BASE_URL names ${host}: Claude Code ${DEFERS_ON_EVERY_HOST_FROM} and newer defer MCP tools on every host, older ones only on Anthropic's own host, and the version is not known here (Claude Code puts it in AI_AGENT for what it starts)`, { refusable: true });
}

/** A short statement of the mode for `show`. */
export function toolSearchSentence(ts) {
  if (ts.mode === "deferred") return `tool search is on: the request carries the names of MCP tools, and a schema once the model loads that tool (${ts.reason})`;
  if (ts.mode === "upfront") return `tool search is off: the request carries every MCP tool schema (${ts.reason})`;
  if (ts.mode === "auto") return `tool search is automatic: ${ts.reason}`;
  return `tool search may be on or off: ${ts.reason}`;
}

/** The part of `toolSearchOf` that goes in a JSON document. */
export const toolSearchJson = (ts) => ({ mode: ts.mode, autoPercent: ts.autoPercent, setting: ts.setting, betasOff: ts.betasOff, host: ts.host, version: ts.version, versionSource: ts.versionSource, refusable: ts.refusable, reason: ts.reason });
