// Starting a stdio server, the MCP handshake, and ending the process: against the fake server of test/fake-mcp-server.mjs.
import { SERVER, readLog, stillRunning, tmpDir, world } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { probeStdio } from "../src/stdio.mjs";
import { launchSpec } from "../src/launch.mjs";
import { loadContext } from "../src/context.mjs";
import { buildModel } from "../src/state.mjs";
import { BIG_TOOL, INSTRUCTIONS, PROMPTS, RESOURCES, TOOLS, toolsFor } from "./fake-mcp-server.mjs";

const NODE = process.execPath;

/** A spec for the fake server in a mode, started in a world. */
function specFor(mode, { env = {}, args = [], world: w = world("stdio") } = {}) {
  const log = path.join(w.base, "fmcp.jsonl");
  w.claudeJson({ mcpServers: { x: { command: NODE, args: [SERVER, "serve", mode, ...args], env: { FMCP_LOG: log, ...env } } } });
  const ctx = loadContext({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, mcpJsonRoot: w.base });
  const def = buildModel(ctx).servers[0].def;
  return { spec: launchSpec(def, ctx), log, w };
}
const probe = async (mode, opts = {}, timeoutMs = 5000) => { const s = specFor(mode, opts); return { ...s, r: await probeStdio(s.spec, { timeoutMs }) }; };

