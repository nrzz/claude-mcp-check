// Starts a stdio MCP server the way Claude Code would (the command, arguments, environment and working folder of
// launchSpec), performs the MCP handshake over its stdin and stdout, lists what it offers, and ends it. This is the one
// place that starts a program. Every child it starts is ended before probeStdio returns (stdin closed, then the process
// tree ended if it is still there 300 ms later, as Claude Code does on Windows), and a process that exits early ends the
// children that are left.
//
// The protocol is JSON-RPC 2.0, one message per line (the MCP specification, "stdio"): initialize, the initialized
// notification, then tools/list, resources/list and prompts/list for what the server says it offers.
import { spawn, spawnSync } from "node:child_process";
import { cmdLine } from "./launch.mjs";
import { envLookup } from "./expand.mjs";
import { initializeParams } from "./protocol.mjs";

const MAX_LINE = 8 * 1024 * 1024;
const MAX_PAGES = 20;
const live = new Set();
let hooked = false;

function killTreeSync(child) {
  if (!child || child.pid === undefined) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  } catch { /* already gone */ }
}

/** Ends every child that is still running. Runs when the process exits or is interrupted. */
export function killAll() {
  for (const child of [...live]) { killTreeSync(child); live.delete(child); }
}

function hook() {
  if (hooked) return;
  hooked = true;
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { killAll(); process.exit(sig === "SIGINT" ? 130 : 143); });
}

const stringEnv = (env) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));

