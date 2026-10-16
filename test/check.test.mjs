// check and why against the fake server, in this process: which servers are started, what is reported, the causes.
import { SERVER, fake, readLog, run, stillRunning, world } from "./helpers.mjs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { timeoutFrom } from "../src/check.mjs";
import { INSTRUCTIONS, TOOLS } from "./fake-mcp-server.mjs";

const NODE = process.execPath;
const withLog = (w, mode, { args = [], env = {} } = {}) => ({ command: NODE, args: [SERVER, "serve", mode, ...args], env: { FMCP_LOG: path.join(w.base, "fmcp.jsonl"), ...env } });
const logOf = (w) => readLog(path.join(w.base, "fmcp.jsonl"));

test("the timeout: --timeout, else MCP_TIMEOUT, else 30 seconds", () => {
  assert.deepEqual(timeoutFrom({ timeout: 500, env: {} }), { ms: 500, source: "--timeout", mcpTimeout: null });
  assert.deepEqual(timeoutFrom({ timeout: 500, env: { MCP_TIMEOUT: "9000" } }), { ms: 500, source: "--timeout", mcpTimeout: 9000 });
  assert.deepEqual(timeoutFrom({ env: { MCP_TIMEOUT: "9000" } }), { ms: 9000, source: "MCP_TIMEOUT", mcpTimeout: 9000 });
  assert.deepEqual(timeoutFrom({ env: {} }), { ms: 30000, source: "default", mcpTimeout: null });
  assert.deepEqual(timeoutFrom({ env: { MCP_TIMEOUT: "soon" } }), { ms: 30000, source: "default", mcpTimeout: null });
});

test("check starts the servers of the project, lists what they offer and sizes the tools", async () => {
  const w = world("c1");
  w.claudeJson({ mcpServers: { good: withLog(w, "ok"), toolsonly: withLog(w, "tools-only") } });
  const r = await run(["check", "--json", "--timeout", "5000"], w);
  assert.equal(r.code, 0, r.out + r.err);
  const doc = r.json();
  assert.equal(doc.totals.servers, 2);
  assert.equal(doc.totals.answered, 2);
  assert.equal(doc.totals.failed, 0);
  const good = doc.servers.find((s) => s.name === "good");
  assert.deepEqual(good.counts, { tools: 3, resources: 2, prompts: 1 });
  assert.deepEqual(good.tools.names, TOOLS.map((t) => t.name));
  assert.equal(good.cost.instructionsChars, INSTRUCTIONS.length);
  assert.equal(good.cost.toolSchemaChars, good.cost.perTool.reduce((n, t) => n + t.chars, 0));
  assert.equal(good.initialize.protocolVersion, "2025-11-25");
  assert.deepEqual(doc.servers.find((s) => s.name === "toolsonly").counts, { tools: 3, resources: null, prompts: null });
  assert.equal(doc.totals.tools, 6);
  assert.match(doc.note, /characters \/ 4, an estimate/);
});

test("check ends every server it starts", async () => {
  const w = world("c2");
  w.claudeJson({ mcpServers: { a: withLog(w, "ok"), b: withLog(w, "sleep"), c: withLog(w, "stubborn"), d: withLog(w, "garbage") } });
  const r = await run(["check", "--timeout", "600"], w);
  assert.equal(r.code, 1, "sleepers and garbage do not answer");
  const events = logOf(w);
  const pids = [...new Set(events.map((e) => e.pid))];
  assert.equal(pids.length, 4);
  assert.deepEqual(await stillRunning(pids), []);
  assert.deepEqual(await stillRunning(events.filter((x) => x.event === "child").map((e) => e.childPid)), []);
});

test("check [name] checks that server only, and says so when there is none", async () => {
  const w = world("c3");
  w.claudeJson({ mcpServers: { a: withLog(w, "ok", { args: ["a"] }), b: withLog(w, "ok", { args: ["b"] }) } });
  const r = await run(["check", "b", "--json", "--timeout", "5000"], w);
  assert.deepEqual(r.json().servers.map((s) => s.name), ["b"]);
  assert.equal(logOf(w).filter((e) => e.event === "start").length, 1);
  const none = await run(["check", "zzz"], w);
  assert.equal(none.code, 1);
  assert.match(none.err, /no server called "zzz"/);
});