test("a server that answers: the handshake, the time, what it offers", async () => {
  const { r, log } = await probe("ok");
  assert.equal(r.started, true);
  assert.equal(r.initialize.ok, true);
  assert.equal(r.initialize.protocolVersion, "2025-11-25");
  assert.deepEqual(r.initialize.serverInfo, { name: "fake-mcp", version: "1.2.3" });
  assert.deepEqual(r.initialize.capabilities.sort(), ["prompts", "resources", "tools"]);
  assert.equal(r.initialize.instructions, INSTRUCTIONS);
  assert.ok(r.initialize.ms > 0 && r.initialize.ms < 5000);
  assert.deepEqual(r.tools.items.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.deepEqual(r.resources.items, RESOURCES);
  assert.deepEqual(r.prompts.items, PROMPTS);
  assert.equal(r.timedOut, false);
  assert.equal(r.exit, null);
  // what the server was sent: initialize with a client that offers nothing, then the notification, then the three lists
  const messages = readLog(log).filter((e) => e.event === "message").map((e) => e.message);
  assert.equal(messages[0].method, "initialize");
  assert.deepEqual(messages[0].params.capabilities, {});
  assert.equal(messages[0].params.clientInfo.name, "claude-mcp-check");
  assert.equal(messages[1].method, "notifications/initialized");
  assert.deepEqual(messages.slice(2).map((m) => m.method).sort(), ["prompts/list", "resources/list", "tools/list"]);
});

test("every process is gone when the probe returns: stdin is closed and the server leaves by itself", async () => {
  const { r, log } = await probe("ok");
  const pids = [...new Set(readLog(log).map((e) => e.pid))];
  assert.equal(pids.length, 1);
  assert.deepEqual(await stillRunning([pids[0]]), []);
  assert.equal(r.killed, false, "it left when stdin closed: nothing had to be ended");
  assert.ok(readLog(log).some((e) => e.event === "stdin-closed"));
});

test("a server that does not leave when stdin closes is ended, with its children", async () => {
  const { r, log } = await probe("stubborn", {}, 800);
  assert.equal(r.timedOut, true);
  assert.equal(r.killed, true);
  const events = readLog(log);
  const pid = events.find((e) => e.event === "start").pid;
  const child = events.find((e) => e.event === "child").childPid;
  assert.deepEqual(await stillRunning([pid]), [], "the server is gone");
  assert.deepEqual(await stillRunning([child]), [], "and so is the process it started");
});

test("a server that sleeps but leaves when stdin closes is not killed", async () => {
  const { r, log } = await probe("sleep", {}, 500);
  assert.equal(r.timedOut, true);
  assert.deepEqual(await stillRunning([readLog(log).find((e) => e.event === "start").pid]), []);
});

test("pages are followed, and a server that offers tools only is not asked for the rest", async () => {
  const paged = await probe("paged");
  assert.deepEqual(paged.r.tools.items.map((t) => t.name), TOOLS.map((t) => t.name));
  const only = await probe("tools-only");
  assert.equal(only.r.tools.ok, true);
  assert.equal(only.r.resources, null);
  assert.equal(only.r.prompts, null);
  const methods = readLog(only.log).filter((e) => e.event === "message").map((e) => e.message.method);
  assert.ok(!methods.includes("resources/list") && !methods.includes("prompts/list"));
});

test("a banner before the handshake is noticed and does not stop it", async () => {
  const { r } = await probe("banner");
  assert.equal(r.initialize.ok, true);
  assert.equal(r.other.lines, 1);
  assert.deepEqual(r.other.samples, ["fake-mcp 1.2.3 starting up"]);
});

test("a server that prints garbage and never answers: a timeout, with what it printed", async () => {
  const { r } = await probe("garbage", {}, 700);
  assert.equal(r.timedOut, true);
  assert.equal(r.initialize, null);
  assert.equal(r.other.lines, 2);
  assert.match(r.other.samples[0], /Listening on/);
  assert.ok(r.ms >= 700);
});

test("a server that exits before the handshake: its exit code and the end of its stderr", async () => {
  const { r } = await probe("early-exit", { env: { FMCP_EXIT: "7" } });
  assert.equal(r.initialize, null);
  assert.equal(r.timedOut, false);
  assert.equal(r.exit.code, 7);
  assert.ok(r.exit.ms < 3000);
  assert.match(r.stderr, /the API_KEY variable is not set/);
});

test("a server that answers initialize with an error, and one that never answers", async () => {
  const bad = await probe("init-error");
  assert.equal(bad.r.initialize.ok, false);
  assert.deepEqual(bad.r.initialize.error, { code: -32603, message: "cannot start: the database is down" });
  const silent = await probe("silent", {}, 500);
  assert.equal(silent.r.timedOut, true);
  assert.equal(silent.r.other.lines, 0);
});

test("a slow answer is timed", async () => {
  const { r } = await probe("slow", { env: { FMCP_DELAY_MS: "600" } }, 5000);
  assert.equal(r.initialize.ok, true);
  assert.ok(r.initialize.ms >= 600, `${r.initialize.ms} ms`);
});

test("a command that is not there is not started and says why", async () => {
  const w = world("stdio2");
  w.claudeJson({ mcpServers: { x: { command: "definitely-not-a-command-xyz", args: ["a"] } } });
  const ctx = loadContext({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, mcpJsonRoot: w.base });
  const spec = launchSpec(buildModel(ctx).servers[0].def, ctx);
  const r = await probeStdio(spec, { timeoutMs: 1000 });
  assert.equal(r.started, false);
  assert.equal(r.spawnError.code, "ENOENT");
});

test("the server gets the folder of the project and the environment of the spec", async () => {
  const { r, log, w } = await probe("ok", { env: { FMCP_ECHO: "CLAUDE_PROJECT_DIR,MY_VAR", MY_VAR: "mine" } });
  assert.equal(r.initialize.ok, true);
  const start = readLog(log).find((e) => e.event === "start");
  assert.equal(start.cwd, w.work);
  assert.deepEqual(start.echo, { CLAUDE_PROJECT_DIR: w.work, MY_VAR: "mine" });
});

test("a big tools list: more than a pipe holds in one go", async () => {
  const dir = tmpDir("cmc-big-");
  const script = path.join(dir, "many.mjs");
  fs.writeFileSync(script, `
    const tools = Array.from({ length: 400 }, (_, i) => ({ name: "t" + i, description: "d".repeat(2000), inputSchema: { type: "object", properties: {} } }));
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.id === undefined) continue;
      const result = m.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "many", version: "1" } } : { tools };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n"); } });
    process.stdin.on("end", () => process.exit(0));
  `);
  const w = world("stdio3");
  w.claudeJson({ mcpServers: { many: { command: NODE, args: [script] } } });
  const ctx = loadContext({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, mcpJsonRoot: w.base });
  const r = await probeStdio(launchSpec(buildModel(ctx).servers[0].def, ctx), { timeoutMs: 10000 });
  assert.equal(r.tools.items.length, 400);
});

test("the tools of the fake server are the sizes the tests rely on", () => {
  assert.equal(toolsFor("ok").length, 3);
  assert.equal(toolsFor("big").length, 4);
  assert.equal(BIG_TOOL.description.length, 6000);
  assert.equal(toolsFor("ok", { FMCP_ECHO: "A" }, ["node", "s", "serve", "ok", "x"], "/w").at(-1).name, "whoami");
});