function startChild(spec) {
  const { resolved, command, args, cwd } = spec;
  const env = stringEnv(spec.env);
  const common = { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
  if (resolved.found && resolved.via === "cmd") {
    // a .cmd or .bat file starts through cmd.exe, as Claude Code starts one
    const comspec = envLookup(env, "ComSpec", "win32") || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", `"${cmdLine(resolved.path, args)}"`], { ...common, windowsVerbatimArguments: true });
  }
  return spawn(resolved.found ? resolved.path : command, args, { ...common, detached: process.platform !== "win32" });
}


/**
 * Starts the server of `spec` (see launchSpec), asks it, and ends it.
 *   timeoutMs   how long the server has to answer initialize; every other request has at most 10 seconds
 * Returns { started, pid, spawnError, exit, initialize, timedOut, tools, resources, prompts, other, stderr, killed, ms } where
 *   initialize  { ok, ms, protocolVersion, serverInfo, capabilities, instructions } or { ok: false, error }; ms counts from the start of the process
 *   exit        { code, signal, ms } when the process ended by itself before this function ended it
 *   tools, resources, prompts   { ok, items } or { ok: false, error | timeout }, or null when the server does not offer them
 *   other       { lines, samples }: what the server wrote to stdout that is not a JSON-RPC message
 *   stderr      the end of what it wrote to stderr (at most 2,000 characters)
 */
export async function probeStdio(spec, { timeoutMs = 30000 } = {}) {
  hook();
  const res = { started: false, pid: null, spawnError: null, exit: null, initialize: null, timedOut: false, tools: null, resources: null, prompts: null, other: { lines: 0, samples: [] }, stderr: "", killed: false, ms: 0 };
  const t0 = Date.now();
  if (!spec.resolved.found) {
    res.spawnError = { code: spec.resolved.reason === "not-executable" ? "EACCES" : "ENOENT", message: spec.resolved.reason === "not-executable" ? "the file is not executable" : "the command was not found" };
    return res;
  }
  let child;
  try { child = startChild(spec); } catch (e) { res.spawnError = { code: e.code || "ERR", message: String(e.message || e).slice(0, 200) }; res.ms = Date.now() - t0; return res; }
  live.add(child);
  res.pid = child.pid === undefined ? null : child.pid;

  let exited = false;
  const exitWaiters = [];
  const pending = new Map();
  let nextId = 0;
  let closedStdin = false;
  const settleAll = (value) => { for (const [id, p] of [...pending]) { pending.delete(id); p.resolve(value); } };

  child.on("error", (e) => { res.spawnError = res.spawnError || { code: e.code || "ERR", message: String(e.message || e).slice(0, 200) }; exited = true; settleAll({ closed: true }); for (const w of exitWaiters) w(); });
  child.on("spawn", () => { res.started = true; });
  child.on("exit", (code, signal) => {
    exited = true;
    if (!res.killed && !closedStdin) res.exit = { code, signal, ms: Date.now() - t0 };
    settleAll({ closed: true });
    for (const w of exitWaiters) w();
  });
  const waitExit = (ms) => new Promise((resolve) => {
    if (exited) return resolve(true);
    const timer = setTimeout(() => { exitWaiters.splice(exitWaiters.indexOf(done), 1); resolve(false); }, ms);
    const done = () => { clearTimeout(timer); resolve(true); };
    exitWaiters.push(done);
  });

  child.stdin.on("error", () => { /* the server closed its stdin: the exit event says why */ });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { res.stderr = (res.stderr + d).slice(-2000); });
  child.stderr.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("error", () => {});
  let buffered = "";
  const send = (message) => { try { if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); } catch { /* the exit event reports it */ } };
  const handleLine = (line) => {
    let m;
    try { m = JSON.parse(line); } catch { m = undefined; }
    if (m === undefined || m === null || typeof m !== "object" || Array.isArray(m) || m.jsonrpc !== "2.0") {
      res.other.lines++;
      if (res.other.samples.length < 3) res.other.samples.push(line.trim().slice(0, 160));
      return;
    }
    if (m.id !== undefined && m.method === undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.resolve(m); return; }
    if (m.method !== undefined && m.id !== undefined) send(m.method === "ping" ? { id: m.id, result: {} } : { id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  };
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, at).replace(/\r$/, "");
      buffered = buffered.slice(at + 1);
      if (line.trim()) handleLine(line);
    }
    if (buffered.length > MAX_LINE) buffered = "";
  });

  const request = (method, params, ms) => new Promise((resolve) => {
    if (exited) return resolve({ closed: true });
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, ms);
    pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
    send({ id, method, params });
  });

  const list = async (method, key) => {
    const items = [];
    let cursor;
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await request(method, cursor === undefined ? undefined : { cursor }, Math.min(timeoutMs, 10000));
      if (r.timeout) return { ok: false, timeout: true, items };
      if (r.closed) return { ok: false, closed: true, items };
      if (r.error) return { ok: false, error: { code: r.error.code, message: String(r.error.message || "").slice(0, 200) }, items };
      const part = r.result && Array.isArray(r.result[key]) ? r.result[key] : [];
      items.push(...part);
      cursor = r.result && typeof r.result.nextCursor === "string" && r.result.nextCursor !== "" ? r.result.nextCursor : undefined;
      if (cursor === undefined || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return { ok: true, items };
  };

  try {
    const init = await request("initialize", initializeParams(), timeoutMs);
    if (init.timeout) {
      res.timedOut = true;
    } else if (init.closed) {
      // the process ended before it answered; res.exit says how
    } else if (init.error) {
      res.initialize = { ok: false, ms: Date.now() - t0, error: { code: init.error.code, message: String(init.error.message || "").slice(0, 200) } };
    } else {
      const r = init.result && typeof init.result === "object" ? init.result : {};
      const caps = r.capabilities && typeof r.capabilities === "object" ? r.capabilities : {};
      res.initialize = {
        ok: true, ms: Date.now() - t0, protocolVersion: typeof r.protocolVersion === "string" ? r.protocolVersion : null,
        serverInfo: r.serverInfo && typeof r.serverInfo === "object" ? { name: String(r.serverInfo.name || ""), version: String(r.serverInfo.version || "") } : null,
        capabilities: Object.keys(caps), instructions: typeof r.instructions === "string" ? r.instructions : "",
      };
      send({ method: "notifications/initialized" });
      const wants = (key) => (r.capabilities === undefined ? key === "tools" : caps[key] !== undefined && caps[key] !== null);
      const [tools, resources, prompts] = await Promise.all([
        wants("tools") ? list("tools/list", "tools") : null,
        wants("resources") ? list("resources/list", "resources") : null,
        wants("prompts") ? list("prompts/list", "prompts") : null,
      ]);
      res.tools = tools;
      res.resources = resources;
      res.prompts = prompts;
    }
  } finally {
    // end the child: close its stdin, give it 300 ms, then end the process tree
    closedStdin = true;
    try { child.stdin.end(); } catch { /* closed */ }
    let gone = await waitExit(300);
    if (!gone) {
      res.killed = true;
      if (process.platform !== "win32") { try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } gone = await waitExit(400); }
      if (!gone) { killTreeSync(child); gone = await waitExit(2000); }
    }
    live.delete(child);
    for (const s of [child.stdout, child.stderr, child.stdin]) { try { s.destroy(); } catch { /* closed */ } }
    try { child.unref(); } catch { /* gone */ }
    res.ms = Date.now() - t0;
  }
  return res;
}
