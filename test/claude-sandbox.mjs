// Running the real claude binary at zero cost, for the checks that need it (test/e2e-claude.test.mjs).
//
// A check runs only when E2E_CLAUDE names a Claude Code binary ("claude" on a CI machine after
// `npm install -g @anthropic-ai/claude-code`, or the full path to claude.exe). Otherwise it is skipped, and
// `npm test` needs nothing but Node. The binary runs in a throwaway folder with its own config folder and home,
// with an environment scrubbed of every CLAUDE_* and ANTHROPIC_* variable of the machine, and with
// ANTHROPIC_BASE_URL pointing at a tiny server on 127.0.0.1 that answers from a script. No request leaves the machine,
// no token is spent, no login is needed. The binary is started with spawn (asynchronous) and with stdin ignored: a
// spawnSync would block the event loop that the fake server lives in, and `-p` waits for input on an open stdin.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpDir, fwd } from "./helpers.mjs";

export const CLAUDE = process.env.E2E_CLAUDE || "";
const IS_WIN = process.platform === "win32";
const USAGE = { input_tokens: 1, output_tokens: 1 };
const viaShell = () => IS_WIN && !/\.exe$/i.test(CLAUDE);

/** A scrubbed environment: none of the machine's CLAUDE_* and ANTHROPIC_* variables, no updates, no telemetry. */
export function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC|CLAUDECODE|AI_AGENT|MCP_|ENABLE_TOOL_SEARCH)/i.test(k)) env[k] = v;
  return { ...env, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_COLOR: "1", ...bashEnv(), ...extra };
}