test("check does not start what Claude Code would not: unapproved, rejected, switched off, blocked, invalid", async () => {
  const w = world("c4");
  w.claudeJson({ mcpServers: { off: withLog(w, "ok"), denied: withLog(w, "ok"), bad: { args: ["x"] } } }, { disabledMcpServers: ["off"] });
  w.mcpJson({ mcpServers: { pending: withLog(w, "ok"), rejected: withLog(w, "ok") } });
  w.local({ disabledMcpjsonServers: ["rejected"] });
  w.user({ deniedMcpServers: [{ serverName: "denied" }] });
  const r = await run(["check", "--json", "--timeout", "3000"], w);
  assert.equal(r.code, 0, "nothing that was started failed");
  const doc = r.json();
  assert.equal(doc.totals.started, 0);
  assert.equal(doc.totals.skipped, 5);
  assert.equal(logOf(w).length, 0, "no process was started");
  const reason = Object.fromEntries(doc.servers.map((s) => [s.name, s.skipped]));
  assert.match(reason.pending, /not approved/);
  assert.match(reason.rejected, /disabledMcpjsonServers/);
  assert.match(reason.off, /switched off/);
  assert.match(reason.denied, /blocked/);
  assert.match(reason.bad, /invalid/);
  // --include-unapproved starts the pending one, and only that
  const forced = await run(["check", "--json", "--timeout", "3000", "--include-unapproved"], w);
  assert.equal(forced.json().totals.started, 1);
  assert.equal(forced.json().servers.find((s) => s.name === "pending").ok, true);
});

test("the text report: the lines for a server that answers and one that does not", async () => {
  const w = world("c5");
  w.claudeJson({ mcpServers: { good: withLog(w, "ok"), early: withLog(w, "early-exit"), missing: { command: "definitely-not-a-command-xyz" } } });
  const r = await run(["check", "--timeout", "3000"], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /good {2}\(user, stdio\)/);
  assert.match(r.out, /answered initialize in \d+ ms \(MCP 2025-11-25, fake-mcp 1\.2\.3\)/);
  assert.match(r.out, /3 tools, 2 resources, 1 prompt/);
  assert.match(r.out, /tool schemas: [\d,]+ characters, about [\d,]+ tokens \(characters \/ 4, an estimate\)/);
  assert.match(r.out, /exited with code 3 after \d+ ms, before answering initialize/);
  assert.match(r.out, /not started: the command was not found/);
  assert.match(r.out, /3 servers started, 1 answered, 2 failed, 0 not started\./);
  assert.match(r.out, /tool search/);
});

test("the timeout comes from MCP_TIMEOUT when --timeout is not given, and the report says where it came from", async () => {
  const w = world("c6");
  w.claudeJson({ mcpServers: { s: withLog(w, "sleep") } });
  const t0 = Date.now();
  const r = await run(["check"], w, { env: { MCP_TIMEOUT: "700" } });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.code, 1);
  assert.match(r.out, /timeout {3}700 ms \(from MCP_TIMEOUT\)/);
  assert.match(r.out, /no answer to initialize within 700 ms/);
});

// ---- why --------------------------------------------------------------------------------------------------------------------

const why = async (w, name, extra = []) => (await run(["why", name, "--json", "--timeout", "1500", ...extra], w)).json();

test("why names the cause for each way a stdio server fails", async () => {
  const w = world("y1");
  w.claudeJson({ mcpServers: {
    early: withLog(w, "early-exit"), garbage: withLog(w, "garbage"), sleepy: withLog(w, "sleep"), initerr: withLog(w, "init-error"), good: withLog(w, "ok"),
    missing: { command: "definitely-not-a-command-xyz", args: ["x"] }, needsvar: { ...withLog(w, "early-exit"), args: [SERVER, "serve", "early-exit", "--key=${NOT_SET_ANYWHERE}"] },
    emptyvar: { ...withLog(w, "early-exit"), args: [SERVER, "serve", "early-exit", "--key=${EMPTY_VAR}"] },
  } });
  const env = { EMPTY_VAR: "" };
  const causes = {};
  for (const n of ["early", "garbage", "sleepy", "initerr", "good", "missing", "needsvar", "emptyvar"]) causes[n] = (await run(["why", n, "--json", "--timeout", "1500"], w, { env })).json();
  assert.deepEqual(Object.fromEntries(Object.entries(causes).map(([n, c]) => [n, c.cause])), { early: "early-exit", garbage: "non-json-stdout", sleepy: "timeout", initerr: "handshake-error", good: "ok", missing: "command-not-found", needsvar: "variable-unset", emptyvar: "variable-empty" });
  assert.equal(causes.good.ok, true);
  assert.match(causes.early.summary, /code 3/);
  assert.ok(causes.early.details.some((d) => /API_KEY variable is not set/.test(d)), "the end of stderr");
  assert.match(causes.sleepy.details.join("\n"), /MCP_TIMEOUT is not set/);
  assert.match(causes.garbage.details.join("\n"), /Listening on http:\/\/localhost:3000/);
  assert.match(causes.initerr.summary, /-32603: cannot start: the database is down/);
  assert.match(causes.needsvar.fix, /NOT_SET_ANYWHERE/);
  assert.match(causes.needsvar.details.join("\n"), /env of a project or local settings file/);
});

