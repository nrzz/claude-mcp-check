// Checks against the real Claude Code binary, run only when E2E_CLAUDE points at one (see claude-sandbox.mjs).
// They are the proof of what the README says Claude Code does with MCP servers:
//   a. where servers come from, which definition wins, what the model receives (the tools of the first request of a fake API),
//      what `claude mcp list` and `get` say, and that `show` says the same;
//   b. the approval of .mcp.json servers, the project's switch, the allow and deny lists;
//   c. ${VAR} expansion, the working folder, the environment and the command lookup of a server's process;
//   d. `check` and `why` against servers that answer, that print garbage, that exit, that sleep;
//   e. `toggle`, and that the binary honours what it wrote;
//   f. the plugin: it validates, /mcp-check:check hands the model the lint report and costs what the README says.
// Everything runs against a fake API on 127.0.0.1: no model is reached, no token is spent, nothing leaves the machine, and
// every run has its own throwaway HOME, USERPROFILE and CLAUDE_CONFIG_DIR.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ROOT, SERVER, commandLineOf, fake, fwd, readLog, stillRunning } from "./helpers.mjs";
import { CLAUDE, atLeast, baseEnv, claudeInfo, deferredNames, fakeApi, initServers, mainRequest, mcpTools, parseList, patchClaudeJson, probeRun, put, runClaude, sandbox, skip, statusWord, textBlocks, toolNames, toolSearchRun, userText, versionNumbers } from "./claude-sandbox.mjs";
import { main } from "../src/cli.mjs";
import { REMOTE_EMPTY, expandString, expansionEnv } from "../src/expand.mjs";
import { RESOURCE_TOOLS, measureTools } from "../src/measure.mjs";
import { claudeVersionOf } from "../src/toolsearch.mjs";
import { ROWS as VALIDATION_ROWS } from "./validation-table.mjs";
import { ROWS as LINT_ROWS } from "./lint-table.mjs";

const IS_WIN = process.platform === "win32";

// ---- the tool, run in this process against the world of a sandbox ---------------------------------------------------------
async function mine(sb, args, { env = {}, cwd } = {}) {
  let out = "";
  let err = "";
  const code = await main(args, {
    // the same environment that the binary is given (the managed folder is passed apart: it is a setting of the tool, not of Claude Code)
    cwd: cwd || sb.work, env: baseEnv({ CLAUDE_CONFIG_DIR: sb.cfg, HOME: sb.home, USERPROFILE: sb.home, ...env }), home: sb.home, managed: path.join(sb.root, "managed"), mcpJsonRoot: sb.root,
    stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } },
  });
  return { code, out, err, json: () => JSON.parse(out) };
}
const showOf = async (sb, extra = [], opts) => (await mine(sb, ["show", "--json", ...extra], opts)).json();
const byName = (doc) => Object.fromEntries(doc.servers.map((s) => [s.name, s]));

// Some checks compare many cases at once. A mismatch is collected and reported with the others, so that one run on another system
// or against another version of Claude Code shows every difference, and not only the first.
function collector() {
  const problems = [];
  const soft = (fn) => { try { fn(); } catch (e) { problems.push(String((e && e.message) || e).split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 400)); } };
  return { problems, soft };
}

// ---- the binary -----------------------------------------------------------------------------------------------------------
const claudeList = async (sb, env = {}, cwd) => parseList((await runClaude(sb, null, ["mcp", "list"], { env, cwd })).out);
async function claudeGet(sb, name, env = {}, cwd) {
  const r = await runClaude(sb, null, ["mcp", "get", name], { env, cwd });
  return { status: statusWord((/Status: (.*)/.exec(r.out) || [])[1]), scope: (/Scope: (.*)/.exec(r.out) || [])[1] || null, raw: r.out + r.err };
}
// the order of the markers is the order of the scopes: which definition did the binary use?
const markOf = (request, server) => { const t = mcpTools(request).find((x) => x.name === `mcp__${server}__whoami`); const m = t && /"argv":\["ok","([\w-]+)"/.exec(t.description); return m ? m[1] : null; };
const echoOk = (mark, extra = {}) => fake("ok", { args: [mark], env: { FMCP_ECHO: "NOPE", ...extra } });

test("the binary: its version is recorded for the README", { skip: skip() }, (t) => {
  t.diagnostic(`Claude Code ${claudeInfo().version} on ${process.platform}, Node ${process.version}`);
  assert.match(claudeInfo().version, /^\d+\.\d+\.\d+/);
});

// ---- (f) the plugin validates ---------------------------------------------------------------------------------------------

test("claude plugin validate accepts the plugin, also with --strict", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("validate");
  for (const args of [["plugin", "validate", ROOT], ["plugin", "validate", ROOT, "--strict"], ["plugin", "validate", path.join(ROOT, ".claude-plugin", "plugin.json"), "--strict"]]) {
    const r = await runClaude(sb, null, args);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Validation passed/);
  }
});

// ---- (a) what the model receives, and what the tool measures ----------------------------------------------------------------

test("a user-scope server, tool search off: its tools are the first request's tools, named mcp__<server>__<tool>; `show` and `check` say what the request carries", { skip: skip(), timeout: 180000 }, async (t) => {
  const sb = sandbox("user");
  patchClaudeJson(sb, { mcpServers: { fake: echoOk("user") } });
  const { request, init } = await probeRun(sb);
  assert.deepEqual(init, [{ name: "fake", status: "connected", source: "user" }]);
  const sent = mcpTools(request);
  assert.deepEqual(sent.map((x) => x.name), ["mcp__fake__add", "mcp__fake__echo", "mcp__fake__list_items", "mcp__fake__whoami"], "sorted by name, prefixed with the server");
  assert.deepEqual(Object.keys(sent[0]).sort(), ["description", "input_schema", "name"]);

  const doc = await showOf(sb);
  assert.deepEqual(doc.servers.map((s) => [s.name, s.state, s.scope, s.transport, s.toolPrefix]), [["fake", "active", "user", "stdio", "mcp__fake__"]]);
  assert.equal(doc.servers[0].keyPath, "mcpServers.fake");

  const c = (await mine(sb, ["check", "--json", "--timeout", "20000"])).json();
  const s = c.servers[0];
  assert.equal(s.ok, true);
  assert.deepEqual(s.cost.perTool.map((x) => x.name), sent.map((x) => x.name), "the same tools under the same names");
  for (const x of sent) {
    const mineChars = s.cost.perTool.find((p) => p.name === x.name).chars;
    assert.equal(mineChars, JSON.stringify({ name: x.name, description: x.description, input_schema: x.input_schema }).length, x.name);
  }
  const total = sent.reduce((n, x) => n + JSON.stringify({ name: x.name, description: x.description, input_schema: x.input_schema }).length, 0);
  assert.equal(s.cost.toolSchemaChars, total, "the schema size `check` reports is the size of the tools in the request");
  assert.equal(s.cost.toolSchemaTokensEstimate, Math.round(total / 4));
  // the server's instructions are in a block of the first user message
  assert.ok(JSON.stringify(request.messages).includes("# MCP Server Instructions"), "the block of instructions has its heading");
  assert.ok(JSON.stringify(request.messages).includes("## fake\\nUse the fake tools for tests only."), "instructions reach the request");
  assert.equal(s.cost.instructionsChars, "Use the fake tools for tests only.".length);
  t.diagnostic(`${sent.length} tools, ${total} characters in the request, ${Math.round(total / 4)} tokens by characters / 4 (the same figures from check)`);
});

test("a description over the limit is cut the way the binary cuts it: 4,096 characters from 2.1.296, 2,048 before", { skip: skip(), timeout: 180000 }, async (t) => {
  const sb = sandbox("big");
  patchClaudeJson(sb, { mcpServers: { fake: fake("big") } });
  const { request } = await probeRun(sb);
  const big = mcpTools(request).find((x) => x.name === "mcp__fake__big_description");
  const limit = atLeast(2, 1, 296) ? 4096 : 2048;
  assert.equal(big.description.length, limit + "… [truncated]".length);
  assert.ok(big.description.endsWith("… [truncated]"));
  const c = (await mine(sb, ["check", "--json", "--timeout", "20000"])).json().servers[0];
  const ours = measureTools("fake", (await import("./fake-mcp-server.mjs")).toolsFor("big"), { limit });
  const sentChars = mcpTools(request).reduce((n, x) => n + JSON.stringify({ name: x.name, description: x.description, input_schema: x.input_schema }).length, 0);
  assert.equal(ours.chars, sentChars, "measureTools with the limit of this version equals the request");
  if (atLeast(2, 1, 296)) assert.equal(c.cost.toolSchemaChars, sentChars, "and check, which uses 4,096, equals it from 2.1.296");
  assert.equal(c.cost.descriptionsCut, 1);
  t.diagnostic(`Claude Code ${claudeInfo().version} cut a 6000-character description to ${limit}`);
});

test("a server that offers resources makes Claude Code send three tools of its own too, and `check` says so; a server with tools only does not", { skip: skip(), timeout: 180000 }, async (t) => {
  const bare = await probeRun(sandbox("res0"));
  const base = toolNames(bare.request);
  const extraOf = async (mode) => {
    const sb = sandbox(`res-${mode}`);
    patchClaudeJson(sb, { mcpServers: { fake: fake(mode) } });
    const r = await probeRun(sb);
    const extra = r.request.tools.filter((x) => !base.includes(x.name) && !x.name.startsWith("mcp__fake__"));
    return { sb, extra, chars: extra.reduce((n, x) => n + JSON.stringify(x).length, 0) };
  };
  const withResources = await extraOf("ok");
  const toolsOnly = await extraOf("tools-only");
  assert.deepEqual(withResources.extra.map((x) => x.name).sort(), ["ListMcpResourcesTool", "ReadMcpResourceDirTool", "ReadMcpResourceTool"]);
  assert.deepEqual(toolsOnly.extra, []);
  const said = (await mine(withResources.sb, ["check", "--json", "--timeout", "10000"])).json();
  assert.deepEqual(said.resourceTools.names, withResources.extra.map((x) => x.name).sort());
  assert.equal(said.totals.serversOfferingResources, 1);
  // the figure of the report is the one measured on 2.1.299, and the same on every version since that was looked at
  if (/^2\.1\.(299|30\d|31\d)/.test(claudeInfo().version)) assert.equal(withResources.chars, said.resourceTools.chars, "the figure of the report is the one measured on 2.1.299");
  const upFront = { env: { ENABLE_TOOL_SEARCH: "false" } };
  const text = (await mine(withResources.sb, ["check", "--timeout", "10000"], upFront)).out;
  assert.match(text, /A server that offers resources also makes Claude Code send 3 tools of its own/);
  assert.doesNotMatch((await mine(toolsOnly.sb, ["check", "--timeout", "10000"], upFront)).out, /offers resources also (makes|adds)/);
  // with tool search on (the default) they are three names in a list, and the report says so
  assert.match((await mine(withResources.sb, ["check", "--timeout", "10000"])).out, /A server that offers resources also adds 3 tool names to the list/);
  t.diagnostic(`the three resource tools are ${withResources.chars} characters on Claude Code ${claudeInfo().version}`);
});

test("tools whose full name is over 128 characters are left out, as `check` says", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("long");
  patchClaudeJson(sb, { mcpServers: { fake: fake("longname") } });
  const { request } = await probeRun(sb);
  const lengths = mcpTools(request).map((x) => x.name.length).filter((n) => n > 100);
  assert.deepEqual(lengths.sort(), [127, 128], "127 and 128 are sent, 129 and 130 are not");
  const c = (await mine(sb, ["check", "--json", "--timeout", "20000"])).json().servers[0];
  assert.equal(c.cost.toolsLeftOut.length, 2);
  assert.deepEqual(c.cost.toolsLeftOut.map((x) => x.length).sort(), [129, 130]);
  assert.equal(c.counts.tools, 7);
  assert.equal(c.cost.toolsSent, 5);
});

// ---- tool search: whether the request carries the schemas or the names ------------------------------------------------------------
// Every check above reads the schemas out of the request, so probeRun asks for them (ENABLE_TOOL_SEARCH=false, which every version
// honours). These are the checks about tool search itself: what decides it, what the request carries when it is on, what the
// model's next request carries once a tool is loaded, and that `show` and `check` say what the binary did.

const withServers = (label, servers = { fake: fake("ok") }) => { const sb = sandbox(label); patchClaudeJson(sb, { mcpServers: servers }); return sb; };
/** Has the request no MCP schema, with the ToolSearch tool in its place? */
const deferred = (request) => mcpTools(request).length === 0 && toolNames(request).includes("ToolSearch");
const agentOf = () => `claude-code_${versionNumbers().join("-")}_agent`;
const versionText = () => versionNumbers().join(".");
/** The in-process tool's verdict on tool search for a world and an environment: show reads it from the files and the environment alone. */
const verdict = async (sb, env = {}) => (await showOf(sb, [], { env })).toolSearch;

