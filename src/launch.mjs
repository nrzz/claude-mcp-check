// How Claude Code turns a server definition into a process or a request, as far as the real binary showed it (README, "What
// was verified"): the ${VAR} expansion of every field, the split of a command string, the lookup of the command (the PATH of
// the server's own env counts; on Windows .cmd and .bat files start), the working folder, and the environment of the child.
// Nothing here starts a process or opens a connection; src/stdio.mjs and src/http.mjs do that.
import fs from "node:fs";
import path from "node:path";
import { envLookup, expandString } from "./expand.mjs";
import { toPosix } from "./paths.mjs";

/** The placeholders that a plugin's own servers can use; the binary writes the paths with slashes. */
export function extraFor(def, ctx) {
  if (!def.plugin) return {};
  return { CLAUDE_PLUGIN_ROOT: toPosix(def.plugin.root), CLAUDE_PLUGIN_DATA: toPosix(def.plugin.dataDir), CLAUDE_PROJECT_DIR: toPosix(ctx.project) };
}

/**
 * The definition with every ${VAR} expanded: { type, command, args, env, url, headers, refs }.
 * refs lists what the expansion met: missing (set nowhere, left as written), empty (set to an empty string), defaulted and
 * readAsEmpty (credential names in the url and the headers of a remote server), each as [{ name, field }].
 */
export function expandedView(def, ctx) {
  const entry = def.entry;
  const type = def.type;
  const extra = extraFor(def, ctx);
  const refs = { missing: [], empty: [], defaulted: [], readAsEmpty: [] };
  const run = (text, field, remote) => {
    const r = expandString(text, { env: ctx.expansionEnv, platform: ctx.platform, extra, remote });
    for (const k of Object.keys(refs)) for (const name of r[k]) refs[k].push({ name, field });
    return r.text;
  };
  const view = { type, command: undefined, args: [], env: {}, url: undefined, headers: {}, refs };
  if (type === "stdio") {
    view.command = typeof entry.command === "string" ? run(entry.command, "command", false) : undefined;
    view.args = Array.isArray(entry.args) ? entry.args.map((a, i) => (typeof a === "string" ? run(a, `args[${i}]`, false) : String(a))) : [];
    if (entry.env && typeof entry.env === "object") for (const [k, v] of Object.entries(entry.env)) view.env[k] = typeof v === "string" ? run(v, `env.${k}`, false) : String(v);
  } else if (type) {
    view.url = typeof entry.url === "string" ? run(entry.url, "url", true) : undefined;
    if (entry.headers && typeof entry.headers === "object") for (const [k, v] of Object.entries(entry.headers)) view.headers[k] = typeof v === "string" ? run(v, `headers.${k}`, true) : String(v);
  }
  return view;
}