/** { ok, version, reason }: whether E2E_CLAUDE names a binary that runs, and the version it prints. Asked once, when this file loads. */
function probeBinary() {
  if (!CLAUDE) return Promise.resolve({ ok: false, version: "", reason: "E2E_CLAUDE is not set (point it at a claude binary to run the checks against the real thing)" });
  const home = tmpDir("cmc-e2e-probe-");
  return new Promise((resolve) => {
    // like every other start of the binary: spawn (asynchronous), standard input ignored, a config folder of its own
    const child = spawn(CLAUDE, ["--version"], { windowsHide: true, shell: viaShell(), stdio: ["ignore", "pipe", "pipe"], env: baseEnv({ CLAUDE_CONFIG_DIR: path.join(home, ".claude"), HOME: home, USERPROFILE: home }) });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, version: "", reason: `E2E_CLAUDE (${CLAUDE}) did not run: ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = out.trim();
      resolve(code === 0 && version ? { ok: true, version, reason: "" } : { ok: false, version: "", reason: `E2E_CLAUDE (${CLAUDE}) did not run: ${err.trim().slice(0, 120)}` });
    });
  });
}
const info = await probeBinary();
export const claudeInfo = () => info;
/** The value for node:test's `skip` option: false when the binary is there, else the reason. */
export const skip = () => (claudeInfo().ok ? false : claudeInfo().reason);
/** The version as numbers [2, 1, 299], for the checks that differ between versions. */
export const versionNumbers = () => ((/(\d+)\.(\d+)\.(\d+)/.exec(claudeInfo().version) || [0, 0, 0, 0]).slice(1).map(Number));
export const atLeast = (a, b, c) => { const [x, y, z] = versionNumbers(); return x !== a ? x > a : y !== b ? y > b : z >= c; };

/** Git Bash on Windows, so the Bash tool exists; nothing on the other systems. */
function bashEnv() {
  if (!IS_WIN) return {};
  const candidates = [];
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  const where = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
  for (const line of (where.stdout || "").split(/\r?\n/).filter(Boolean)) candidates.push(path.join(path.dirname(line), "..", "bin", "bash.exe"));
  candidates.push("C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe");
  for (const c of candidates) if (c && fs.existsSync(c)) return { CLAUDE_CODE_USE_POWERSHELL_TOOL: "0", CLAUDE_CODE_GIT_BASH_PATH: path.resolve(c).replace(/\\/g, "/") };
  return {};
}

/**
 * A throwaway world for the binary: home, a config folder (CLAUDE_CONFIG_DIR; its .claude.json is the ~/.claude.json of the
 * world) and a project folder that Claude Code already trusts.
 *   cfg/settings.json                 the user's settings
 *   cfg/.claude.json                  user-scope and local-scope servers
 *   work/.mcp.json                    project-scope servers
 *   work/.claude/settings.json        the project's settings
 *   work/.claude/settings.local.json  the local settings
 */
export function sandbox(label, { trusted = true } = {}) {
  const root = tmpDir(`cmc-e2e-${label}-`);
  const home = path.join(root, "home");
  const cfg = path.join(root, "cfg");
  const work = path.join(root, "work");
  for (const d of [home, cfg, work]) fs.mkdirSync(d, { recursive: true });
  const trust = { hasTrustDialogAccepted: true, allowedTools: [] };
  const key = fwd(work);
  fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: trusted ? { [key]: trust } : {} }, null, 2));
  return {
    root, home, cfg, work, key,
    claudeJson: path.join(cfg, ".claude.json"),
    user: path.join(cfg, "settings.json"),
    project: path.join(work, ".claude", "settings.json"),
    local: path.join(work, ".claude", "settings.local.json"),
    mcpJson: path.join(work, ".mcp.json"),
    managed: path.join(root, "managed"),
    env: { CLAUDE_CONFIG_DIR: cfg, HOME: home, USERPROFILE: home, CLAUDE_MCP_CHECK_MANAGED_DIR: path.join(root, "managed") },
  };
}

/** Write a file: an object as JSON, a string as it is. */
export function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** Merges into the world's .claude.json: top-level keys, and keys of the project's entry. */
export function patchClaudeJson(sb, top = {}, project) {
  const j = JSON.parse(fs.readFileSync(sb.claudeJson, "utf8"));
  Object.assign(j, top);
  if (project) { j.projects = j.projects || {}; j.projects[sb.key] = { ...(j.projects[sb.key] || {}), ...project }; }
  put(sb.claudeJson, j);
  return j;
}

const msgStart = (id, model) => ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: model || "x", content: [], stop_reason: null, usage: USAGE } }];

/** SSE events for an assistant message with the given blocks: { text } or { tool, input, id }. */
export function message(id, model, blocks) {
  const ev = [msgStart(id, model)];
  blocks.forEach((b, i) => {
    if (b.text !== undefined) {
      ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } }]);
    } else {
      ev.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id || `toolu_${id}_${i}`, name: b.tool, input: {} } }]);
      ev.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }]);
    }
    ev.push(["content_block_stop", { type: "content_block_stop", index: i }]);
  });
  ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: blocks.some((b) => b.tool) ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }]);
  ev.push(["message_stop", { type: "message_stop" }]);
  return ev;
}

/** All the text the user side of a request holds (the prompt, expanded skills, tool results). */
export const userText = (j) => (j.messages || []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content || []).map((b) => b.text || "").join(""))).join("\n");
/** Every text block of a request's messages. */
export const textBlocks = (request) => (request.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content])).map((b) => (typeof b === "string" ? b : (b && b.text) || ""));

/**
 * The fake Messages API. Every request is recorded in `requests`, whole. A request is answered with the text
 * "PROBE-DONE", or, for the first request of the main conversation (its prompt holds PROBE-MAIN), with the one
 * tool call `call` when one is given. With `refuseDeferred` a request that carries deferred tools (a tool with
 * defer_loading) is answered with HTTP 400, as an endpoint that does not know tool search would answer it.
 */
export function fakeApi(call, { refuseDeferred = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!req.url.includes("/v1/messages")) { res.writeHead(404); res.end("{}"); return; }
      let j = {};
      try { j = JSON.parse(body); } catch { /* empty */ }
      requests.push(j);
      const n = requests.length;
      if (refuseDeferred && body.includes('"defer_loading"')) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "tools.13.defer_loading: Extra inputs are not permitted" } }));
        return;
      }
      if (j.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `msg_${n}`, type: "message", role: "assistant", model: j.model || "x", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: USAGE }));
        return;
      }
      const asked = (j.messages || []).some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"));
      const main = userText(j).includes("PROBE-MAIN");
      const events = main && call && !asked ? message(`msg_${n}`, j.model, [{ tool: call.tool, id: "toolu_probe", input: call.input }]) : message(`msg_${n}`, j.model, [{ text: "PROBE-DONE" }]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { server.unref(); resolve({ port: server.address().port, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) }); }));
}

function killTree(child) {
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}

/**
 * Run claude in the sandbox's project folder. Resolves { code, out, err, result, ms } (result: the --output-format json
 * document). `api` is the fake API the binary talks to; null for a command that needs none (claude mcp list).
 */
export function runClaude(sb, api, args, { timeout = 120000, env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const childEnv = baseEnv({ CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, USERPROFILE: sb.home, ...(api ? { ANTHROPIC_API_KEY: "sk-ant-probe", ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}` } : {}), ...env });
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const quoted = [CLAUDE, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
    const where = cwd || sb.work;
    const started = Date.now();
    const child = viaShell() ? spawn(quoted, [], { cwd: where, env: childEnv, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : spawn(CLAUDE, args, { cwd: where, env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: !IS_WIN });
    let out = "";
    let err = "";
    child.on("error", (e) => { err += String(e); });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => killTree(child), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(out); } catch { /* not json */ }
      resolve({ code, out, err, result, ms: Date.now() - started });
    });
  });
}