test("tool search by default: Claude Code 2.1.304 and newer defer the MCP tools for the fake API's host too, older ones leave it off there; ENABLE_TOOL_SEARCH=true and =false decide on every version; `show` and `check` say the same", { skip: skip(), timeout: 300000 }, async (t) => {
  const runs = Object.fromEntries(await Promise.all([["default", null], ["true", "true"], ["false", "false"]].map(async ([label, value]) => [label, await probeRun(withServers(`ts-${label}`), { env: { ENABLE_TOOL_SEARCH: value } })])));
  assert.ok(deferred(runs.true.request), "ENABLE_TOOL_SEARCH=true defers every MCP tool, on every version");
  assert.ok(!deferred(runs.false.request) && mcpTools(runs.false.request).length === 3, "ENABLE_TOOL_SEARCH=false puts the three schemas in the request, on every version");
  assert.equal(deferred(runs.default.request), atLeast(2, 1, 304), "not set: deferred from 2.1.304; before it Claude Code did not defer for a host that is not Anthropic's");
  assert.equal(mcpTools(runs.default.request).length, atLeast(2, 1, 304) ? 0 : 3);
  // what the tool says, for a world whose base URL is that of the fake API (a host that is not Anthropic's) and whose version is the binary's
  const sb = withServers("ts-verdict");
  const host = { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" };
  assert.equal((await verdict(sb, { ...host, AI_AGENT: agentOf() })).mode, deferred(runs.default.request) ? "deferred" : "upfront", "the default, for the version of the binary");
  assert.equal((await verdict(sb, { ...host, AI_AGENT: agentOf(), ENABLE_TOOL_SEARCH: "true" })).mode, "deferred");
  assert.equal((await verdict(sb, { ...host, AI_AGENT: agentOf(), ENABLE_TOOL_SEARCH: "false" })).mode, "upfront");
  assert.equal((await verdict(sb, host)).mode, "depends", "without the version it cannot say");
  const c = (await mine(sb, ["check", "--json", "--timeout", "20000"], { env: { ...host, AI_AGENT: agentOf() } })).json();
  assert.equal(c.toolSearch.version, versionText());
  assert.equal(c.totals.carriedChars, deferred(runs.default.request) ? c.totals.nameChars : c.totals.toolSchemaChars);
  t.diagnostic(`Claude Code ${versionText()}: not set -> ${deferred(runs.default.request) ? "deferred" : "schemas in the request"} (${runs.default.request.tools.length} tools in the request); true -> ${runs.true.request.tools.length}; false -> ${runs.false.request.tools.length}`);
});

test("Claude Code puts its own version in AI_AGENT for what it starts (claude-code_2-1-309_agent), and the tool reads the version from it", { skip: skip(), timeout: 180000 }, async () => {
  const sb = withServers("ts-agent", { fake: fake("ok", { env: { FMCP_ECHO: "AI_AGENT" } }) });
  const { request } = await probeRun(sb);
  const seen = JSON.parse(mcpTools(request).find((x) => x.name === "mcp__fake__whoami").description.slice("seen: ".length));
  assert.match(seen.env.AI_AGENT, /^claude-code_\d+-\d+-\d+_\w+$/);
  assert.equal(claudeVersionOf({ AI_AGENT: seen.env.AI_AGENT }).text, versionText(), "the version in AI_AGENT is the version the binary prints");
});

// [label, environment given to the binary, settings files' env blocks]: what is observed is compared with what the tool says
const TOOL_SEARCH_ROWS = [
  ["true", { ENABLE_TOOL_SEARCH: "true" }], ["TRUE", { ENABLE_TOOL_SEARCH: "TRUE" }], ["1", { ENABLE_TOOL_SEARCH: "1" }], ["yes", { ENABLE_TOOL_SEARCH: "yes" }], ["on", { ENABLE_TOOL_SEARCH: "on" }],
  ["force", { ENABLE_TOOL_SEARCH: "force" }], ["any other text", { ENABLE_TOOL_SEARCH: "banana" }],
  ["false", { ENABLE_TOOL_SEARCH: "false" }], ["False", { ENABLE_TOOL_SEARCH: "False" }], ["0", { ENABLE_TOOL_SEARCH: "0" }], ["no", { ENABLE_TOOL_SEARCH: "no" }], ["off", { ENABLE_TOOL_SEARCH: "off" }],
  ["auto", { ENABLE_TOOL_SEARCH: "auto" }], ["auto:5", { ENABLE_TOOL_SEARCH: "auto:5" }], ["auto:x", { ENABLE_TOOL_SEARCH: "auto:x" }], ["auto:0", { ENABLE_TOOL_SEARCH: "auto:0" }], ["auto:100", { ENABLE_TOOL_SEARCH: "auto:100" }],
  ["auto:150", { ENABLE_TOOL_SEARCH: "auto:150" }], ["auto:-5", { ENABLE_TOOL_SEARCH: "auto:-5" }], ["auto:20.5", { ENABLE_TOOL_SEARCH: "auto:20.5" }], ["auto: 20", { ENABLE_TOOL_SEARCH: "auto: 20" }],
  ["Auto", { ENABLE_TOOL_SEARCH: "Auto" }], ["AUTO:20", { ENABLE_TOOL_SEARCH: "AUTO:20" }], [" auto", { ENABLE_TOOL_SEARCH: " auto" }], ["spaces around false", { ENABLE_TOOL_SEARCH: " false " }], ["FALSE", { ENABLE_TOOL_SEARCH: "FALSE" }], ["Off", { ENABLE_TOOL_SEARCH: "Off" }],
  ["experimental betas off", { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }],
  ["experimental betas off, tool search on", { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", ENABLE_TOOL_SEARCH: "true" }],
  ["experimental betas off, tool search forced", { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", ENABLE_TOOL_SEARCH: "force" }],
  ["settings (user) false", {}, { user: "false" }],
  ["settings (user) true, environment false", { ENABLE_TOOL_SEARCH: "false" }, { user: "true" }],
  ["settings (user) false, environment true", { ENABLE_TOOL_SEARCH: "true" }, { user: "false" }],
  ["settings (project) false", {}, { project: "false" }],
  ["settings (local) false", {}, { local: "false" }],
  ["settings (project) false, (local) true", {}, { project: "false", local: "true" }],
  ["settings (user) true, (project) false", {}, { user: "true", project: "false" }],
  ["settings (local) auto", {}, { local: "auto" }],
];

test("which values of ENABLE_TOOL_SEARCH, in which place, defer the MCP tools: the binary and the tool agree on every row (a server far under any threshold stays in the request for auto)", { skip: skip(), timeout: 600000 }, async (t) => {
  const { problems, soft } = collector();
  const outcomes = [];
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < TOOL_SEARCH_ROWS.length) {
      const [label, env, files = {}] = TOOL_SEARCH_ROWS[next++];
      const sb = withServers("ts-row");
      for (const [scope, value] of Object.entries(files)) put(sb[scope], { env: { ENABLE_TOOL_SEARCH: value } });
      const { request } = await probeRun(sb, { env: { ENABLE_TOOL_SEARCH: null, ...env } });
      const said = await verdict(sb, env);
      const observed = deferred(request) ? "deferred" : "upfront";
      soft(() => assert.equal(said.mode === "auto" ? "upfront" : said.mode, observed, `${label}: the tool says ${said.mode} (${said.reason}), the binary sent ${request.tools.length} tools, ${mcpTools(request).length} of them MCP`));
      outcomes.push(`${label}: ${observed}`);
    }
  }));
  assert.deepEqual(problems, []);
  t.diagnostic(`${TOOL_SEARCH_ROWS.length} ways to set it: ${outcomes.length} runs, the tool and the binary agreed on each`);
});

test("with tool search on, the request carries the tool names in a list and the instructions, and no schema: the sizes `check` gives for the names are the list's; a name over 128 characters is not listed", { skip: skip(), timeout: 300000 }, async (t) => {
  const sb = withServers("ts-with");
  const on = await probeRun(sb, { env: { ENABLE_TOOL_SEARCH: "true" } });
  assert.deepEqual(mcpTools(on.request), []);
  assert.ok(toolNames(on.request).includes("ToolSearch"), "ToolSearch is how the model loads a schema");
  const names = deferredNames(on.request);
  assert.deepEqual(names.filter((n) => n.startsWith("mcp__")), ["mcp__fake__add", "mcp__fake__echo", "mcp__fake__list_items"], "the MCP names of the list, sorted");
  assert.ok(RESOURCE_TOOLS.names.every((n) => names.includes(n)), "a server that offers resources adds the three resource tools to the list, by name");
  assert.ok(JSON.stringify(on.request.messages).includes("## fake\\nUse the fake tools for tests only."), "the server's instructions are in the request as before");
  const c = (await mine(sb, ["check", "--json", "--timeout", "20000"], { env: { ENABLE_TOOL_SEARCH: "true" } })).json();
  const listed = names.filter((n) => n.startsWith("mcp__"));
  assert.equal(c.toolSearch.mode, "deferred");
  assert.equal(c.servers[0].cost.nameChars, listed.reduce((n, x) => n + x.length + 1, 0), "nameChars: each name and its line feed");
  assert.equal(c.resourceTools.nameChars, RESOURCE_TOOLS.names.reduce((n, x) => n + x.length + 1, 0));
  // what the server adds to the request, compared with the same run without it and with the schemas in the request
  const size = (r) => JSON.stringify(r).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").length;
  const bare = withServers("ts-none", {});
  const bareOn = await probeRun(bare, { env: { ENABLE_TOOL_SEARCH: "true" } });
  const bareOff = await probeRun(bare);
  const off = await probeRun(sb);
  const adds = size(on.request) - size(bareOn.request);
  const addsUpFront = size(off.request) - size(bareOff.request);
  assert.ok(adds >= c.servers[0].cost.nameChars + c.resourceTools.nameChars + c.servers[0].cost.instructionsChars, `the names and the instructions are in what the server adds (${adds})`);
  assert.ok(adds < addsUpFront, `with tool search the server adds ${adds} characters, with the schemas in the request ${addsUpFront}`);
  t.diagnostic(`a server with 3 tools adds ${adds} characters to the first request with tool search on (${c.servers[0].cost.nameChars} of them its names, ${c.resourceTools.nameChars} the resource tools' names), and ${addsUpFront} with its schemas in the request (${c.servers[0].cost.toolSchemaChars} of them, and ${c.resourceTools.chars} of the resource tools')`);
  // names that are too long
  const long = withServers("ts-long", { fake: fake("longname") });
  const { request } = await probeRun(long, { env: { ENABLE_TOOL_SEARCH: "true" } });
  const lengths = deferredNames(request).filter((n) => n.startsWith("mcp__fake__")).map((n) => n.length).sort((a, b) => a - b);
  assert.deepEqual(lengths, [14, 15, 21, 127, 128], "127 and 128 are listed, 129 and 130 are not");
  const lc = (await mine(long, ["check", "--json", "--timeout", "20000"], { env: { ENABLE_TOOL_SEARCH: "true" } })).json().servers[0];
  assert.equal(lc.cost.toolsLeftOut.length, 2);
  assert.equal(lc.cost.nameChars, lengths.reduce((n, x) => n + x + 1, 0));
});

test("the model loads a tool with ToolSearch: the next request carries that tool's definition, whole, flagged defer_loading, and the tool_result names it; `check` gives the size", { skip: skip(), timeout: 300000 }, async (t) => {
  const sb = withServers("ts-load", { fake: fake("big") });
  const { first, second } = await toolSearchRun(sb, "select:mcp__fake__add,mcp__fake__big_description");
  assert.ok(first && second, "the run went on after the ToolSearch call");
  assert.deepEqual(mcpTools(first), [], "the first request has no MCP schema");
  const loaded = mcpTools(second);
  assert.deepEqual(loaded.map((x) => x.name).sort(), ["mcp__fake__add", "mcp__fake__big_description"], "only the tools the model asked for");
  for (const x of loaded) assert.deepEqual(Object.keys(x).sort(), ["defer_loading", "description", "input_schema", "name"], x.name);
  assert.ok(loaded.every((x) => x.defer_loading === true));
  const result = second.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_result");
  assert.deepEqual(result.content.filter((b) => b.type === "tool_reference").map((b) => b.tool_name), ["mcp__fake__add", "mcp__fake__big_description"], "the answer of ToolSearch is a pair of tool_reference blocks");
  // the size: the same JSON `check` measures, and the description of 6,000 characters is whole (up front it is cut at 4,096)
  const c = (await mine(sb, ["check", "--json", "--timeout", "20000"], { env: { ENABLE_TOOL_SEARCH: "true" } })).json().servers[0];
  for (const x of loaded) assert.equal(JSON.stringify({ name: x.name, description: x.description, input_schema: x.input_schema }).length, c.cost.perTool.find((p) => p.name === x.name).loadedChars, x.name);
  const big = loaded.find((x) => x.name === "mcp__fake__big_description");
  assert.equal(big.description.length, 6000, "not cut when the model loads the tool");
  assert.ok(c.cost.loadedSchemaChars > c.cost.toolSchemaChars);
  t.diagnostic(`loaded: ${loaded.map((x) => `${x.name} ${JSON.stringify({ name: x.name, description: x.description, input_schema: x.input_schema }).length}`).join(", ")} characters; the whole server is ${c.cost.loadedSchemaChars} loaded, ${c.cost.toolSchemaChars} up front`);
});

test("an endpoint that refuses deferred tools (HTTP 400) gets the request again with the schemas in it, from 2.1.304, and the run still ends", { skip: skip(), timeout: 300000 }, async (t) => {
  const sb = withServers("ts-refuse");
  const api = await fakeApi(undefined, { refuseDeferred: true });
  let r;
  try { r = await runClaude(sb, api, ["-p", "PROBE-MAIN hello", "--output-format", "stream-json", "--verbose"], { env: { ENABLE_TOOL_SEARCH: "true" } }); } finally { await api.close(); }
  const main = api.requests.filter((j) => userText(j).includes("PROBE-MAIN"));
  const last = main[main.length - 1];
  t.diagnostic(`Claude Code ${versionText()}: ${main.length} requests, ${main.filter((j) => JSON.stringify(j).includes('"defer_loading"')).length} of them with deferred tools; the last carried ${mcpTools(last).length} MCP schemas; the run exited ${r.code}`);
  if (atLeast(2, 1, 304)) {
    assert.ok(main.length >= 2, "the first request was refused and sent again");
    assert.ok(JSON.stringify(main[0]).includes('"defer_loading"'));
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(!JSON.stringify(last).includes('"defer_loading"'), "the request that was answered has no deferred tool");
    assert.equal(mcpTools(last).length, 3, "and has the schemas, as the tool says for a refusable host");
  }
});

// ---- (b) approval, the project's switch, policy: `show` against `claude mcp list` and `get` -----------------------------------

const EXPECT = { // the word of `claude mcp list` and of `get` for each state of ours
  active: { list: "connected", get: "connected" }, pending: { list: "pending", get: "pending" }, rejected: { list: "none", get: "rejected" },
  disabled: { list: "disabled", get: "disabled" }, blocked: { list: "none", get: "none" }, skipped: { list: "none", get: "none" },
};

test("show agrees with `claude mcp list` and `claude mcp get` for user, local and .mcp.json servers, approved, pending, rejected, switched off, blocked and invalid", { skip: skip(), timeout: 300000 }, async (t) => {
  const sb = sandbox("states");
  patchClaudeJson(sb, { mcpServers: { u_ok: fake("ok"), u_off: fake("ok"), u_denied: fake("ok"), u_denied_cmd: fake("ok", { args: ["denied"] }), u_bad: { args: ["no-command"] } } }, { mcpServers: { l_ok: fake("ok"), l_off: fake("ok") }, disabledMcpServers: ["u_off", "l_off"] });
  put(sb.mcpJson, { mcpServers: { p_pending: fake("ok"), p_approved: fake("ok"), p_rejected: fake("ok"), p_both: fake("ok"), p_off: fake("ok"), p_bad: { url: "https://example.invalid/mcp" } } });
  put(sb.local, { enabledMcpjsonServers: ["p_approved", "p_both", "p_off"], disabledMcpjsonServers: ["p_rejected", "p_both"] });
  put(sb.user, { deniedMcpServers: [{ serverName: "u_denied" }, { serverCommand: [process.execPath, SERVER, "serve", "ok", "denied"] }] });
  patchClaudeJson(sb, {}, { disabledMcpServers: ["u_off", "l_off", "p_off"] });
  const doc = await showOf(sb);
  const list = await claudeList(sb);
  const mineBy = byName(doc);
  const names = Object.keys(mineBy).sort();
  assert.deepEqual(names, ["l_off", "l_ok", "p_approved", "p_bad", "p_both", "p_off", "p_pending", "p_rejected", "u_bad", "u_denied", "u_denied_cmd", "u_off", "u_ok"]);
  const rows = [];
  await Promise.all(names.map(async (n) => {
    const get = await claudeGet(sb, n);
    const want = EXPECT[mineBy[n].state];
    rows.push(`${n}: ${mineBy[n].state}`);
    assert.equal(statusWord(list.servers[n]), want.list, `${n}: \`claude mcp list\` says "${list.servers[n]}", the tool says ${mineBy[n].state}`);
    assert.equal(get.status, want.get, `${n}: \`claude mcp get\` says ${get.status}, the tool says ${mineBy[n].state}`);
  }));
  assert.deepEqual(Object.fromEntries(names.map((n) => [n, mineBy[n].state])), {
    l_off: "disabled", l_ok: "active", p_approved: "active", p_bad: "skipped", p_both: "rejected", p_off: "disabled", p_pending: "pending", p_rejected: "rejected",
    u_bad: "skipped", u_denied: "blocked", u_denied_cmd: "blocked", u_off: "disabled", u_ok: "active",
  });
  t.diagnostic(`${names.length} servers in 6 states: the tool, \`claude mcp list\` and \`claude mcp get\` agreed on each`);
});

test("`claude -p` loads a pending .mcp.json server without asking, and not a rejected one; the init event of the run says the same as show", { skip: skip(), timeout: 300000 }, async () => {
  const sb = sandbox("headless");
  put(sb.mcpJson, { mcpServers: { pending: fake("ok"), approved: fake("ok"), rejected: fake("ok") } });
  put(sb.local, { enabledMcpjsonServers: ["approved"], disabledMcpjsonServers: ["rejected"] });
  const { init, request } = await probeRun(sb);
  const status = Object.fromEntries(init.map((s) => [s.name, s.status]));
  assert.equal(status.pending, "connected", "pending: -p loads it");
  assert.equal(status.approved, "connected");
  assert.equal(status.rejected, undefined, "rejected: not loaded");
  assert.ok(mcpTools(request).some((x) => x.name.startsWith("mcp__pending__")));
  const doc = byName(await showOf(sb));
  assert.equal(doc.pending.state, "pending");
  assert.equal(doc.pending.headlessLoads, true, "show says that -p loads it");
  assert.equal(doc.pending.loads, false);
  assert.equal(doc.rejected.headlessLoads, false);
  assert.equal(doc.approved.headlessLoads, true);
});

test("`claude -p` never loads a rejected .mcp.json server, whatever the permission mode, and loads a pending one in all of them", { skip: skip(), timeout: 300000 }, async (t) => {
  const MODES = [[], ["--permission-mode", "default"], ["--permission-mode", "acceptEdits"], ["--permission-mode", "plan"], ["--permission-mode", "bypassPermissions"], ["--permission-mode", "dontAsk"], ["--dangerously-skip-permissions"]];
  const rows = await Promise.all(MODES.map(async (args) => {
    const sb = sandbox("modes");
    put(sb.mcpJson, { mcpServers: { pending: fake("ok"), approved: fake("ok"), rejected: fake("ok") } });
    put(sb.local, { enabledMcpjsonServers: ["approved"], disabledMcpjsonServers: ["rejected"] });
    const { init } = await probeRun(sb, { args });
    return { args, status: Object.fromEntries(init.map((s) => [s.name, s.status])) };
  }));
  for (const r of rows) assert.deepEqual(r.status, { approved: "connected", pending: "connected" }, r.args.join(" ") || "no flag");
  t.diagnostic(`${rows.length} ways to start a run (no flag, five --permission-mode values, --dangerously-skip-permissions): the rejected server was never loaded`);
});

test("approval: which settings keys and files approve a .mcp.json server, and how show reads them", { skip: skip(), timeout: 300000 }, async (t) => {
  const cases = [
    ["nothing", () => {}, "pending"],
    ["enabledMcpjsonServers in the local file", (sb) => put(sb.local, { enabledMcpjsonServers: ["s"] }), "active"],
    ["enabledMcpjsonServers in the project file, folder trusted", (sb) => put(sb.project, { enabledMcpjsonServers: ["s"] }), "active"],
    ["enabledMcpjsonServers in the project file, folder not trusted", (sb) => put(sb.project, { enabledMcpjsonServers: ["s"] }), "pending", { trusted: false }],
    ["enabledMcpjsonServers in the user file, folder not trusted", (sb) => put(sb.user, { enabledMcpjsonServers: ["s"] }), "active", { trusted: false }],
    ["enableAllProjectMcpServers in the local file", (sb) => put(sb.local, { enableAllProjectMcpServers: true }), "active"],
    ["enableAllProjectMcpServers in the user file", (sb) => put(sb.user, { enableAllProjectMcpServers: true }), "active"],
    ["enableAllProjectMcpServers false and the name listed", (sb) => put(sb.local, { enableAllProjectMcpServers: false, enabledMcpjsonServers: ["s"] }), "active"],
    ["disabledMcpjsonServers in the local file", (sb) => put(sb.local, { disabledMcpjsonServers: ["s"] }), "rejected"],
    ["disabled in the project file wins over enableAll in the user file", (sb) => { put(sb.project, { disabledMcpjsonServers: ["s"] }); put(sb.user, { enableAllProjectMcpServers: true }); }, "rejected"],
    ["enabled and disabled", (sb) => put(sb.local, { enabledMcpjsonServers: ["s"], disabledMcpjsonServers: ["s"] }), "rejected"],
    ["the older home of the approval: the project's entry of .claude.json", (sb) => patchClaudeJson(sb, {}, { enabledMcpjsonServers: ["s"] }), "active"],
    ["a settings file with a comment is ignored, approval and all", (sb) => put(sb.local, '{\n  // note\n  "enabledMcpjsonServers": ["s"]\n}\n'), "pending"],
  ];
  const results = await Promise.all(cases.map(async ([label, setup, want, opts]) => {
    const sb = sandbox("appr", opts);
    put(sb.mcpJson, { mcpServers: { s: fake("ok") } });
    setup(sb);
    const l = await claudeList(sb);
    const g = await claudeGet(sb, "s");
    const m = byName(await showOf(sb)).s;
    return { label, want, binary: g.status, list: statusWord(l.servers.s), mine: m.state };
  }));
  for (const r of results) {
    assert.equal(r.mine, r.want, `${r.label}: the tool says ${r.mine}`);
    assert.equal(r.binary, EXPECT[r.want].get, `${r.label}: the binary says ${r.binary}`);
    assert.equal(r.list, EXPECT[r.want].list, `${r.label}: the binary lists ${r.list}`);
  }
  t.diagnostic(`${results.length} ways of approving or rejecting, all as the binary reads them`);
});

test("`claude mcp reset-project-choices` clears the approval keys in the project's local settings and in its entry of .claude.json, and in no other file: the file `toggle` writes", { skip: skip(), timeout: 120000 }, async () => {
  const sb = sandbox("reset");
  put(sb.mcpJson, { mcpServers: { a: fake("ok"), b: fake("ok") } });
  const keys = { enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["b"], enableAllProjectMcpServers: true };
  put(sb.local, { model: "m-local", ...keys });
  put(sb.project, { model: "m-project", ...keys });
  put(sb.user, { model: "m-user", ...keys });
  patchClaudeJson(sb, {}, { enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["b"], enableAllProjectMcpServers: true, disabledMcpServers: ["x"] });
  const projectBefore = fs.readFileSync(sb.project, "utf8");
  const userBefore = fs.readFileSync(sb.user, "utf8");
  const r = await runClaude(sb, null, ["mcp", "reset-project-choices"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.local, "utf8")), { model: "m-local" }, "the three keys are gone from the local settings, the rest stays");
  assert.equal(fs.readFileSync(sb.project, "utf8"), projectBefore, "the project's settings.json is not touched");
  assert.equal(fs.readFileSync(sb.user, "utf8"), userBefore, "nor is the user's");
  const entry = JSON.parse(fs.readFileSync(sb.claudeJson, "utf8")).projects[sb.key];
  assert.equal(entry.enabledMcpjsonServers, undefined);
  assert.equal(entry.disabledMcpjsonServers, undefined);
  assert.equal(entry.enableAllProjectMcpServers, undefined);
  assert.deepEqual(entry.disabledMcpServers, ["x"], "the /mcp list is not part of the approvals");
});