/** What identifies the endpoint of a server, so that a plugin's server with the same endpoint as another counts as a duplicate. */
export function endpointOf(view) {
  if (view.type === "stdio") return `cmd:${JSON.stringify([view.command, ...view.args])}`;
  if (!view.url) return null;
  try {
    const u = new URL(view.url);
    const dflt = { "http:": "80", "https:": "443", "ws:": "80", "wss:": "443" }[u.protocol];
    const port = u.port && u.port !== dflt ? `:${u.port}` : "";
    return `url:${u.protocol}//${u.username}${u.password ? `:${u.password}` : ""}${u.username ? "@" : ""}${u.hostname.toLowerCase()}${port}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch { return `url:${view.url}`; }
}

// ---------------------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------------------

const EXEC_EXT = [".com", ".exe", ".bat", ".cmd"];
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function canExecute(p, platform) {
  if (platform === "win32") return true;
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function pathEntries(env, platform) {
  const raw = envLookup(env, "PATH", platform);
  if (!raw) return [];
  return raw.split(platform === "win32" ? ";" : ":").map((d) => d.replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

function extensions(env, platform) {
  if (platform !== "win32") return [""];
  const fromEnv = (envLookup(env, "PATHEXT", platform) || "").split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...EXEC_EXT, ...fromEnv])];
}

/** The files a name can stand for in one folder: itself when it has an executable extension on Windows, and with each extension. */
function candidatesIn(dir, name, env, platform) {
  const base = path.join(dir, name);
  if (platform !== "win32") return [base];
  const exts = extensions(env, platform);
  const own = path.extname(name).toLowerCase();
  const out = [];
  if (own && exts.includes(own)) out.push(base);
  for (const e of exts) out.push(base + e);
  return out;
}

/**
 * Looks a command up the way the binary did: a name with a folder part is taken from the project folder (or as it is when it
 * is absolute), a plain name is searched for in the PATH of the server's env; on Windows with the extensions .com .exe .bat .cmd.
 * A leading "./" or ".\" that finds nothing falls back to a PATH search of the rest (Claude Code started "./node.exe" with no
 * such file in the project; "sub/node.exe" and "../node.exe" did not start).
 * Returns { found, path, via, reason, searched }: via is "direct" or, for a .cmd or .bat file on Windows, "cmd".
 */
export function resolveCommand(command, { env, cwd, platform = process.platform }) {
  const out = { found: false, path: null, via: "direct", reason: null, searched: [] };
  if (typeof command !== "string" || command === "") { out.reason = "empty"; return out; }
  const hasFolder = platform === "win32" ? /[\\/]/.test(command) : command.includes("/");
  const test = (p) => {
    if (!isFile(p)) return false;
    if (!canExecute(p, platform)) { out.reason = "not-executable"; out.path = p; return false; }
    return true;
  };
  const done = (p) => {
    out.found = true;
    out.path = p;
    out.reason = null;
    out.via = platform === "win32" && /\.(cmd|bat)$/i.test(p) ? "cmd" : "direct";
    return out;
  };
  const searchPath = (name) => {
    for (const dir of pathEntries(env, platform)) {
      out.searched.push(dir);
      for (const c of candidatesIn(dir, name, env, platform)) if (test(c)) return c;
    }
    return null;
  };
  if (hasFolder) {
    const abs = path.resolve(cwd, command);
    const dir = path.dirname(abs);
    out.searched.push(dir);
    for (const c of candidatesIn(dir, path.basename(abs), env, platform)) if (test(c)) return done(c);
    if (/^\.[\\/]/.test(command)) { const hit = searchPath(command.slice(2)); if (hit) return done(hit); }
    out.reason = out.reason || "not-found";
    return out;
  }
  const hit = searchPath(command);
  if (hit) return done(hit);
  out.reason = out.reason || "not-found";
  return out;
}

/** What claude mcp list says for a command that is not there: ENOENT on Linux and macOS, CONNECTION_CLOSED on Windows (2.1.295 to 2.1.301). */
export const notFoundWords = (platform = process.platform) => (platform === "win32" ? "CONNECTION_CLOSED: Connection closed" : "ENOENT");

/**
 * A command string split into words the way the binary did on Windows (2.1.295 and 2.1.299): on spaces and tabs, double quotes
 * group (and are removed), single quotes and backslashes do nothing special, nothing is run by a shell. A string that is a file
 * as a whole (a path with a space in it) stays whole. The first word is the command, the others go in front of `args`.
 * On Linux and macOS the binary split nothing (2.1.295, 2.1.299 and 2.1.301 alike): the whole string was the name of the
 * program, and a string with a space in it that is not a file failed with ENOENT. So there it is one word.
 */
export function splitCommand(command, opts = {}) {
  if ((opts.platform || process.platform) !== "win32") return [command];
  if (!/[ \t]/.test(command)) return [command];
  if (resolveCommand(command, opts).found) return [command];
  const words = [];
  let cur = "";
  let started = false;
  let quoted = false;
  for (const ch of command) {
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && (ch === " " || ch === "\t")) { if (started) { words.push(cur); cur = ""; started = false; } continue; }
    cur += ch;
    started = true;
  }
  if (started) words.push(cur);
  if (/^[ \t]/.test(command)) words.unshift("");
  return words;
}

/** The arguments written for cmd.exe: every one in double quotes, with the usual rules for quotes and trailing backslashes. */
export function cmdLine(file, args) {
  const q = (a) => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  return [file, ...args].map(q).join(" ");
}

/**
 * Everything needed to start a stdio server the way Claude Code would, and nothing started:
 *   words      the command string split in words
 *   command    the program, args the arguments (the rest of the words first)
 *   env        the environment of the child: the process environment with the env of the settings files, CLAUDE_PROJECT_DIR and the
 *              server's own env on top (the binary resolved the command with this PATH)
 *   cwd        the project folder
 *   resolved   see resolveCommand
 */
export function launchSpec(def, ctx, view = expandedView(def, ctx)) {
  const env = { ...ctx.childEnv, CLAUDE_PROJECT_DIR: ctx.project, ...view.env };
  const cwd = ctx.project;
  const opts = { env, cwd, platform: ctx.platform };
  const words = splitCommand(view.command || "", opts);
  const command = words[0] === undefined ? "" : words[0];
  const args = [...words.slice(1), ...view.args];
  const resolved = resolveCommand(command, opts);
  return { type: "stdio", words, command, args, env, cwd, resolved, view };
}