test("why says what MCP_TIMEOUT is set to when a server does not answer in time", async () => {
  const w = world("y2");
  w.claudeJson({ mcpServers: { s: withLog(w, "sleep") } });
  const d = (await run(["why", "s", "--json"], w, { env: { MCP_TIMEOUT: "600" } })).json();
  assert.equal(d.cause, "timeout");
  assert.match(d.summary, /within 600 ms/);
  assert.match(d.details.join("\n"), /MCP_TIMEOUT is set to 600 ms/);
});

test("why for a server that is not started: not approved, switched off, rejected, blocked, invalid, a duplicate, and no such name", async () => {
  const w = world("y3");
  w.claudeJson({ mcpServers: { off: withLog(w, "ok"), denied: withLog(w, "ok"), bad: { args: ["x"] } } }, { disabledMcpServers: ["off"] });
  w.mcpJson({ mcpServers: { pending: withLog(w, "ok"), rejected: withLog(w, "ok") } });
  w.local({ disabledMcpjsonServers: ["rejected"] });
  w.user({ deniedMcpServers: [{ serverName: "denied" }] });
  const c = Object.fromEntries(await Promise.all(["pending", "rejected", "off", "denied", "bad", "nope"].map(async (n) => [n, await why(w, n)])));
  assert.equal(c.pending.cause, "not-approved");
  assert.match(c.pending.fix, /toggle pending --on/);
  assert.equal(c.rejected.cause, "disabled");
  assert.match(c.rejected.summary, /disabledMcpjsonServers/);
  assert.equal(c.off.cause, "disabled");
  assert.match(c.off.summary, /switched off for this project/);
  assert.equal(c.denied.cause, "blocked-by-policy");
  assert.equal(c.bad.cause, "invalid-config");
  assert.equal(c.nope.cause, "not-found");
  assert.equal(c.nope.found, false);
  assert.equal(logOf(w).length, 0, "none of them was started");
  assert.equal((await run(["why", "pending"], w)).code, 1);
});

test("why warns when the server answers but something is off: a banner, an unset variable, a name defined twice", async () => {
  const w = world("y4");
  w.claudeJson({ mcpServers: { banner: { ...withLog(w, "banner"), args: [SERVER, "serve", "banner", "--x=${NOT_SET}"] }, dup: withLog(w, "ok", { args: ["user"] }) } }, { mcpServers: { dup: withLog(w, "ok", { args: ["local"] }) } });
  const b = await why(w, "banner");
  assert.equal(b.ok, true);
  assert.ok(b.warnings.some((x) => /not JSON-RPC/.test(x)));
  assert.ok(b.warnings.some((x) => /NOT_SET/.test(x)));
  const d = await why(w, "dup");
  assert.equal(d.ok, true);
  assert.ok(d.warnings.some((x) => /also defined in user/.test(x)));
});

test("why for an HTTP server: a login is needed, nothing listens; and the headers are named, never their values", async () => {
  const w = world("y5");
  w.claudeJson({ mcpServers: { refused: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer top-secret-value" } } } });
  const d = await why(w, "refused");
  assert.equal(d.cause, "unreachable");
  assert.ok(!JSON.stringify(d).includes("top-secret-value"));
});

test("the text of why: cause, where it comes from, the command, the fix", async () => {
  const w = world("y6");
  w.claudeJson({ mcpServers: { early: withLog(w, "early-exit") } });
  const r = await run(["why", "early", "--timeout", "3000"], w);
  assert.equal(r.code, 1);
  assert.match(r.out, /why early/);
  assert.match(r.out, /early-exit/);
  assert.match(r.out, /from {6}user: ~\/\.claude\/\.claude\.json:\d+/);
  assert.match(r.out, /fix {7}Run the command in a terminal/);
});

test("check and why take --mcp-config: the servers of the file are started like the others, and win a name", async () => {
  const w = world("c9");
  w.claudeJson({ mcpServers: { shared: withLog(w, "early-exit"), fromuser: withLog(w, "ok") } });
  const file = w.write(path.join(w.base, "extra.json"), { mcpServers: { shared: withLog(w, "ok"), fromflag: withLog(w, "ok") } });
  const r = await run(["check", "--mcp-config", file, "--json", "--timeout", "5000"], w);
  assert.equal(r.code, 0, r.out + r.err);
  const by = Object.fromEntries(r.json().servers.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by).sort(), ["fromflag", "fromuser", "shared"]);
  assert.equal(by.fromflag.scope, "--mcp-config");
  assert.equal(by.shared.scope, "--mcp-config", "the file wins the name over the user's definition");
  assert.equal(by.shared.ok, true);
  const one = await run(["why", "fromflag", "--mcp-config", file, "--json", "--timeout", "5000"], w);
  assert.equal(one.json().cause, "ok");
  assert.equal(one.code, 0);
});