test("the project key is the git root, a parent folder's trust and .mcp.json are handled as the binary does", { skip: skip(), timeout: 300000 }, async () => {
  const sb = sandbox("gitroot", { trusted: false });
  const repo = path.join(sb.root, "repo");
  const sub = path.join(repo, "pkg", "sub");
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const key = (p) => fwd(p);
  const j = JSON.parse(fs.readFileSync(sb.claudeJson, "utf8"));
  j.projects = {
    [key(repo)]: { hasTrustDialogAccepted: true, allowedTools: [], mcpServers: { atroot: fake("ok") } },
    [key(sub)]: { hasTrustDialogAccepted: true, allowedTools: [], mcpServers: { atsub: fake("ok") } },
  };
  put(sb.claudeJson, j);
  put(path.join(repo, ".mcp.json"), { mcpServers: { rootjson: fake("ok"), dup: echoOk("root") } });
  put(path.join(sub, ".mcp.json"), { mcpServers: { subjson: fake("ok"), dup: echoOk("sub") } });
  put(path.join(repo, "pkg", ".mcp.json"), { mcpServers: { pkgjson: fake("ok") } });
  put(path.join(sub, ".claude", "settings.local.json"), { enableAllProjectMcpServers: true });
  put(path.join(sb.root, ".mcp.json"), { mcpServers: { above: fake("ok") } }); // in the folder above the repository
  const l = await claudeList(sb, {}, sub);
  const doc = byName(await showOf(sb, ["--project", sub]));
  assert.equal(doc.atroot.state, "active", "local servers are kept under the root of the repository");
  assert.equal(doc.atsub, undefined, "and not under the folder inside it");
  assert.equal(statusWord(l.servers.atroot), "connected");
  assert.equal(l.servers.atsub, undefined);
  for (const n of ["rootjson", "pkgjson", "subjson", "dup", "above"]) assert.equal(statusWord(l.servers[n]), EXPECT[doc[n].state].list, n);
  assert.equal(doc.above.state, "active", "a .mcp.json above the repository is read too");
  assert.equal(doc.subjson.state, "active", "the repository root is the trusted project, and the local file of the folder approves");
  assert.equal(doc.rootjson.state, "active");
  const d = await claudeGet(sb, "dup", {}, sub);
  assert.match(d.raw, /dup-sub|serve ok sub/, "the nearest .mcp.json wins a name");
  assert.equal(doc.dup.definitions.find((x) => x.role === "winner").display, ".mcp.json", "the winner is the .mcp.json of the folder itself");
  assert.equal(doc.dup.definitions.find((x) => x.role === "shadowed").display, "../../.mcp.json");
});

test("without CLAUDE_CONFIG_DIR the servers are in ~/.claude.json, and ~/.claude/.claude.json is not read", { skip: skip(), timeout: 120000 }, async () => {
  const sb = sandbox("default");
  const key = fwd(sb.work);
  put(path.join(sb.home, ".claude.json"), { hasCompletedOnboarding: true, mcpServers: { homeuser: fake("ok") }, projects: { [key]: { hasTrustDialogAccepted: true } } });
  put(path.join(sb.home, ".claude", ".claude.json"), { mcpServers: { inside: fake("ok") } });
  const env = baseEnv({ HOME: sb.home, USERPROFILE: sb.home });
  delete env.CLAUDE_CONFIG_DIR;
  const r = await new Promise((resolve) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(CLAUDE, ["mcp", "list"], { cwd: sb.work, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: IS_WIN && !/\.exe$/i.test(CLAUDE) });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.on("close", () => resolve(out));
    });
  });
  assert.deepEqual(Object.keys(parseList(r).servers), ["homeuser"]);
  let out = "";
  await main(["show", "--json"], { cwd: sb.work, env, home: sb.home, managed: path.join(sb.root, "managed"), mcpJsonRoot: sb.root, stdout: { write: (s) => { out += s; return true; } }, stderr: { write: () => true } });
  assert.deepEqual(JSON.parse(out).servers.map((s) => s.name), ["homeuser"]);
});

// ---- (a) several scopes: which definition wins -------------------------------------------------------------------------------

test("a name defined in several scopes: the binary uses the definition `show` says it uses (local, project, user, then --mcp-config over all)", { skip: skip(), timeout: 600000 }, async (t) => {
  const combos = [["user"], ["local"], ["project"], ["user", "local"], ["user", "project"], ["local", "project"], ["user", "local", "project"], ["user", "flag"], ["project", "flag"], ["local", "flag"], ["user", "local", "project", "flag"]];
  const results = [];
  const run = async (places) => {
    const sb = sandbox("prec");
    const patch = {};
    if (places.includes("user")) patch.mcpServers = { dup: echoOk("user") };
    patchClaudeJson(sb, patch, places.includes("local") ? { mcpServers: { dup: echoOk("local") } } : undefined);
    if (places.includes("project")) { put(sb.mcpJson, { mcpServers: { dup: echoOk("project") } }); put(sb.local, { enableAllProjectMcpServers: true }); }
    const flagFile = path.join(sb.root, "flag.json");
    const extra = [];
    if (places.includes("flag")) { put(flagFile, { mcpServers: { dup: echoOk("flag") } }); extra.push("--mcp-config", flagFile); }
    const { request } = await probeRun(sb, { args: extra });
    const doc = await showOf(sb, extra);
    const winner = doc.servers[0].definitions.find((d) => d.role === "winner");
    const mark = { "--mcp-config": "flag" }[winner.scope] || winner.scope;
    const diag = (await mine(sb, ["lint", "--json", ...extra])).json().findings.filter((f) => f.id === "duplicate-name");
    return { places, binary: markOf(request, "dup"), mine: mark, duplicates: diag.length, scopes: doc.servers[0].definitions.length };
  };
  for (let i = 0; i < combos.length; i += 4) results.push(...(await Promise.all(combos.slice(i, i + 4).map(run))));
  for (const r of results) {
    assert.equal(r.binary, r.mine, `defined in ${r.places.join(" + ")}: the binary used ${r.binary}, the tool says ${r.mine}`);
    assert.equal(r.duplicates, r.scopes > 1 ? 1 : 0, `defined in ${r.places.join(" + ")}: lint reports a name defined twice exactly then`);
  }
  t.diagnostic(`${results.length} combinations, the winner agreed in each: ${results.map((r) => `${r.places.join("+")}=${r.binary}`).join(", ")}`);
});

test("an invalid higher definition falls through to a valid lower one, and a pending one is used by -p and not by a session", { skip: skip(), timeout: 300000 }, async () => {
  const good = (mark) => echoOk(mark);
  const cases = [
    ["user valid + project invalid", (sb) => { patchClaudeJson(sb, { mcpServers: { dup: good("user") } }); put(sb.mcpJson, { mcpServers: { dup: { args: ["x"] } } }); put(sb.local, { enableAllProjectMcpServers: true }); }, "user", "user"],
    ["user valid + local invalid", (sb) => patchClaudeJson(sb, { mcpServers: { dup: good("user") } }, { mcpServers: { dup: { command: 5 } } }), "user", "user"],
    ["user valid + project rejected", (sb) => { patchClaudeJson(sb, { mcpServers: { dup: good("user") } }); put(sb.mcpJson, { mcpServers: { dup: good("project") } }); put(sb.local, { disabledMcpjsonServers: ["dup"] }); }, "user", "user"],
    ["user valid + project pending", (sb) => { patchClaudeJson(sb, { mcpServers: { dup: good("user") } }); put(sb.mcpJson, { mcpServers: { dup: good("project") } }); }, "user", "project"],
  ];
  for (const [label, setup, session, headless] of cases) {
    const sb = sandbox("fall");
    setup(sb);
    const { request } = await probeRun(sb);
    const doc = byName(await showOf(sb)).dup;
    const get = await claudeGet(sb, "dup");
    assert.equal(markOf(request, "dup"), headless, `${label}: -p`);
    const winner = doc.definitions.find((d) => d.role === "winner");
    assert.equal(winner.scope, session, `${label}: the tool's winner`);
    assert.match(get.scope, session === "user" ? /User config/ : /Project config/, `${label}: \`claude mcp get\``);
    if (session !== headless) assert.equal(doc.headless.scope, headless, `${label}: show says what -p loads`);
  }
});