/** The tool names of a request, and the main request of a run (the one with PROBE-MAIN in its prompt). */
export const toolNames = (req) => (req && req.tools ? req.tools.map((t) => t.name) : []);
export const mainRequest = (api) => api.requests.find((r) => userText(r).includes("PROBE-MAIN")) || api.requests[0];
export const mcpTools = (req) => ((req && req.tools) || []).filter((t) => t.name.startsWith("mcp__"));

/** The servers `claude -p --output-format stream-json --verbose` announces in its init event: [{ name, status, source }]. */
export function initServers(r) {
  for (const line of r.out.split("\n")) {
    if (!line.startsWith("{")) continue;
    try { const e = JSON.parse(line); if (e.type === "system" && e.subtype === "init") return e.mcp_servers || []; } catch { /* not json */ }
  }
  return null;
}

/**
 * One `claude -p` run with the fake API: { api, r, request, init }. The api is closed.
 * ENABLE_TOOL_SEARCH is false unless the run says otherwise. From Claude Code 2.1.304 the fake API's host gets tool search by
 * default (older versions leave it off for a host that is not Anthropic's), and then the first request carries no MCP schema at
 * all; most checks read the schemas out of the request, so they ask for the shape that every version shares. The checks about
 * tool search itself pass their own value (or null, to leave the variable unset).
 */
export async function probeRun(sb, { prompt = "PROBE-MAIN hello", args = [], env = {}, api: given } = {}) {
  const api = given || (await fakeApi());
  try {
    const r = await runClaude(sb, api, ["-p", prompt, "--output-format", "stream-json", "--verbose", ...args], { env: { ENABLE_TOOL_SEARCH: "false", ...env, ...(env.ENABLE_TOOL_SEARCH === null ? { ENABLE_TOOL_SEARCH: undefined } : {}) } });
    return { api, r, request: mainRequest(api), init: initServers(r) };
  } finally { if (!given) await api.close(); }
}

/**
 * The names that the first request announces as deferred, in the message that begins "The following deferred tools are now
 * available via ToolSearch" (one name to a line, the built-in tools first and the MCP tools after them): [] when there is none.
 */
export function deferredNames(request) {
  for (const text of textBlocks(request)) {
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.includes("deferred tools are now available via ToolSearch"));
    if (at < 0) continue;
    const names = [];
    for (const l of lines.slice(at + 1)) { if (!/^[A-Za-z][A-Za-z0-9_:.-]*$/.test(l)) break; names.push(l); }
    return names;
  }
  return [];
}

/**
 * A run in which the model's first act is to call ToolSearch with `query`: { api, r, first, second }, the first request of the
 * conversation and the one that follows the tool's answer. The api is closed.
 */
export async function toolSearchRun(sb, query, { env = {}, args = [] } = {}) {
  const api = await fakeApi({ tool: "ToolSearch", input: { query, max_results: 10 } });
  try {
    const r = await runClaude(sb, api, ["-p", "PROBE-MAIN hello", "--output-format", "stream-json", "--verbose", ...args], { env: { ENABLE_TOOL_SEARCH: "true", ...env } });
    const main = api.requests.filter((j) => userText(j).includes("PROBE-MAIN"));
    return { api, r, first: main[0], second: main[1] };
  } finally { await api.close(); }
}

/**
 * What `claude mcp list` says: { servers: { name: status text }, warnings: [lines], raw }. A line is `name: <what> - <status>`; the
 * names that contain a colon (plugin:x:y) are handled by taking the text up to the first ": " after it.
 */
export function parseList(out) {
  const servers = {};
  const warnings = [];
  for (const line of out.split("\n")) {
    const m = /^([^\s:][^:]*(?::[^\s:]+)*): (.*) - (✔|✘|!|⏸|⊘|-) ?(.*)$/u.exec(line);
    if (m && !/^(MCP config|For help|Location|Checking)/.test(line)) servers[m[1]] = `${m[3]} ${m[4]}`.trim();
    else if (/\[(Warning|Error)\]|Missing environment|Conflicting scopes|Server ".*" is defined in multiple scopes/.test(line)) warnings.push(line.trim());
  }
  return { servers, warnings, raw: out };
}

/** The first word of a status that `claude mcp list` or `get` prints, as a state name: connected, failed, auth, pending, disabled, none. */
export function statusWord(status) {
  if (status === undefined) return "none";
  if (/Connected/.test(status)) return "connected";
  if (/Pending approval/.test(status)) return "pending";
  if (/Disabled for this project/.test(status)) return "disabled";
  if (/Rejected/.test(status)) return "rejected";
  if (/Needs authentication/.test(status)) return "auth";
  if (/Not configured/.test(status)) return "not-configured";
  if (/Failed|Connection error/.test(status)) return "failed";
  return status;
}

export const hasText = (v, text) => JSON.stringify(v).includes(text);