test("--mcp-config servers: show reads the file like the flag, and --strict-mcp-config leaves the others out of the run", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("flag");
  patchClaudeJson(sb, { mcpServers: { fromuser: fake("ok") } });
  const flagFile = put(path.join(sb.root, "extra.json"), { mcpServers: { fromflag: fake("ok") } });
  const withFlag = await probeRun(sb, { args: ["--mcp-config", flagFile] });
  assert.deepEqual(withFlag.init.map((s) => s.name).sort(), ["fromflag", "fromuser"]);
  const doc = byName(await showOf(sb, ["--mcp-config", flagFile]));
  assert.equal(doc.fromflag.state, "active");
  assert.equal(doc.fromflag.scope, "--mcp-config");
  const strict = await probeRun(sb, { args: ["--mcp-config", flagFile, "--strict-mcp-config"] });
  assert.deepEqual(strict.init.map((s) => s.name), ["fromflag"]);
});

// ---- plugins -----------------------------------------------------------------------------------------------------------------

function localMarketplace(sb, { name = "myplug", servers, inline } = {}) {
  const mkt = path.join(sb.root, "mkt");
  const plug = path.join(mkt, "plugins", name);
  put(path.join(mkt, ".claude-plugin", "marketplace.json"), { name: "local-test", owner: { name: "t" }, plugins: [{ name, description: "x", source: `./plugins/${name}` }] });
  put(path.join(plug, ".claude-plugin", "plugin.json"), { name, version: "1.0.0", description: "a plugin with servers", ...(inline ? { mcpServers: inline } : {}) });
  if (servers) put(path.join(plug, ".mcp.json"), { mcpServers: servers });
  return mkt;
}

test("plugin servers: an installed plugin's servers are named plugin:<plugin>:<server>, found through installed_plugins.json, and a duplicate endpoint is dropped", { skip: skip(), timeout: 300000 }, async () => {
  const sb = sandbox("plugin");
  const mkt = localMarketplace(sb, { servers: { pserv: fake("ok", { args: ["plugin"] }), same: fake("ok", { args: ["shared-endpoint"] }) } });
  patchClaudeJson(sb, { mcpServers: { mine: fake("ok", { args: ["shared-endpoint"] }) } });
  for (const args of [["plugin", "marketplace", "add", mkt], ["plugin", "install", "myplug@local-test"]]) {
    const r = await runClaude(sb, null, args, { timeout: 100000 });
    assert.equal(r.code, 0, r.out + r.err);
  }
  const { init, request } = await probeRun(sb);
  const l = await claudeList(sb);
  const doc = byName(await showOf(sb));
  assert.deepEqual(Object.keys(doc).sort(), ["mine", "plugin:myplug:pserv", "plugin:myplug:same"]);
  assert.equal(doc["plugin:myplug:pserv"].state, "active");
  assert.equal(doc["plugin:myplug:pserv"].scope, "plugin");
  assert.equal(doc["plugin:myplug:same"].state, "duplicate", "same command as `mine`");
  assert.deepEqual(init.map((s) => `${s.name}:${s.source}`).sort(), ["mine:user", "plugin:myplug:pserv:plugin"]);
  assert.equal(statusWord(l.servers["plugin:myplug:pserv"]), "connected");
  assert.equal(l.servers["plugin:myplug:same"], undefined);
  assert.ok(mcpTools(request).some((x) => x.name.startsWith("mcp__plugin_myplug_pserv__")));
  assert.equal(doc["plugin:myplug:pserv"].toolPrefix, "mcp__plugin_myplug_pserv__");
});

test("a plugin that is installed for one project loads there only, and a disabled plugin loads nowhere", { skip: skip(), timeout: 300000 }, async () => {
  const sb = sandbox("plugproj");
  const mkt = localMarketplace(sb, { servers: { pserv: fake("ok") } });
  for (const args of [["plugin", "marketplace", "add", mkt], ["plugin", "install", "myplug@local-test", "--scope", "project"]]) assert.equal((await runClaude(sb, null, args, { timeout: 100000 })).code, 0);
  assert.deepEqual(Object.keys(byName(await showOf(sb))), ["plugin:myplug:pserv"]);
  assert.ok((await claudeList(sb)).servers["plugin:myplug:pserv"]);
  const elsewhere = path.join(sb.root, "elsewhere");
  fs.mkdirSync(elsewhere, { recursive: true });
  assert.deepEqual(Object.keys(byName(await showOf(sb, ["--project", elsewhere]))), [], "not in another folder");
  assert.equal((await claudeList(sb, {}, elsewhere)).servers["plugin:myplug:pserv"], undefined);
  await runClaude(sb, null, ["plugin", "disable", "myplug@local-test", "--scope", "project"], { timeout: 100000 });
  assert.deepEqual(Object.keys(byName(await showOf(sb))), [], "disabled");
  assert.equal((await claudeList(sb)).servers["plugin:myplug:pserv"], undefined);
});

test("enabledPlugins in the settings files: the highest file that mentions an installed plugin decides whether its servers load", { skip: skip(), timeout: 600000 }, async (t) => {
  const ID = "myplug@local-test";
  const cases = [
    ["nothing else", {}, true],
    ["project false", { project: false }, false],
    ["local false", { local: false }, false],
    ["project false, local true", { project: false, local: true }, true],
    ["user false, project true", { user: false, project: true }, true],
    ["user false, local true", { user: false, local: true }, true],
    ["user false", { user: false }, false],
  ];
  const rows = await Promise.all(cases.map(async ([label, files, loaded]) => {
    const sb = sandbox("penabled");
    const mkt = localMarketplace(sb, { servers: { pserv: fake("ok") } });
    for (const args of [["plugin", "marketplace", "add", mkt], ["plugin", "install", ID]]) assert.equal((await runClaude(sb, null, args, { timeout: 100000 })).code, 0, label);
    const cur = JSON.parse(fs.readFileSync(sb.user, "utf8"));
    if ("user" in files) put(sb.user, { ...cur, enabledPlugins: { ...cur.enabledPlugins, [ID]: files.user } });
    if ("project" in files) put(sb.project, { enabledPlugins: { [ID]: files.project } });
    if ("local" in files) put(sb.local, { enabledPlugins: { [ID]: files.local } });
    const binary = (await claudeList(sb)).servers["plugin:myplug:pserv"] !== undefined;
    const mineLoads = "plugin:myplug:pserv" in byName(await showOf(sb));
    return { label, loaded, binary, mineLoads };
  }));
  for (const r of rows) {
    assert.equal(r.binary, r.loaded, `${r.label}: the binary`);
    assert.equal(r.mineLoads, r.loaded, `${r.label}: the tool`);
  }
  t.diagnostic(`${rows.length} combinations of enabledPlugins in the user, project and local settings: the binary and the tool agree`);
});

test("the shapes of a plugin's MCP file: wrapper or flat .mcp.json, inline in plugin.json, a path, a list of paths", { skip: skip(), timeout: 300000 }, async () => {
  const shapes = {
    wrapper: (d) => put(path.join(d, ".mcp.json"), { mcpServers: { a: fake("ok") } }),
    flat: (d) => put(path.join(d, ".mcp.json"), { a: fake("ok") }),
    inline: (d) => put(path.join(d, ".claude-plugin", "plugin.json"), { name: "pv", version: "1.0.0", description: "d", mcpServers: { a: fake("ok") } }),
    path: (d) => { put(path.join(d, ".claude-plugin", "plugin.json"), { name: "pv", version: "1.0.0", description: "d", mcpServers: "./servers.json" }); put(path.join(d, "servers.json"), { mcpServers: { a: fake("ok") } }); },
    list: (d) => { put(path.join(d, ".claude-plugin", "plugin.json"), { name: "pv", version: "1.0.0", description: "d", mcpServers: ["./s1.json"] }); put(path.join(d, "s1.json"), { mcpServers: { a: fake("ok") } }); },
  };
  for (const [shape, build] of Object.entries(shapes)) {
    const sb = sandbox("pshape");
    const dir = path.join(sb.root, "plug");
    put(path.join(dir, ".claude-plugin", "plugin.json"), { name: "pv", version: "1.0.0", description: "d" });
    build(dir);
    const r = await probeRun(sb, { args: ["--plugin-dir", dir] });
    assert.deepEqual(r.init.map((s) => s.name), ["plugin:pv:a"], `${shape}: the binary reads it`);
  }
  // the tool reads the same shapes from an installed plugin's folder
  for (const [shape, build] of Object.entries(shapes)) {
    const sb = sandbox("pshape2");
    const dir = path.join(sb.cfg, "plugins", "cache", "m", "pv", "1.0.0");
    put(path.join(dir, ".claude-plugin", "plugin.json"), { name: "pv", version: "1.0.0", description: "d" });
    build(dir);
    put(path.join(sb.cfg, "plugins", "installed_plugins.json"), { version: 2, plugins: { "pv@m": [{ scope: "user", installPath: dir, version: "1.0.0" }] } });
    put(sb.user, { enabledPlugins: { "pv@m": true } });
    assert.deepEqual(Object.keys(byName(await showOf(sb))), ["plugin:pv:a"], `${shape}: the tool reads it`);
  }
});

// ---- (c) ${VAR}, the working folder, the environment and the command of a server ---------------------------------------------

const PATTERNS = ["a=${V_SET}", "b=${V_EMPTY}", "c=${V_UNSET}", "d=${V_UNSET:-dflt}", "e=${V_SET:-dflt}", "f=${V_EMPTY:-dflt}", "g=pre-${V_SET}-post", "h=$V_SET", "i=${V_SET", "j=${}", "k=${V_UNSET:-}", "l=${CLAUDE_PROJECT_DIR}", "m=${SETTINGS_VAR}", "n=${HOME}", "o=$${V_SET}", "p=${V_UNSET-dflt}", "q=${V_SET:-${V_SET}}", "r=${V_UNSET:-${V_SET}}", "s=%V_SET%", "t=~", "u=${V_Set}", "v=${ANTHROPIC_API_KEY}", "w=${PROJ_ONLY}", "x=${LOCAL_ONLY}", "y=${1ABC}", "z=${A.B}", "aa=${A B}", "bb=${V_SET}${V_SET}", "cc=${V_SET:-a:-b}", "dd=${ V_SET }", "ee=\\${V_SET}", "ff=${V_SET}}"];

/** The server in `place` (the user file or a .mcp.json) is started by the binary and by `check`; compare what the process saw. */
async function expansionCase(t, place) {
  const sb = sandbox("expand");
  const env = { V_SET: "value-set", V_EMPTY: "", ANTHROPIC_API_KEY: "sk-ant-probe-key", BOTH: "process" };
  put(sb.user, { env: { SETTINGS_VAR: "from-user-settings", BOTH: "user-settings" } });
  put(sb.project, { env: { PROJ_ONLY: "from-project" } });
  put(sb.local, { env: { LOCAL_ONLY: "from-local", BOTH: "local" }, ...(place === ".mcp.json" ? { enabledMcpjsonServers: ["x"] } : {}) });
  const server = { command: process.execPath, args: [SERVER, "serve", "ok", ...PATTERNS], env: { FMCP_LOG: "${LOGFILE}", FMCP_ECHO: "SEEN_SET,SEEN_UNSET,SEEN_DFLT,SEEN_MIXED,BOTH,V_EMPTY,V_UNSET,SETTINGS_VAR,PROJ_ONLY,LOCAL_ONLY,CLAUDE_PROJECT_DIR", SEEN_SET: "${V_SET}", SEEN_UNSET: "${V_UNSET}", SEEN_DFLT: "${V_UNSET:-dflt}", SEEN_MIXED: "x-${V_SET}-${V_UNSET}-y" } };
  if (place === ".mcp.json") put(sb.mcpJson, { mcpServers: { x: server } });
  else patchClaudeJson(sb, { mcpServers: { x: server } });
  const logBinary = path.join(sb.root, "binary.jsonl");
  const logMine = path.join(sb.root, "mine.jsonl");
  await probeRun(sb, { env: { ...env, LOGFILE: logBinary } });
  const checked = (await mine(sb, ["check", "x", "--json", "--timeout", "20000"], { env: { ...env, LOGFILE: logMine } })).json();
  assert.equal(checked.servers[0].ok, true);
  const startOf = (file) => readLog(file).find((e) => e.event === "start");
  const a = startOf(logBinary);
  const b = startOf(logMine);
  assert.ok(a && b, "both started the server");
  const diff = [];
  a.argv.forEach((v, i) => { if (v !== b.argv[i]) diff.push(`${PATTERNS[i - 2] || i}: binary "${v}" / tool "${b.argv[i]}"`); });
  assert.deepEqual(diff, [], "every argument");
  assert.equal(a.argv.length, b.argv.length);
  assert.deepEqual(b.echo, a.echo, "the variables the server was told to show, expansion and inheritance alike");
  assert.equal(b.cwd, a.cwd, "the working folder is the project folder");
  // everything in the environment of the tool's child is in the environment of the binary's child (the binary adds its own CLAUDE* variables)
  const onlyMine = b.envNames.filter((n) => !a.envNames.includes(n));
  assert.deepEqual(onlyMine, [], "the tool adds no variable that the binary does not");
  const onlyBinary = a.envNames.filter((n) => !b.envNames.includes(n));
  // the diagnostics of `claude mcp list` name the variables that are set nowhere, as show does
  const listOut = (await runClaude(sb, null, ["mcp", "list"], { env })).out;
  const said = /Missing environment variables: (.*)/.exec(listOut);
  const ours = (await showOf(sb, [], { env })).servers[0].references.missing.map((m) => m.name);
  assert.deepEqual([...new Set(said[1].split(", "))].sort(), [...new Set(ours)].sort(), "the same variables are missing");
  t.diagnostic(`${PATTERNS.length} patterns in ${place}, expanded the same by the binary and by the tool; the server saw ${a.envNames.length} variables from the binary and ${b.envNames.length} from the tool; the binary adds ${onlyBinary.join(", ")}`);
}

test("${VAR} expansion: command, args and env come out of the tool exactly as the binary makes them, in ~/.claude.json and in a .mcp.json, and the diagnostics name the same variables", { skip: skip(), timeout: 300000 }, async (t) => {
  await expansionCase(t, "~/.claude.json");
  await expansionCase(t, ".mcp.json");
});

test("expansion in a plugin's server: CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA and CLAUDE_PROJECT_DIR are filled in, as the tool fills them", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("pexp");
  const dir = path.join(sb.root, "plug");
  put(path.join(dir, ".claude-plugin", "plugin.json"), { name: "pp", version: "1.0.0", description: "d" });
  put(path.join(dir, ".mcp.json"), { mcpServers: { a: { command: process.execPath, args: [SERVER, "serve", "ok", "root=${CLAUDE_PLUGIN_ROOT}", "data=${CLAUDE_PLUGIN_DATA}", "proj=${CLAUDE_PROJECT_DIR}", "other=${NOT_SET_ANYWHERE}"], env: { FMCP_ECHO: "NOPE" } } } });
  const { request } = await probeRun(sb, { args: ["--plugin-dir", dir] });
  const seen = JSON.parse(mcpTools(request).find((x) => x.name.endsWith("__whoami")).description.slice("seen: ".length));
  assert.deepEqual(seen.argv.slice(1), [`root=${fwd(dir)}`, `data=${fwd(path.join(sb.cfg, "plugins", "data", "pp-inline"))}`, `proj=${fwd(sb.work)}`, "other=${NOT_SET_ANYWHERE}"]);
});

test("in the url and headers of a remote server some credential names read as empty; `check --send-headers` sends what the binary sends, and nothing is sent without it", { skip: skip(), timeout: 300000 }, async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let m = null;
      try { m = JSON.parse(body); } catch { /* none */ }
      if (m && m.method === "initialize") seen.push({ url: req.url, headers: req.headers, ua: req.headers["user-agent"] });
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const sb = sandbox("headers");
    const env = { NPM_TOKEN: "npm-secret", ANTHROPIC_API_KEY: "sk-ant-secret", GITHUB_TOKEN: "ghp-secret", MY_KEY: "mine-secret", V_SET: "value-set" };
    patchClaudeJson(sb, { mcpServers: { r: { type: "http", url: `${base}/mcp?a=\${V_SET}&k=\${ANTHROPIC_API_KEY}`, headers: { "X-Npm": "${NPM_TOKEN}", "X-Anthropic": "${ANTHROPIC_API_KEY}", "X-Github": "${GITHUB_TOKEN}", "X-Mine": "${MY_KEY}", "X-Lit": "lit-${V_SET}" } } } });
    await runClaude(sb, null, ["mcp", "get", "r"], { env });
    const fromBinary = seen.find((s) => s.url.startsWith("/mcp"));
    assert.ok(fromBinary, "the binary reached the server");
    seen.length = 0;
    const plain = (await mine(sb, ["check", "r", "--json", "--timeout", "5000"], { env })).json().servers[0];
    assert.equal(plain.http.status, 404);
    assert.equal(plain.http.outcome, "not-found");
    assert.equal(plain.http.sentHeaders, false);
    assert.ok(seen.length >= 1);
    for (const k of ["x-npm", "x-anthropic", "x-github", "x-mine", "x-lit"]) assert.equal(seen[0].headers[k], undefined, `${k} is not sent without --send-headers`);
    assert.match(plain.http.note, /X-Npm, X-Anthropic, X-Github, X-Mine, X-Lit/);
    seen.length = 0;
    const sent = (await mine(sb, ["check", "r", "--json", "--timeout", "5000", "--send-headers"], { env })).json().servers[0];
    assert.equal(sent.http.sentHeaders, true);
    for (const k of ["x-npm", "x-anthropic", "x-github", "x-mine", "x-lit"]) assert.equal(seen[0].headers[k], fromBinary.headers[k], `${k} arrives as the binary sends it`);
    assert.equal(seen[0].url, fromBinary.url, "the url is expanded the same way");
    assert.equal(seen[0].headers["x-npm"], "", "NPM_TOKEN reads as empty");
    assert.equal(seen[0].headers["x-github"], "ghp-secret", "GITHUB_TOKEN does not");
    assert.ok(!JSON.stringify(sent).includes("ghp-secret") && !JSON.stringify(sent).includes("mine-secret"), "no header value is printed");
  } finally { server.close(); }
});

test("which variable names read as empty in the headers of a remote server: the binary and the list of the tool agree on 45 names", { skip: skip(), timeout: 300000 }, async (t) => {
  const NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_PROFILE", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "USER", "USERNAME", "API_KEY", "MY_TOKEN", "TOKEN", "SECRET", "PASSWORD", "MY_PASSWORD", "AUTH_TOKEN", "BEARER_TOKEN", "SLACK_TOKEN", "STRIPE_API_KEY", "DATABASE_URL", "SSH_AUTH_SOCK", "LANG", "ANTHROPIC_FOUNDRY_API_KEY", "CLAUDE_CODE_API_KEY_HELPER", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "MY_KEY", "V_SET", "SOME_OTHER_NAME"];
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { let m = null; try { m = JSON.parse(body); } catch { /* none */ } if (m && m.method === "initialize") seen.push(req.headers); res.writeHead(404); res.end(); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const sb = sandbox("cred");
    const header = (n) => `X-${n.replace(/_/g, "-")}`;
    patchClaudeJson(sb, { mcpServers: { r: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, headers: Object.fromEntries(NAMES.map((n) => [header(n), `v:\${${n}}`])) } } });
    const env = Object.fromEntries(NAMES.map((n) => [n, `secret-${n}`]));
    await runClaude(sb, null, ["mcp", "get", "r"], { env });
    assert.ok(seen.length >= 1, "the binary reached the server");
    const empty = NAMES.filter((n) => seen[0][header(n).toLowerCase()] === "v:");
    const ours = NAMES.filter((n) => REMOTE_EMPTY.has(n.toUpperCase()));
    assert.deepEqual(empty.sort(), ours.sort(), "the names that read as empty");
    t.diagnostic(`${empty.length} of ${NAMES.length} names read as empty: ${empty.join(", ")}`);
  } finally { server.close(); }
});

test("the command of a stdio server is found as the binary finds it: PATH, the PATH of the server's env, relative paths, quotes, and on Windows .cmd and .bat files", { skip: skip(), timeout: 600000 }, async (t) => {
  const NODE = process.execPath;
  const cases = [];
  const add = (label, def, setup) => cases.push({ label, def, setup });
  add("an absolute path", () => ({ command: NODE, args: [SERVER, "serve", "ok"] }));
  add("a name on the PATH", () => ({ command: path.basename(NODE).replace(/\.exe$/i, ""), args: [SERVER, "serve", "ok"] }));
  add("a name that is nowhere", () => ({ command: "definitely-not-a-command-xyz", args: ["x"] }));
  add("a command line in one string", () => ({ command: `"${NODE}" ${SERVER} serve ok one two` }));
  add("a command line with args too", () => ({ command: `"${NODE}" ${SERVER}`, args: ["serve", "ok", "b"] }));
  add("tabs and double spaces between words", () => ({ command: `"${NODE}"\t${SERVER}  serve   ok` }));
  add("single quotes are not quotes", () => ({ command: `'${NODE}' ${SERVER} serve ok` }));
  add("a leading space", () => ({ command: ` "${NODE}"`, args: [SERVER, "serve", "ok"] }));
  add("a relative path to a file in the project", () => ({ command: "./bin/runner", args: [SERVER, "serve", "ok"] }), (sb) => { const f = path.join(sb.work, "bin", IS_WIN ? "runner.cmd" : "runner"); put(f, IS_WIN ? `@echo off\r\n"${NODE}" %*\r\n` : `#!/bin/sh\nexec "${NODE}" "$@"\n`); if (!IS_WIN) fs.chmodSync(f, 0o755); });
  add("a relative path that is not there", () => ({ command: "./bin/nothing", args: [SERVER, "serve", "ok"] }));
  add("a file that is not executable", () => ({ command: "./bin/plain", args: [SERVER, "serve", "ok"] }), (sb) => put(path.join(sb.work, "bin", "plain"), "#!/bin/sh\n"));
  add("the PATH set only in the server's env", () => ({ command: "onlyhere", args: [SERVER, "serve", "ok"], env: { PATH: `${"@@BIN@@"}${path.delimiter}${process.env.PATH}` } }), (sb) => { const bin = path.join(sb.root, "bin2"); const f = path.join(bin, IS_WIN ? "onlyhere.cmd" : "onlyhere"); put(f, IS_WIN ? `@echo off\r\n"${NODE}" %*\r\n` : `#!/bin/sh\nexec "${NODE}" "$@"\n`); if (!IS_WIN) fs.chmodSync(f, 0o755); });
  if (IS_WIN) {
    add("a .cmd file on the PATH (npx is one)", () => ({ command: "shim", args: [SERVER, "serve", "ok"] }), (sb) => put(path.join(sb.root, "bin3", "shim.cmd"), `@echo off\r\n"${NODE}" %*\r\n`));
    add("a .bat file by its name", () => ({ command: "shim2.bat", args: [SERVER, "serve", "ok"] }), (sb) => put(path.join(sb.root, "bin3", "shim2.bat"), `@echo off\r\n"${NODE}" %*\r\n`));
    add("./node.exe falls back to the PATH", () => ({ command: "./node.exe", args: [SERVER, "serve", "ok"] }));
    add("sub/node.exe does not", () => ({ command: "sub/node.exe", args: [SERVER, "serve", "ok"] }));
  }
  const rows = await Promise.all(cases.map(async (c, i) => {
    const sb = sandbox(`cmd${i}`);
    const log = path.join(sb.root, "fmcp.jsonl");
    if (c.setup) c.setup(sb);
    const def = c.def();
    def.env = JSON.parse(JSON.stringify({ ...(def.env || {}), FMCP_LOG: log }).replace(/@@BIN@@/g, path.join(sb.root, "bin2").replace(/\\/g, "\\\\")));
    patchClaudeJson(sb, { mcpServers: { c: def } });
    const pathEnv = { PATH: `${path.join(sb.root, "bin3")}${path.delimiter}${process.env.PATH}` };
    const l = await claudeList(sb, pathEnv);
    const binaryStarted = readLog(log).some((e) => e.event === "start");
    const binaryArgv = (readLog(log).find((e) => e.event === "start") || {}).argv;
    fs.rmSync(log, { force: true });
    const r = (await mine(sb, ["check", "c", "--json", "--timeout", "10000"], { env: pathEnv })).json().servers[0];
    const mineStarted = readLog(log).some((e) => e.event === "start");
    const mineArgv = (readLog(log).find((e) => e.event === "start") || {}).argv;
    return { label: c.label, binary: statusWord(l.servers.c), words: l.servers.c, binaryStarted, mineStarted, ok: r.ok, binaryArgv, mineArgv };
  }));
  t.diagnostic(`${rows.length} ways to write a command: ${rows.map((r) => `${r.label}=${r.binaryStarted ? "starts" : "does not"}`).join("; ")}`);
  t.diagnostic(`what claude mcp list says: ${rows.map((r) => `${r.label}: ${r.words}`).join(" | ")}`);
  const { problems, soft } = collector();
  for (const r of rows) {
    soft(() => assert.equal(r.mineStarted, r.binaryStarted, `${r.label}: the binary ${r.binaryStarted ? "starts" : "does not start"} it, the tool ${r.mineStarted ? "starts" : "does not start"} it`));
    soft(() => assert.equal(r.ok, r.binary === "connected", `${r.label}: the binary says ${r.binary}`));
    soft(() => assert.deepEqual(r.mineArgv, r.binaryArgv, `${r.label}: the arguments`));
  }
  assert.deepEqual(problems, [], "the tool starts a server in exactly the cases the binary does");
});

// ---- (d) check and why against servers that answer and servers that do not -----------------------------------------------------

const MODES = [
  ["ok", ["ok"], {}, true, null],
  ["paged", ["paged"], {}, true, null],
  ["tools-only", ["tools-only"], {}, true, null],
  ["banner", ["banner"], {}, true, null],
  ["slow", ["slow"], { FMCP_DELAY_MS: "700" }, true, null],
  ["early-exit", ["early-exit"], {}, false, "early-exit"],
  ["garbage", ["garbage"], {}, false, "non-json-stdout"],
  ["sleep", ["sleep"], {}, false, "timeout"],
  ["silent", ["silent"], {}, false, "timeout"],
  ["init-error", ["init-error"], {}, false, "handshake-error"],
];

test("check and why against the real binary's verdicts: servers that answer, print a banner, print garbage, exit, sleep, stay silent or refuse", { skip: skip(), timeout: 600000 }, async (t) => {
  const sb = sandbox("modes");
  const log = path.join(sb.root, "fmcp.jsonl");
  const servers = Object.fromEntries(MODES.map(([name, args, env]) => [name, { command: process.execPath, args: [SERVER, "serve", ...args], env: { FMCP_LOG: log, ...env } }]));
  servers.missing = { command: "definitely-not-a-command-xyz", args: ["x"] };
  servers.needsvar = { command: process.execPath, args: [SERVER, "serve", "early-exit", "--key=${UNSET_KEY_FOR_TEST}"] };
  patchClaudeJson(sb, { mcpServers: servers });
  // The servers that fail by being silent are given a short time; the others are given plenty, so that a busy machine
  // (a CI runner, two suites at once) cannot turn a server that answers into one that does not.
  const SHORT = 2500;
  const timeoutOf = (n) => (MODES.some(([name, , , , cause]) => name === n && (cause === "timeout" || cause === "non-json-stdout")) ? SHORT : 20000);
  const env = { MCP_TIMEOUT: "8000" };
  const list = await claudeList(sb, env);
  const binaryPids = [...new Set(readLog(log).map((e) => e.pid))];
  const byN = {};
  const why = {};
  await Promise.all(Object.keys(servers).map(async (n) => {
    const t = String(timeoutOf(n));
    byN[n] = (await mine(sb, ["check", n, "--json", "--timeout", t], { env })).json().servers[0];
    why[n] = (await mine(sb, ["why", n, "--json", "--timeout", t], { env })).json();
  }));
  const rows = [];
  const { problems, soft } = collector();
  for (const n of Object.keys(servers)) {
    const binary = statusWord(list.servers[n]);
    rows.push(`${n}: binary ${binary} / tool ${byN[n].ok ? "answered" : "failed"} / cause ${why[n].cause}`);
    soft(() => assert.equal(byN[n].ok, binary === "connected", `${n}: the binary says "${list.servers[n]}"`));
    soft(() => assert.equal(why[n].ok, binary === "connected", `${n}: why`));
  }
  t.diagnostic(rows.join("; "));
  t.diagnostic(`what claude mcp list says: ${Object.keys(servers).map((n) => `${n}: ${list.servers[n]}`).join(" | ")}`);
  for (const [name, , , , cause] of MODES) if (cause) soft(() => assert.equal(why[name].cause, cause, `${name}: the cause`));
  soft(() => assert.equal(why.missing.cause, "command-not-found"));
  soft(() => assert.equal(why.needsvar.cause, "variable-unset"));
  // the words of the binary for the same failures
  soft(() => assert.match(list.servers["early-exit"], /CONNECTION_CLOSED/));
  soft(() => assert.match(list.servers.missing, /CONNECTION_CLOSED|ENOENT/, "a command that is not there"));
  soft(() => assert.match(list.servers.garbage, /timed out/));
  soft(() => assert.match(list.servers.sleep, /timed out/));
  soft(() => assert.match(list.servers.silent, /timed out/));
  soft(() => assert.match(list.servers["init-error"], /-32603: cannot start: the database is down/));
  soft(() => assert.match(why["init-error"].summary, /-32603: cannot start: the database is down/));
  // the early exit: code and the end of stderr
  soft(() => assert.equal(byN["early-exit"].process.exit.code, 3));
  soft(() => assert.match(byN["early-exit"].process.stderr, /the API_KEY variable is not set/));
  soft(() => assert.match(why["early-exit"].summary, /code 3/));
  // the tools counted
  soft(() => assert.equal(byN.ok.counts.tools, 3));
  soft(() => assert.equal(byN.paged.counts.tools, 3, "pages are followed"));
  soft(() => assert.equal(byN["tools-only"].counts.resources, null));
  soft(() => assert.ok(byN.slow.initialize.ms >= 700, `a slow answer is timed: ${byN.slow.initialize.ms} ms`));
  soft(() => assert.equal(byN.banner.process.nonJsonLines, 1, "the banner line is noticed, and tolerated"));
  soft(() => assert.ok(why.banner.warnings.some((w) => /not JSON-RPC/.test(w))));
  // every process that was started is gone
  const pids = [...new Set(readLog(log).map((e) => e.pid))];
  soft(() => assert.ok(pids.length >= 8));
  const left = await stillRunning(pids, { needle: "fake-mcp-server" });
  soft(() => assert.deepEqual(left.map((pid) => `${pid} (started by ${binaryPids.includes(pid) ? "the binary" : "the tool"}: ${commandLineOf(pid)})`), [], "nothing is left running"));
  assert.deepEqual(problems, [], "the tool and the binary agree on every server");
});

test("a server that never answers is waited for 30 seconds when MCP_TIMEOUT is not set, which is the default `check` assumes", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("deftimeout");
  patchClaudeJson(sb, { mcpServers: { quiet: fake("silent"), ok: fake("ok") } });
  const started = Date.now();
  const out = (await runClaude(sb, null, ["mcp", "list"], { timeout: 120000 })).out;
  assert.match(out, /"quiet" connection timed out after 30000ms/, "the binary gives up after 30,000 ms");
  assert.ok(Date.now() - started >= 29000, "and it took that long");
  const c = (await mine(sb, ["check", "ok", "--json"])).json();
  assert.equal(c.timeoutMs, 30000);
  assert.equal(c.timeoutSource, "default");
});

test("the tools a `-p` run receives are the tools `check` lists, for a server with pages, a tools-only server and a server that prints a banner", { skip: skip(), timeout: 300000 }, async () => {
  const sb = sandbox("counts");
  patchClaudeJson(sb, { mcpServers: { paged: fake("paged"), tools_only: fake("tools-only"), banner: fake("banner") } });
  const { request } = await probeRun(sb);
  const sent = mcpTools(request).map((x) => x.name).sort();
  const c = (await mine(sb, ["check", "--json", "--timeout", "10000"])).json();
  const listed = c.servers.flatMap((s) => s.cost.perTool.map((x) => x.name)).sort();
  assert.deepEqual(listed, sent);
  assert.equal(sent.length, 9);
});

test("the handshake the binary performs over stdio, and the one the tool performs: initialize, the notification, then the three lists", { skip: skip(), timeout: 180000 }, async (t) => {
  const sb = sandbox("handshake");
  const log = path.join(sb.root, "fmcp.jsonl");
  patchClaudeJson(sb, { mcpServers: { x: { command: process.execPath, args: [SERVER, "serve", "ok"], env: { FMCP_LOG: log } } } });
  await probeRun(sb);
  const binary = readLog(log).filter((e) => e.event === "message").map((e) => e.message);
  fs.rmSync(log);
  await mine(sb, ["check", "x", "--timeout", "10000"]);
  const ours = readLog(log).filter((e) => e.event === "message").map((e) => e.message);
  const init = (list) => list.find((m) => m.method === "initialize");
  assert.equal(init(binary).params.protocolVersion, "2025-11-25", "the protocol version the binary asks for");
  assert.equal(init(ours).params.protocolVersion, init(binary).params.protocolVersion, "and the tool asks for the same");
  assert.equal(init(binary).params.clientInfo.name, "claude-code");
  assert.equal(init(ours).params.clientInfo.name, "claude-mcp-check");
  assert.deepEqual(Object.keys(init(binary).params.capabilities).sort(), ["elicitation", "roots"], "the binary offers roots and elicitation; the tool offers nothing, so a server has nothing to ask of it");
  assert.deepEqual(init(ours).params.capabilities, {});
  const after = (list) => list.slice(list.findIndex((m) => m.method === "initialize") + 1).map((m) => m.method);
  assert.equal(after(binary)[0], "notifications/initialized");
  assert.equal(after(ours)[0], "notifications/initialized");
  assert.deepEqual(after(binary).slice(1).sort(), ["prompts/list", "resources/list", "tools/list"]);
  assert.deepEqual(after(ours).slice(1).sort(), ["prompts/list", "resources/list", "tools/list"]);
  t.diagnostic(`before initialize the binary sent: ${binary.slice(0, binary.findIndex((m) => m.method === "initialize")).map((m) => m.method).join(", ") || "nothing"}`);
});

// ---- HTTP -----------------------------------------------------------------------------------------------------------------------

test("remote servers: `check` and `claude mcp list` agree on what answers, what needs a login and what does not", { skip: skip(), timeout: 300000 }, async () => {
  const TOOLS = [{ name: "ping", description: "Ping.", inputSchema: { type: "object", properties: {} } }];
  const result = (m) => (m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fake", version: "1" } } : m.method === "tools/list" ? { tools: TOOLS } : {});
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let m = null;
      try { m = JSON.parse(body); } catch { /* none */ }
      const route = req.url.split("?")[0];
      const json = (code, obj, h = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(obj)); };
      if (route === "/401") return json(401, { error: "no" }, { "www-authenticate": 'Bearer realm="x"' });
      if (route === "/403") return json(403, { error: "no" });
      if (route === "/404") { res.writeHead(404); return res.end("nope"); }
      if (route === "/405") { res.writeHead(405); return res.end(); }
      if (route === "/500") { res.writeHead(500); return res.end("boom"); }
      if (route === "/ok" || route === "/sse") {
        if (req.method === "GET") { res.writeHead(405); return res.end(); }
        if (!m) return json(400, {});
        if (m.id === undefined) { res.writeHead(202); return res.end(); }
        const reply = { jsonrpc: "2.0", id: m.id, result: result(m) };
        if (route === "/sse") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`); return res.end(); }
        return json(200, reply, { "mcp-session-id": "s1" });
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const sb = sandbox("http");
    const servers = {};
    for (const p of ["ok", "sse", "401", "403", "404", "405", "500"]) servers[`h${p}`] = { type: "http", url: `${base}/${p}` };
    servers.refused = { type: "http", url: "http://127.0.0.1:1/mcp" };
    patchClaudeJson(sb, { mcpServers: servers });
    const list = await claudeList(sb);
    const c = byName((await mine(sb, ["check", "--json", "--timeout", "10000"])).json());
    assert.equal(statusWord(list.servers.hok), "connected");
    assert.equal(c.hok.ok, true);
    assert.equal(c.hok.counts.tools, 1);
    assert.equal(statusWord(list.servers.hsse), "connected");
    assert.equal(c.hsse.ok, true, "an answer as an event stream");
    assert.equal(c.h403.http.outcome, "needs-login");
    assert.equal(statusWord(list.servers.h403), "auth", "the binary says Needs authentication for a 403");
    assert.equal(c.h401.http.outcome, "needs-login");
    assert.match(list.servers.h401, /Failed|Needs/, "the binary starts an OAuth discovery on a 401");
    assert.match(list.servers.h401, /Dynamic Client Registration rejected \(HTTP 404\)/, "and it fails there, because the fake server has no OAuth discovery");
    assert.equal(c.h404.http.outcome, "not-found");
    assert.match(list.servers.h404, /endpoint not found/);
    assert.equal(c.h405.http.outcome, "wrong-transport");
    assert.match(list.servers.h405, /HTTP 405/);
    assert.equal(c.h500.http.outcome, "server-error");
    assert.match(list.servers.h500, /HTTP 500/);
    assert.equal(c.refused.http.outcome, "unreachable");
    assert.match(list.servers.refused, /ECONNREFUSED/);
    const why401 = (await mine(sb, ["why", "h401", "--json", "--timeout", "10000"])).json();
    assert.equal(why401.cause, "needs-login");
    assert.equal((await mine(sb, ["why", "h403", "--json", "--timeout", "10000"])).json().cause, "needs-login");
  } finally { server.close(); }
});

// ---- (e) toggle -----------------------------------------------------------------------------------------------------------------

test("toggle --off and --on for a .mcp.json server: the settings file changes in one list only, and the binary honours it", { skip: skip(), timeout: 300000 }, async () => {
  const sb = sandbox("toggle");
  put(sb.mcpJson, { mcpServers: { shared: fake("ok"), other: fake("ok") } });
  const original = '{\n  "model": "m-local",\n  "permissions": {\n    "allow": ["Bash(ls)"]\n  },\n  "enabledMcpjsonServers": ["shared"]\n}\n';
  put(sb.local, original);
  assert.equal(statusWord((await claudeList(sb)).servers.shared), "connected");
  const off = await mine(sb, ["toggle", "shared", "--off", "--json"]);
  assert.equal(off.code, 0, off.out + off.err);
  const afterOff = fs.readFileSync(sb.local, "utf8");
  const parsed = JSON.parse(afterOff);
  assert.deepEqual(parsed.disabledMcpjsonServers, ["shared"]);
  assert.deepEqual({ ...parsed, disabledMcpjsonServers: undefined }, { ...JSON.parse(original), disabledMcpjsonServers: undefined }, "nothing else changed");
  assert.equal((await claudeGet(sb, "shared")).status, "rejected");
  assert.equal((await claudeList(sb)).servers.shared, undefined, "claude mcp list leaves a rejected server out");
  const { init } = await probeRun(sb);
  assert.ok(!init.some((s) => s.name === "shared"), "-p does not load it");
  const on = await mine(sb, ["toggle", "shared", "--on", "--json"]);
  assert.equal(on.code, 0, on.out + on.err);
  assert.equal(fs.readFileSync(sb.local, "utf8"), original, "off and on again leave the file byte for byte as it was");
  assert.equal(statusWord((await claudeList(sb)).servers.shared), "connected");
  assert.equal(fs.readdirSync(path.dirname(sb.local)).filter((n) => n.includes(".bak-mcp-check-")).length, 2, "one backup per change");
  // a server nobody approved: --on approves it, --off then rejects it
  assert.equal((await claudeGet(sb, "other")).status, "pending");
  assert.equal((await mine(sb, ["toggle", "other", "--on"])).code, 0);
  assert.equal((await claudeGet(sb, "other")).status, "connected");
  assert.equal((await mine(sb, ["toggle", "other", "--off"])).code, 0);
  assert.equal((await claudeGet(sb, "other")).status, "rejected");
  // restore puts the previous file back
  assert.equal((await mine(sb, ["restore"])).code, 0);
  assert.equal((await claudeGet(sb, "other")).status, "connected");
});

test("toggle for a server in ~/.claude.json: disabledMcpServers of the project, which the binary shows as Disabled for this project", { skip: skip(), timeout: 300000 }, async () => {
  const sb = sandbox("toggle2");
  patchClaudeJson(sb, { mcpServers: { u1: fake("ok") }, someSetting: { keep: [1, 2, 3] } }, { mcpServers: { l1: fake("ok") } });
  await claudeList(sb); // the binary adds its own entries to a new .claude.json the first time it runs: take the file as it is after that
  const before = fs.readFileSync(sb.claudeJson, "utf8");
  for (const name of ["u1", "l1"]) {
    const r = await mine(sb, ["toggle", name, "--off", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
  }
  const after = JSON.parse(fs.readFileSync(sb.claudeJson, "utf8"));
  assert.deepEqual(after.projects[sb.key].disabledMcpServers, ["u1", "l1"]);
  assert.deepEqual(after.someSetting, { keep: [1, 2, 3] }, "the rest of the file is where it was");
  const l = await claudeList(sb);
  assert.equal(statusWord(l.servers.u1), "disabled");
  assert.equal(statusWord(l.servers.l1), "disabled");
  assert.equal((await claudeGet(sb, "u1")).status, "disabled");
  assert.equal(byName(await showOf(sb)).u1.state, "disabled");
  // off and on again, with nothing else touching the file: the same bytes
  for (const name of ["u1", "l1"]) assert.equal((await mine(sb, ["toggle", name, "--on"])).code, 0);
  assert.equal(fs.readFileSync(sb.claudeJson, "utf8"), before, "off and on again leave ~/.claude.json byte for byte as it was");
  assert.equal(statusWord((await claudeList(sb)).servers.u1), "connected");
  // a run of claude -p sees the same
  for (const name of ["u1", "l1"]) assert.equal((await mine(sb, ["toggle", name, "--off"])).code, 0);
  const { init, request } = await probeRun(sb);
  assert.deepEqual(init.map((s) => `${s.name}:${s.status}`).sort(), ["l1:disabled", "u1:disabled"]);
  assert.equal(mcpTools(request).length, 0);
});

test("toggle in a world whose .claude.json knows nothing of the project yet: the binary reads the entry the tool makes", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("toggle3", { trusted: false });
  patchClaudeJson(sb, { mcpServers: { u1: fake("ok") } });
  assert.equal((await mine(sb, ["toggle", "u1", "--off"])).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.claudeJson, "utf8")).projects[sb.key], { disabledMcpServers: ["u1"] });
  assert.equal(statusWord((await claudeList(sb)).servers.u1), "disabled");
});

test("a name the project switched off stays off whole: the definition of another scope does not take over", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("swfb");
  patchClaudeJson(sb, { mcpServers: { dup: echoOk("user") } }, { mcpServers: { dup: echoOk("local") }, disabledMcpServers: ["dup"] });
  assert.equal(statusWord((await claudeList(sb)).servers.dup), "disabled");
  const get = await claudeGet(sb, "dup");
  assert.equal(get.status, "disabled");
  assert.match(get.scope, /^Local config/, "and it is the local definition that is listed");
  const { init, request } = await probeRun(sb);
  assert.deepEqual(init, [{ name: "dup", status: "disabled", source: "local" }]);
  assert.equal(mcpTools(request).length, 0, "no tool of either definition");
  const doc = byName(await showOf(sb)).dup;
  assert.equal(doc.state, "disabled");
  assert.equal(doc.scope, "local");
});

test("toggle for a plugin's server: the project's list switches it off, and the binary shows it as Disabled for this project", { skip: skip(), timeout: 300000 }, async () => {
  const sb = sandbox("toggle5");
  const mkt = localMarketplace(sb, { servers: { pserv: fake("ok") } });
  for (const args of [["plugin", "marketplace", "add", mkt], ["plugin", "install", "myplug@local-test"]]) assert.equal((await runClaude(sb, null, args, { timeout: 100000 })).code, 0);
  const name = "plugin:myplug:pserv";
  assert.equal(statusWord((await claudeList(sb)).servers[name]), "connected");
  assert.equal((await mine(sb, ["toggle", name, "--off"])).code, 0);
  assert.equal(statusWord((await claudeList(sb)).servers[name]), "disabled");
  assert.equal(byName(await showOf(sb))[name].state, "disabled");
  assert.equal((await mine(sb, ["toggle", name, "--on"])).code, 0);
  assert.equal(statusWord((await claudeList(sb)).servers[name]), "connected");
});

test("toggle while a session is running: the edit survives the session's own writes, and the lock is released", { skip: skip(), timeout: 300000 }, async () => {
  const sb = sandbox("toggle4");
  patchClaudeJson(sb, { mcpServers: { slow: fake("sleep"), u1: fake("ok") } });
  const api = await fakeApi();
  try {
    const running = runClaude(sb, api, ["-p", "PROBE-MAIN hello", "--output-format", "json"], { env: { MCP_TIMEOUT: "6000" } });
    await new Promise((r) => setTimeout(r, 1200));
    const r = await mine(sb, ["toggle", "u1", "--off", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    await running;
  } finally { await api.close(); }
  const after = JSON.parse(fs.readFileSync(sb.claudeJson, "utf8"));
  assert.deepEqual(after.projects[sb.key].disabledMcpServers, ["u1"], "the session's writes did not undo it");
  assert.ok(after.firstStartTime || after.numStartups !== undefined || Object.keys(after).length > 3, "and the session's own entries are there");
  assert.ok(!fs.existsSync(`${sb.claudeJson}.lock`), "the lock is released");
});

// ---- policy ---------------------------------------------------------------------------------------------------------------------

test("allowedMcpServers and deniedMcpServers: the tool's `blocked` is the binary's vanishing, for the lists the documentation describes", { skip: skip(), timeout: 600000 }, async (t) => {
  const CMD = [process.execPath, SERVER, "serve", "ok", "x"];
  const servers = () => ({ d1: { command: process.execPath, args: [SERVER, "serve", "ok", "x"] }, d2: { command: process.execPath, args: [SERVER, "serve", "ok", "x"] }, web: { type: "http", url: "https://example.invalid/mcp" } });
  const cases = [
    ["deny serverName", { deniedMcpServers: [{ serverName: "d1" }] }, ["d1"]],
    ["deny serverCommand", { deniedMcpServers: [{ serverCommand: CMD }] }, ["d1", "d2"]],
    ["deny serverCommand with other arguments", { deniedMcpServers: [{ serverCommand: CMD.slice(0, 4) }] }, []],
    ["deny serverUrl", { deniedMcpServers: [{ serverUrl: "https://example.invalid/*" }] }, ["web"]],
    ["deny serverUrl, another host", { deniedMcpServers: [{ serverUrl: "https://elsewhere.invalid/*" }] }, []],
    ["allow serverName d1", { allowedMcpServers: [{ serverName: "d1" }] }, ["d2", "web"]],
    ["allow []", { allowedMcpServers: [] }, ["d1", "d2", "web"]],
    ["allow serverCommand only", { allowedMcpServers: [{ serverCommand: CMD }] }, ["web"]],
    ["allow serverUrl only", { allowedMcpServers: [{ serverUrl: "https://example.invalid/*" }] }, ["d1", "d2"]],
    ["allow a name and a command", { allowedMcpServers: [{ serverName: "web" }, { serverCommand: CMD.slice(0, 4) }] }, ["d1", "d2"]],
    ["deny wins over allow", { allowedMcpServers: [{ serverName: "d1" }, { serverName: "d2" }], deniedMcpServers: [{ serverName: "d2" }] }, ["d2", "web"]],
    ["a plain string is not an entry", { deniedMcpServers: ["d1"] }, []],
  ];
  const rows = await Promise.all(cases.map(async ([label, settings, blocked]) => {
    const sb = sandbox("policy");
    patchClaudeJson(sb, { mcpServers: servers() });
    put(sb.user, settings);
    const l = await claudeList(sb);
    const doc = byName(await showOf(sb));
    const binaryGone = Object.keys(servers()).filter((n) => l.servers[n] === undefined);
    const mineBlocked = Object.keys(doc).filter((n) => doc[n].state === "blocked");
    return { label, blocked, binaryGone, mineBlocked };
  }));
  for (const r of rows) {
    assert.deepEqual(r.binaryGone.sort(), r.blocked.slice().sort(), `${r.label}: what the binary does not list`);
    assert.deepEqual(r.mineBlocked.sort(), r.blocked.slice().sort(), `${r.label}: what the tool says is blocked`);
  }
  t.diagnostic(`${rows.length} lists, the tool and the binary agreed on each`);
});

test("lists in the project and local settings files count too, and a blocked name vanishes whole (no fallback to another scope)", { skip: skip(), timeout: 300000 }, async () => {
  for (const where of ["project", "local"]) {
    const sb = sandbox("policy2");
    patchClaudeJson(sb, { mcpServers: { dup: fake("ok", { args: ["user"] }) } }, { mcpServers: { dup: fake("ok", { args: ["local"] }) } });
    put(sb[where], { deniedMcpServers: [{ serverCommand: [process.execPath, SERVER, "serve", "ok", "local"] }] });
    assert.equal((await claudeList(sb)).servers.dup, undefined, `${where}: the binary vanishes the name`);
    assert.equal(byName(await showOf(sb)).dup.state, "blocked", `${where}: the tool`);
  }
});

// ---- names that become the same tool prefix ----------------------------------------------------------------------------------

test("two names that become the same tool prefix: the tools of one server reach the model, the one that connects first, and the tool names the whole group", { skip: skip(), timeout: 300000 }, async (t) => {
  const mark = (request) => markOf(request, "my_server");
  const cases = [
    ["three user names", (sb) => patchClaudeJson(sb, { mcpServers: { "my.server": echoOk("dot"), my_server: echoOk("underscore"), "my server": echoOk("space") } }), ["dot", "underscore", "space"], ["my.server", "my_server", "my server"]],
    ["user and local", (sb) => patchClaudeJson(sb, { mcpServers: { "my.server": echoOk("user") } }, { mcpServers: { my_server: echoOk("local") } }), ["user", "local"], ["my.server", "my_server"]],
    ["project and local", (sb) => { patchClaudeJson(sb, {}, { mcpServers: { my_server: echoOk("local") } }); put(sb.mcpJson, { mcpServers: { "my.server": echoOk("project") } }); put(sb.local, { enableAllProjectMcpServers: true }); }, ["project", "local"], ["my.server", "my_server"]],
  ];
  for (const [label, setup, marks, names] of cases) {
    const sb = sandbox("coll");
    setup(sb);
    const { request, init } = await probeRun(sb);
    assert.ok(init.length >= 2 && init.every((s) => s.status === "connected"), `${label}: every server of the group shows as connected (${JSON.stringify(init)})`);
    assert.ok(marks.includes(mark(request)), `${label}: one of the servers has its tools in the request (${mark(request)})`);
    assert.equal(mcpTools(request).filter((x) => x.name.startsWith("mcp__my_server__")).length, 4, `${label}: and only one server's four tools`);
    const doc = await showOf(sb);
    assert.deepEqual(doc.collisions.map((c) => [c.prefix, [...c.names].sort()]), [["mcp__my_server__", [...names].sort()]], label);
    const found = (await mine(sb, ["lint", "--json"])).json().findings.filter((f) => f.id === "name-collision");
    assert.equal(found.length, 1, `${label}: lint says it once`);
  }
  // a slower server loses, wherever it stands in the file
  const sb = sandbox("coll2");
  patchClaudeJson(sb, { mcpServers: { "my.server": { command: process.execPath, args: [SERVER, "serve", "slow", "first-but-slow"], env: { FMCP_ECHO: "NOPE", FMCP_DELAY_MS: "1500" } }, my_server: echoOk("second-and-quick") } });
  const { request } = await probeRun(sb);
  assert.equal(mark(request), "second-and-quick", "the server that connects first keeps the prefix");
  t.diagnostic("the tools of the server that connected first were in the request; with equal servers the first of the file won in most runs and not in all");
});

// ---- lint: the diagnostics of the binary -----------------------------------------------------------------------------------------

test("the binary's own diagnostics for a file: not valid JSON, `servers` for `mcpServers`, a skipped entry; lint finds each, and the conflicting-scopes warning", { skip: skip(), timeout: 300000 }, async () => {
  const files = {
    "invalid-json": ['{\n  // note\n  "mcpServers": {}\n}\n', /not a valid JSON/],
    "wrong-top-key": [JSON.stringify({ servers: { x: fake("ok") } }), /Missing "mcpServers" — found "servers"/],
    "servers-not-object": [JSON.stringify({ mcpServers: [fake("ok")] }), /expected record, received array/],
    "skipped-server": [JSON.stringify({ mcpServers: { x: { args: ["a"] } } }), /Skipped — invalid MCP server config for "x"/],
  };
  for (const [id, [text, binaryText]] of Object.entries(files)) {
    const sb = sandbox("lintfile");
    put(sb.mcpJson, text);
    const out = (await runClaude(sb, null, ["mcp", "list"])).out;
    assert.match(out, binaryText, `${id}: the binary says`);
    const findings = (await mine(sb, ["lint", "--json"])).json().findings;
    assert.ok(findings.some((f) => f.id === id), `${id}: lint finds it (${findings.map((f) => f.id)})`);
  }
  // an empty .mcp.json is fine
  const sb = sandbox("lintempty");
  put(sb.mcpJson, "");
  assert.equal((await mine(sb, ["lint", "--json"])).json().findings.length, 0);
  // the conflict that the binary warns about
  const sc = sandbox("conflict");
  patchClaudeJson(sc, { mcpServers: { dup: echoOk("user") } }, { mcpServers: { dup: echoOk("local") } });
  const list = await claudeList(sc);
  assert.ok(list.warnings.some((w) => /Conflicting scopes|defined in multiple scopes with different endpoints/.test(w)) || /Conflicting scopes/.test(list.raw));
  assert.equal((await mine(sc, ["lint", "--json"])).json().findings.find((f) => f.id === "duplicate-name").severity, "warning");
  // the same endpoint twice: a note, and no warning from the binary
  const ss = sandbox("conflict2");
  patchClaudeJson(ss, { mcpServers: { dup: echoOk("same") } }, { mcpServers: { dup: echoOk("same") } });
  assert.ok(!/Conflicting scopes/.test((await claudeList(ss)).raw));
  assert.equal((await mine(ss, ["lint", "--json"])).json().findings.find((f) => f.id === "duplicate-name").severity, "note");
});

// The rows of test/lint-table.mjs that say what the binary shows: the same files in a sandbox, put to `claude mcp list`.
const sandboxAdapter = (sb) => ({
  claudeJson: (top, project) => patchClaudeJson(sb, top, project),
  mcpJson: (v) => put(sb.mcpJson, v),
  user: (v) => put(sb.user, v),
  project: (v) => put(sb.project, v),
  local: (v) => put(sb.local, v),
  managedSettings: (v) => put(path.join(sb.managed, "managed-settings.json"), v),
  write: (file, v) => put(file, v),
  mcpJsonFile: sb.mcpJson, localFile: sb.local, base: sb.root, work: sb.work,
  mcpJsonAbove: (v) => put(path.join(sb.root, ".mcp.json"), v),
});

test("every row of the lint table that says what the binary shows: `claude mcp list` says it, and lint finds what the row expects", { skip: skip(), timeout: 600000 }, async (t) => {
  const rows = LINT_ROWS.filter((r) => r.binary);
  assert.ok(rows.length >= 25, `${rows.length} rows`);
  const results = [];
  for (let i = 0; i < rows.length; i += 6) {
    results.push(...await Promise.all(rows.slice(i, i + 6).map(async (row, j) => {
      const sb = sandbox(`lintrow${i + j}`);
      row.setup(sandboxAdapter(sb));
      const list = await claudeList(sb);
      const found = (await mine(sb, ["lint", "--json"])).json().findings;
      return { row, list, found };
    })));
  }
  for (const { row, list, found } of results) {
    assert.deepEqual(found.map((f) => f.id).sort(), [...row.expect].sort(), `${row.name}: lint finds what the table expects`);
    for (const [id, severity] of Object.entries(row.severity || {})) assert.equal(found.find((f) => f.id === id).severity, severity, `${row.name}: ${id}`);
    const b = row.binary;
    if (b.since && !atLeast(...b.since)) continue;
    if (b.listHas) assert.match(list.raw, b.listHas, `${row.name}: the binary says`);
    if (b.listLacks) assert.doesNotMatch(list.raw, b.listLacks, `${row.name}: the binary does not say`);
    for (const [name, want] of Object.entries(b.status || {})) assert.equal(statusWord(list.servers[name]), want, `${row.name}: ${name}`);
    for (const name of b.absent || []) assert.equal(list.servers[name], undefined, `${row.name}: ${name} is not listed`);
  }
  t.diagnostic(`${rows.length} of the ${LINT_ROWS.length} rows of the lint table put to \`claude mcp list\`: the binary says what the table says, and lint finds what the table expects`);
});

test("a single name written as a plain string where the list belongs: the effect depends on the version, and lint says so", { skip: skip(), timeout: 300000 }, async (t) => {
  const sb = sandbox("string");
  put(sb.mcpJson, { mcpServers: { shared: fake("ok"), other: fake("ok") } });
  put(sb.local, { model: "m-from-local", enabledMcpjsonServers: "shared" });
  const { request } = await probeRun(sb);
  const modelRead = request.model === "m-from-local";
  const approved = statusWord((await claudeList(sb)).servers.shared) === "connected";
  const f = (await mine(sb, ["lint", "--json"])).json().findings.find((x) => x.id === "list-is-string");
  assert.ok(f, "lint finds the string");
  assert.match(f.does, /2\.1\.299/);
  if (atLeast(2, 1, 299)) {
    assert.ok(modelRead, "from 2.1.299 the file is read");
    assert.ok(approved, "and the name approves the server, as a list of one");
  } else {
    assert.ok(!modelRead, "before 2.1.299 the whole file is ignored");
    assert.ok(!approved);
  }
  t.diagnostic(`Claude Code ${claudeInfo().version}: a plain string in enabledMcpjsonServers ${modelRead ? "was read" : "made Claude Code ignore the whole file"}${approved ? " and approved the server" : ""}`);
});

test("the older settings of the same family: a list key of the wrong shape in .claude.json does not stop the binary", { skip: skip(), timeout: 120000 }, async () => {
  const sb = sandbox("badlist");
  patchClaudeJson(sb, { mcpServers: { u1: fake("ok") } }, { disabledMcpServers: "u1" });
  const l = await claudeList(sb);
  assert.ok(l.servers.u1, "the binary starts and lists the server");
  const f = (await mine(sb, ["lint", "--json"])).json().findings.find((x) => x.id === "list-is-not-a-list");
  assert.ok(f);
  assert.match(f.message, /disabledMcpServers/);
});

// ---- the plugin's skill -----------------------------------------------------------------------------------------------------------

test("the user-only skill adds nothing to a request that does not use it: no tool, no skill list entry, no word of it", { skip: skip(), timeout: 180000 }, async (t) => {
  const sb = sandbox("always");
  put(sb.user, { model: "m-probe" });
  const plain = (r) => JSON.stringify(r).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g, "<time>");
  const without = await probeRun(sb);
  const withPlugin = await probeRun(sb, { args: ["--plugin-dir", ROOT] });
  const a = plain(without.request);
  const b = plain(withPlugin.request);
  assert.ok(!b.includes("mcp-check"), "nothing of the plugin is in the request");
  assert.ok(!b.includes("Check MCP servers"), "not even the skill's description");
  assert.equal(JSON.stringify(withPlugin.request.tools), JSON.stringify(without.request.tools), "the tool list is the same");
  assert.equal(b.length, a.length, "the request has the same size with the plugin loaded");
  t.diagnostic(`plain prompt: ${a.length} characters without the plugin, ${b.length} with it; the string mcp-check appears ${b.split("mcp-check").length - 1} times`);
});

test("/mcp-check:check hands the model the lint report for the project, whichever way Claude Code runs the command line, and what it costs is measured", { skip: skip(), timeout: 240000 }, async (t) => {
  const sb = sandbox("skill");
  patchClaudeJson(sb, { mcpServers: { u1: fake("ok") } });
  put(sb.mcpJson, { mcpServers: { pending: fake("ok"), broken: { command: "no-such-command-xyz" }, vars: { command: process.execPath, args: [SERVER, "serve", "ok", "--key=${UNSET_ONE}"] } } });
  const api = await fakeApi();
  try {
    const r = await runClaude(sb, api, ["-p", "/mcp-check:check", "--plugin-dir", ROOT, "--output-format", "json"]);
    assert.equal(r.code, 0, r.err);
    const req = api.requests.find((x) => textBlocks(x).some((b) => b.startsWith("Base directory for this skill")));
    assert.ok(req, "the skill reached the model, although the lint found problems (its command must not fail)");
    const blocks = textBlocks(req);
    const skillText = blocks.find((b) => b.startsWith("Base directory for this skill"));
    const commandText = blocks.find((b) => b.includes("<command-name>/mcp-check:check</command-name>"));
    if (/run this first/.test(skillText)) {
      assert.ok(skillText.includes(`claude-mcp-check.mjs" lint --project "${fwd(sb.work)}" --markdown`), `the command, with the plugin folder and the project folder filled in:\n${skillText}`);
    } else {
      assert.match(skillText, /## mcp-check lint:/);
      assert.match(skillText, /- WARNING `unapproved`/);
      assert.match(skillText, /- WARNING `command-not-found`/);
      assert.match(skillText, /- WARNING `variable-unset`/);
    }
    assert.match(skillText, /At most 10 lines: each problem with its file and line, and the fix\./);
    if (!/run this first/.test(skillText)) assert.ok(skillText.indexOf("## mcp-check lint:") < skillText.indexOf("At most 10 lines"), "the report comes first and the instruction after it");
    assert.ok(!skillText.includes("${CLAUDE_"), "no variable is left unexpanded");
    const chars = skillText.length + (commandText ? commandText.length : 0);
    t.diagnostic(`/mcp-check:check on a project with 3 findings: ${skillText.length} characters in the skill block${commandText ? ` and ${commandText.length} in the command block` : ""}, about ${Math.round(chars / 4)} tokens by characters / 4`);
    assert.ok(chars < 4000, `${chars} characters`);
  } finally { await api.close(); }
});

test("/mcp-check:check on a project with nothing wrong says so in one line", { skip: skip(), timeout: 120000 }, async () => {
  const sb = sandbox("skill-clean");
  put(sb.user, { model: "m-probe" });
  const api = await fakeApi();
  try {
    await runClaude(sb, api, ["-p", "/mcp-check:check", "--plugin-dir", ROOT, "--output-format", "json"]);
    const req = api.requests.find((x) => textBlocks(x).some((b) => b.startsWith("Base directory for this skill"))) || api.requests[0];
    const skillText = textBlocks(req).find((b) => b.startsWith("Base directory for this skill"));
    assert.ok(skillText);
    if (!/run this first/.test(skillText)) assert.match(skillText, /No findings\./);
  } finally { await api.close(); }
});

test("a skill whose command line exits 1 never reaches the model, which is why `lint --markdown` exits 0 whatever it finds", { skip: skip(), timeout: 180000 }, async () => {
  const copy = path.join(sandbox("exit1copy").root, "plugin");
  for (const item of ["bin", "src", "skills", ".claude-plugin", "package.json"]) fs.cpSync(path.join(ROOT, item), path.join(copy, item), { recursive: true });
  const skillFile = path.join(copy, "skills", "check", "SKILL.md");
  const text = fs.readFileSync(skillFile, "utf8");
  assert.ok(text.includes(" --markdown`"), "the command line of the skill ends with --markdown");
  fs.writeFileSync(skillFile, text.replace(" --markdown`", "`")); // the plain report exits 1 when it finds something
  const sb = sandbox("exit1");
  patchClaudeJson(sb, { mcpServers: { broken: { command: "no-such-command-xyz" } } });
  const api = await fakeApi();
  try {
    await runClaude(sb, api, ["-p", "/mcp-check:check", "--plugin-dir", copy, "--output-format", "json"]);
    assert.ok(!api.requests.some((x) => textBlocks(x).some((b) => b.startsWith("Base directory for this skill"))), "the skill did not reach the model");
    assert.ok(!api.requests.some((x) => JSON.stringify(x.messages).includes("mcp-check lint")), "nor did a report");
  } finally { await api.close(); }
});

test("the worst report the skill can hand over is capped, and its size is measured", { skip: skip(), timeout: 180000 }, async (t) => {
  const sb = sandbox("skill-worst");
  const servers = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`averyveryverylongservername${i}`, { command: `no-such-command-with-a-very-long-name-${"x".repeat(120)}-${i}`, args: ["${UNSET_VARIABLE_WITH_A_LONG_NAME_" + i + "}"] }]));
  patchClaudeJson(sb, { mcpServers: servers });
  const api = await fakeApi();
  try {
    await runClaude(sb, api, ["-p", "/mcp-check:check", "--plugin-dir", ROOT, "--output-format", "json"]);
    const req = api.requests.find((x) => textBlocks(x).some((b) => b.startsWith("Base directory for this skill"))) || api.requests[0];
    const skillText = textBlocks(req).find((b) => b.startsWith("Base directory for this skill"));
    assert.ok(skillText);
    if (/run this first/.test(skillText)) return;
    const commandText = textBlocks(req).find((b) => b.includes("<command-name>/mcp-check:check</command-name>"));
    const chars = skillText.length + (commandText ? commandText.length : 0);
    t.diagnostic(`worst case built here: ${skillText.length} characters in the skill block${commandText ? ` and ${commandText.length} in the command block` : ""}, ${skillText.split("\n").length} lines, about ${Math.round(chars / 4)} tokens by characters / 4`);
    assert.ok(skillText.split("\n").length <= 24, `${skillText.split("\n").length} lines`);
    assert.match(skillText, /- \.\.\. and \d+ more \(run `claude-mcp-check lint`\)/);
  } finally { await api.close(); }
});

test("the skill's allowed-tools let the model run the command with no prompt (permission mode default): the Bash tool, and on Windows the PowerShell tool", { skip: skip(), timeout: 240000 }, async () => {
  for (const [tool, env] of [["Bash", {}], ...(IS_WIN ? [["PowerShell", { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", CLAUDE_CODE_GIT_BASH_PATH: "C:/nonexistent/bash.exe" }]] : [])]) {
    const sb = sandbox(`allowed-${tool}`);
    patchClaudeJson(sb, { mcpServers: { u1: fake("ok") } });
    const command = `node "${fwd(ROOT)}/bin/claude-mcp-check.mjs" lint --project "${fwd(sb.work)}" --markdown`;
    const api = await fakeApi({ tool, input: { command, description: "Run the lint" } });
    try {
      const r = await runClaude(sb, api, ["-p", "/mcp-check:check PROBE-MAIN", "--plugin-dir", ROOT, "--output-format", "json", "--permission-mode", "default", "--max-turns", "3"], { env });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(r.result.permission_denials, [], `${tool}: nothing was refused`);
      const seen = new Map();
      for (const b of api.requests.flatMap((rq) => rq.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))) if (b.type === "tool_result") seen.set(b.tool_use_id, b);
      assert.equal(seen.size, 1, `${tool}: the command ran`);
      assert.match(JSON.stringify([...seen.values()][0].content), /## mcp-check lint/, `${tool}: and printed the report`);
    } finally { await api.close(); }
  }
});

test("installed from a marketplace, the plugin's own cost projection is small and its skill is one user-only skill", { skip: skip(), timeout: 300000 }, async (t) => {
  const sb = sandbox("details");
  const mkt = path.join(sb.root, "mkt");
  const dest = path.join(mkt, "plugins", "mcp-check");
  fs.mkdirSync(path.join(mkt, ".claude-plugin"), { recursive: true });
  for (const item of ["bin", "src", "skills", ".claude-plugin", "package.json"]) fs.cpSync(path.join(ROOT, item), path.join(dest, item), { recursive: true });
  fs.writeFileSync(path.join(mkt, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "local-test", owner: { name: "test" }, plugins: [{ name: "mcp-check", description: "x", source: "./plugins/mcp-check" }] }));
  const claude = (...args) => runClaude(sb, null, args, { timeout: 100000 });
  const added = await claude("plugin", "marketplace", "add", mkt);
  assert.equal(added.code, 0, added.out + added.err);
  const installed = await claude("plugin", "install", "mcp-check@local-test");
  assert.equal(installed.code, 0, installed.out + installed.err);
  const details = await claude("plugin", "details", "mcp-check");
  assert.equal(details.code, 0, details.out + details.err);
  assert.match(details.out, /Skills \(1\)\s+check/);
  assert.match(details.out, /Hooks \(0\)/);
  const always = /Always-on:\s+~(\d+) tok/.exec(details.out);
  assert.ok(always && Number(always[1]) < 30, `always-on is ${always && always[1]} tokens`);
  const row = /^\s*check\s+.*$/m.exec(details.out);
  t.diagnostic(`claude plugin details: ${always[0].replace(/\s+/g, " ")}; per component: ${row ? row[0].trim().replace(/\s+/g, " ") : "(no row)"}`);
});

test("when the shell tool is not allowed for the command, Claude Code (up to 2.1.301) hands the model the command line as 'run this first', and the skill text reads right that way too; from 2.1.302 `claude -p` does not hand it over (Windows, PowerShell tool)", { skip: skip() || (!IS_WIN && "this is how the PowerShell tool of a Windows setup behaves here"), timeout: 180000 }, async () => {
  const copy = path.join(sandbox("copy").root, "plugin");
  for (const item of ["bin", "src", "skills", ".claude-plugin", "package.json"]) fs.cpSync(path.join(ROOT, item), path.join(copy, item), { recursive: true });
  const skillFile = path.join(copy, "skills", "check", "SKILL.md");
  const text = fs.readFileSync(skillFile, "utf8");
  assert.match(text, /^allowed-tools: .*\r?\n/m);
  fs.writeFileSync(skillFile, text.replace(/^allowed-tools: .*\r?\n/m, ""));
  const sb = sandbox("runfirst");
  patchClaudeJson(sb, { mcpServers: { u1: fake("ok") } });
  const api = await fakeApi();
  try {
    const r = await runClaude(sb, api, ["-p", "/mcp-check:check", "--plugin-dir", copy, "--output-format", "json"], { env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", CLAUDE_CODE_GIT_BASH_PATH: "C:/nonexistent/bash.exe" } });
    assert.equal(r.code, 0, r.err);
    if (atLeast(2, 1, 302)) {
      // from 2.1.302 a skill whose command line the shell tool may not run is not handed to the model by `claude -p` at all:
      // the run ends with an empty result, as a local command, and no request is made (the plugin's skill has allowed-tools, so it is not affected)
      assert.equal(api.requests.length, 0, "no request: the skill never reached the model");
      assert.equal(r.result.local_command, "custom");
      assert.equal(r.result.result, "");
      return;
    }
    const req = api.requests.find((x) => textBlocks(x).some((b) => b.startsWith("Base directory for this skill"))) || api.requests[0];
    const skillText = textBlocks(req).find((b) => b.startsWith("Base directory for this skill"));
    assert.ok(skillText, "the skill reached the model");
    assert.match(skillText, /\[run this first, exactly as written, with the PowerShell tool and use its output: `node "[^"]+claude-mcp-check\.mjs" lint --project "[^"]+" --markdown`\]\n\nAt most 10 lines: each problem with its file and line, and the fix\./);
    assert.ok(skillText.includes(`--project "${fwd(sb.work)}"`), "the project folder is filled in");
  } finally { await api.close(); }
});

// ---- the validation table ----------------------------------------------------------------------------------------------------------

test("the entries Claude Code skips: the binary lists and skips exactly the entries of the table, in .mcp.json and in ~/.claude.json, with the words of the table", { skip: skip(), timeout: 300000 }, async (t) => {
  for (const where of ["mcpjson", "claudejson"]) {
    const sb = sandbox("valid");
    const all = Object.fromEntries(VALIDATION_ROWS.map(([name, entry]) => [name, entry]));
    if (where === "mcpjson") { put(sb.mcpJson, { mcpServers: all }); put(sb.local, { enableAllProjectMcpServers: true }); } else patchClaudeJson(sb, { mcpServers: all });
    const out = (await runClaude(sb, null, ["mcp", "list"])).out;
    const listed = new Set(Object.keys(parseList(out).servers));
    for (const [name, , message] of VALIDATION_ROWS) {
      assert.equal(listed.has(name), message === null, `${where}: ${name}`);
      if (message !== null) assert.ok(out.includes(`Skipped — ${message}`), `${where}: ${name}: the binary says "${message}"`);
    }
    const doc = byName(await showOf(sb));
    for (const [name, , message] of VALIDATION_ROWS) assert.equal(doc[name].state === "skipped", message !== null, `${where}: ${name}: the tool`);
    if (where === "mcpjson") t.diagnostic(`${VALIDATION_ROWS.length} entries: the binary, the table and the tool agree`);
  }
});

// ---- the default expansion of an inherited environment ---------------------------------------------------------------------------

test("`check` gives the server the working folder and CLAUDE_PROJECT_DIR that Claude Code gives it", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("cwd");
  const log = path.join(sb.root, "fmcp.jsonl");
  patchClaudeJson(sb, { mcpServers: { x: { command: process.execPath, args: [SERVER, "serve", "ok"], env: { FMCP_LOG: log, FMCP_ECHO: "CLAUDE_PROJECT_DIR" } } } });
  await probeRun(sb);
  const a = readLog(log).find((e) => e.event === "start");
  fs.rmSync(log);
  await mine(sb, ["check", "x", "--timeout", "10000"]);
  const b = readLog(log).find((e) => e.event === "start");
  assert.equal(b.cwd, a.cwd);
  assert.deepEqual(b.echo, a.echo);
  assert.equal(b.echo.CLAUDE_PROJECT_DIR, sb.work);
});

test("`check --mcp-config` starts the servers of the file as the binary starts them: the same arguments, folder and CLAUDE_PROJECT_DIR", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("flagcheck");
  const log = path.join(sb.root, "fmcp.jsonl");
  const flagFile = put(path.join(sb.root, "extra.json"), { mcpServers: { x: { command: process.execPath, args: [SERVER, "serve", "ok", "home=${HOME}"], env: { FMCP_LOG: log, FMCP_ECHO: "CLAUDE_PROJECT_DIR" } } } });
  await probeRun(sb, { args: ["--mcp-config", flagFile] });
  const a = readLog(log).find((e) => e.event === "start");
  assert.ok(a, "the binary started the server of the file");
  fs.rmSync(log);
  const c = (await mine(sb, ["check", "x", "--mcp-config", flagFile, "--json", "--timeout", "10000"])).json().servers[0];
  assert.equal(c.ok, true);
  assert.equal(c.scope, "--mcp-config");
  const b = readLog(log).find((e) => e.event === "start");
  assert.deepEqual(b.argv, a.argv);
  assert.equal(b.cwd, a.cwd);
  assert.deepEqual(b.echo, a.echo);
});

test("a server with a pending approval is not started by `check` unless --include-unapproved, and `why` says it is not approved", { skip: skip(), timeout: 180000 }, async () => {
  const sb = sandbox("unapproved");
  const log = path.join(sb.root, "fmcp.jsonl");
  put(sb.mcpJson, { mcpServers: { pending: fake("ok", { env: { FMCP_LOG: log } }) } });
  assert.equal((await claudeGet(sb, "pending")).status, "pending");
  const c = (await mine(sb, ["check", "--json", "--timeout", "10000"])).json().servers[0];
  assert.equal(c.checked, false);
  assert.match(c.skipped, /not approved/);
  assert.equal(readLog(log).length, 0, "no process was started");
  const w = (await mine(sb, ["why", "pending", "--json"])).json();
  assert.equal(w.cause, "not-approved");
  const forced = (await mine(sb, ["check", "pending", "--json", "--timeout", "10000", "--include-unapproved"])).json().servers[0];
  assert.equal(forced.checked, true);
  assert.equal(forced.ok, true);
});
