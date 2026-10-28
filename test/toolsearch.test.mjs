// Tool search: whether the request carries the schemas of MCP tools or only their names, what `show` and `check` say about it,
// and the figures they give for each case. The rules were put to the real binary (test/e2e-claude.test.mjs does it again for
// every version CI installs); here they are checked against the fake server, in this process.
import { fake, run, world } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFERS_ON_EVERY_HOST_FROM, claudeVersionOf, parseClaudeVersion, toolSearchOf, versionAtLeast } from "../src/toolsearch.mjs";
import { BIG_TOOL, TOOLS } from "./fake-mcp-server.mjs";

test("the version Claude Code puts in AI_AGENT, and the versions that are written elsewhere", () => {
  assert.deepEqual(parseClaudeVersion("2.1.309"), [2, 1, 309]);
  assert.deepEqual(parseClaudeVersion("2.1.310 (Claude Code)"), [2, 1, 310]);
  assert.deepEqual(parseClaudeVersion("claude-code_2-1-309_agent"), [2, 1, 309]);
  assert.deepEqual(parseClaudeVersion("claude-code_2-1-295_harness"), [2, 1, 295]);
  assert.deepEqual(parseClaudeVersion("claude-code/2.1.303/agent"), [2, 1, 303]);
  assert.equal(parseClaudeVersion("cursor_1-2-3_agent"), null);
  assert.equal(parseClaudeVersion("banana"), null);
  assert.equal(parseClaudeVersion(undefined), null);
  assert.deepEqual(claudeVersionOf({ AI_AGENT: "claude-code_2-1-309_agent" }), { numbers: [2, 1, 309], text: "2.1.309", source: "AI_AGENT" });
  assert.equal(claudeVersionOf({ AI_AGENT: "codex_1-2-3_agent" }), null, "only Claude Code's own value counts");
  assert.equal(claudeVersionOf({}), null);
  assert.ok(versionAtLeast([2, 1, 304], [2, 1, 304]));
  assert.ok(versionAtLeast([2, 2, 0], [2, 1, 304]));
  assert.ok(!versionAtLeast([2, 1, 303], [2, 1, 304]));
  assert.ok(!versionAtLeast([1, 9, 999], [2, 1, 304]));
});

// [label, environment, mode, autoPercent]: the rows that the real binary was asked about (the e2e checks the same rows)
const ROWS = [
  ["not set", {}, "deferred", null],
  ["empty", { ENABLE_TOOL_SEARCH: "" }, "deferred", null],
  ["true", { ENABLE_TOOL_SEARCH: "true" }, "deferred", null],
  ["TRUE", { ENABLE_TOOL_SEARCH: "TRUE" }, "deferred", null],
  ["1", { ENABLE_TOOL_SEARCH: "1" }, "deferred", null],
  ["yes", { ENABLE_TOOL_SEARCH: "yes" }, "deferred", null],
  ["on", { ENABLE_TOOL_SEARCH: "on" }, "deferred", null],
  ["force", { ENABLE_TOOL_SEARCH: "force" }, "deferred", null],
  ["any other text", { ENABLE_TOOL_SEARCH: "banana" }, "deferred", null],
  ["false", { ENABLE_TOOL_SEARCH: "false" }, "upfront", null],
  ["False", { ENABLE_TOOL_SEARCH: "False" }, "upfront", null],
  ["0", { ENABLE_TOOL_SEARCH: "0" }, "upfront", null],
  ["no", { ENABLE_TOOL_SEARCH: "no" }, "upfront", null],
  ["off", { ENABLE_TOOL_SEARCH: "off" }, "upfront", null],
  ["auto", { ENABLE_TOOL_SEARCH: "auto" }, "auto", 10],
  ["auto:5", { ENABLE_TOOL_SEARCH: "auto:5" }, "auto", 5],
  ["auto:50", { ENABLE_TOOL_SEARCH: "auto:50" }, "auto", 50],
  ["auto:x", { ENABLE_TOOL_SEARCH: "auto:x" }, "auto", 10],
  ["auto:0", { ENABLE_TOOL_SEARCH: "auto:0" }, "deferred", null],
  ["auto:100", { ENABLE_TOOL_SEARCH: "auto:100" }, "upfront", null],
  ["auto:150", { ENABLE_TOOL_SEARCH: "auto:150" }, "upfront", null],
  ["auto:-5", { ENABLE_TOOL_SEARCH: "auto:-5" }, "deferred", null],
  ["auto:20.5", { ENABLE_TOOL_SEARCH: "auto:20.5" }, "auto", 20.5],
  ["auto:20 and a space", { ENABLE_TOOL_SEARCH: "auto:20 " }, "auto", 20],
  ["auto: 20", { ENABLE_TOOL_SEARCH: "auto: 20" }, "auto", 20],
  ["Auto is only text", { ENABLE_TOOL_SEARCH: "Auto" }, "deferred", null],
  ["AUTO:20 is only text", { ENABLE_TOOL_SEARCH: "AUTO:20" }, "deferred", null],
  [" auto is only text", { ENABLE_TOOL_SEARCH: " auto" }, "deferred", null],
  ["spaces around false", { ENABLE_TOOL_SEARCH: " false " }, "upfront", null],
  ["FALSE", { ENABLE_TOOL_SEARCH: "FALSE" }, "upfront", null],
  ["Off", { ENABLE_TOOL_SEARCH: "Off" }, "upfront", null],
  ["experimental betas off", { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, "upfront", null],
  ["experimental betas off, tool search on", { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", ENABLE_TOOL_SEARCH: "true" }, "upfront", null],
  ["experimental betas off, tool search forced", { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", ENABLE_TOOL_SEARCH: "force" }, "upfront", null],
  ["Anthropic's own host", { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, "deferred", null],
  ["another host, version not known", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" }, "depends", null],
  ["another host, 2.1.303", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", AI_AGENT: "claude-code_2-1-303_agent" }, "upfront", null],
  ["another host, 2.1.304", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", AI_AGENT: "claude-code_2-1-304_agent" }, "deferred", null],
  ["another host, 2.1.312", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", AI_AGENT: "claude-code_2-1-312_agent" }, "deferred", null],
  ["another host, set on, 2.1.303", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", AI_AGENT: "claude-code_2-1-303_agent", ENABLE_TOOL_SEARCH: "true" }, "deferred", null],
  ["another host, set off, 2.1.312", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", AI_AGENT: "claude-code_2-1-312_agent", ENABLE_TOOL_SEARCH: "false" }, "upfront", null],
  ["another host, auto", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", ENABLE_TOOL_SEARCH: "auto" }, "auto", 10],
  ["a base URL that is not a URL", { ANTHROPIC_BASE_URL: "not a url", AI_AGENT: "claude-code_2-1-312_agent" }, "deferred", null],
];

test("what ENABLE_TOOL_SEARCH, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, ANTHROPIC_BASE_URL and the version make of tool search: every row", () => {
  assert.equal(DEFERS_ON_EVERY_HOST_FROM, "2.1.304");
  for (const [label, env, mode, autoPercent] of ROWS) {
    const r = toolSearchOf(env);
    assert.equal(r.mode, mode, `${label}: ${r.reason}`);
    assert.equal(r.autoPercent, autoPercent, label);
    assert.ok(r.reason.length > 20, `${label}: there is a reason`);
  }
});

test("a deferred request on another host can be refused: the result says so, and says nothing of a host that is Anthropic's", () => {
  assert.equal(toolSearchOf({}).refusable, false);
  assert.equal(toolSearchOf({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/" }).refusable, false);
  assert.equal(toolSearchOf({ ANTHROPIC_BASE_URL: "https://gateway.example.com", AI_AGENT: "claude-code_2-1-310_agent" }).refusable, true);
  assert.equal(toolSearchOf({ ANTHROPIC_BASE_URL: "https://gateway.example.com", ENABLE_TOOL_SEARCH: "true" }).refusable, true);
  assert.equal(toolSearchOf({ ANTHROPIC_BASE_URL: "https://gateway.example.com", ENABLE_TOOL_SEARCH: "false" }).refusable, false);
});

test("nothing but the host of ANTHROPIC_BASE_URL is ever reported: a name, a password or a key in the URL stays out of every report", async () => {
  const w = world("ts-secret");
  w.claudeJson({ mcpServers: { s: fake("ok") } });
  const env = { ANTHROPIC_BASE_URL: "https://alice:hunter2@gateway.example.com/v1/key-sk-live-123", ANTHROPIC_API_KEY: "sk-ant-nothing", AI_AGENT: "claude-code_2-1-309_agent" };
  for (const args of [["check", "--timeout", "5000"], ["check", "--json", "--timeout", "5000"], ["show"], ["show", "--json"]]) {
    const r = await run(args, w, { env });
    assert.equal(r.code, 0, r.out + r.err);
    for (const secret of ["hunter2", "alice", "sk-live-123", "key-sk", "sk-ant-nothing"]) assert.ok(!r.all.includes(secret), `${args.join(" ")}: ${secret}`);
    assert.ok(r.out.includes("gateway.example.com"), `${args.join(" ")}: the host is named`);
  }
});

test("a value of ENABLE_TOOL_SEARCH that is none of Claude Code's words is said to be there and is not printed", async () => {
  const text = toolSearchOf({ ENABLE_TOOL_SEARCH: "sk-live-abc123" });
  assert.equal(text.mode, "deferred");
  assert.equal(text.setting, "(other text)");
  const auto = toolSearchOf({ ENABLE_TOOL_SEARCH: "auto:sk-live-abc123" });
  assert.equal(auto.mode, "auto");
  assert.equal(auto.autoPercent, 10);
  assert.equal(auto.setting, "auto:(other text)");
  for (const r of [text, auto]) assert.ok(!JSON.stringify(r).includes("sk-live"), JSON.stringify(r));
  const w = world("ts-other");
  w.claudeJson({ mcpServers: { s: fake("ok") } });
  for (const args of [["check", "--timeout", "5000"], ["check", "--json", "--timeout", "5000"], ["show"], ["show", "--json"]]) {
    const r = await run(args, w, { env: { ENABLE_TOOL_SEARCH: "sk-live-abc123" } });
    assert.ok(!r.all.includes("sk-live"), args.join(" "));
  }
  assert.equal(toolSearchOf({ ENABLE_TOOL_SEARCH: " False " }).setting, "False", "a word of Claude Code's is shown as written, trimmed");
  assert.equal(toolSearchOf({ ENABLE_TOOL_SEARCH: "AUTO:20" }).setting, "(other text)", "Claude Code takes auto exactly as written");
  assert.equal(toolSearchOf({ ENABLE_TOOL_SEARCH: "auto:20 " }).setting, "auto:20");
});

test("check says what the request carries in each mode, and the figures are the same in every mode", async () => {
  const w = world("ts-modes");
  w.claudeJson({ mcpServers: { good: fake("ok"), big: fake("big") } });
  const answers = {};
  for (const [label, env] of [["deferred", {}], ["upfront", { ENABLE_TOOL_SEARCH: "false" }], ["auto", { ENABLE_TOOL_SEARCH: "auto:20" }], ["depends", { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" }]]) {
    const json = (await run(["check", "--json", "--timeout", "5000"], w, { env })).json();
    const text = (await run(["check", "--timeout", "5000"], w, { env })).out;
    answers[label] = { json, text };
  }
  // the same measurements whatever the mode says
  const figures = (j) => j.servers.map((s) => [s.cost.toolSchemaChars, s.cost.loadedSchemaChars, s.cost.nameChars, s.cost.instructionsChars]);
  assert.deepEqual(figures(answers.upfront.json), figures(answers.deferred.json));
  assert.deepEqual(figures(answers.auto.json), figures(answers.deferred.json));
  assert.deepEqual(figures(answers.depends.json), figures(answers.deferred.json));
  const [big, good] = ["big", "good"].map((n) => answers.deferred.json.servers.find((s) => s.name === n));
  // names: each name and a line feed, for the tools that are sent
  assert.equal(good.cost.nameChars, TOOLS.reduce((n, t) => n + `mcp__good__${t.name}`.length + 1, 0));
  assert.equal(big.cost.nameChars, [...TOOLS, BIG_TOOL].reduce((n, t) => n + `mcp__big__${t.name}`.length + 1, 0));
  // a description over 4,096 characters is cut up front and not cut when the tool is loaded
  assert.equal(good.cost.loadedSchemaChars, good.cost.toolSchemaChars);
  assert.equal(big.cost.loadedSchemaChars - big.cost.toolSchemaChars, 6000 - (4096 + "… [truncated]".length));
  assert.equal(big.cost.descriptionsCut, 1);
  const bigTool = big.cost.perTool.find((t) => t.name === "mcp__big__big_description");
  assert.equal(bigTool.loadedChars - bigTool.chars, 6000 - (4096 + "… [truncated]".length));

  const d = answers.deferred;
  assert.equal(d.json.toolSearch.mode, "deferred");
  assert.equal(d.json.totals.carriedChars, d.json.totals.nameChars, "deferred: the names are what the request carries");
  assert.equal(d.json.totals.carriedTokensEstimate, Math.round(d.json.totals.nameChars / 4));
  assert.match(d.text, /Tool search is on \(ENABLE_TOOL_SEARCH is not set: Claude Code defers MCP tools by default\): the request carries the names of the 7 tools/);
  assert.match(d.text, /tool schemas: [\d,]+ characters, about [\d,]+ tokens \(characters \/ 4, an estimate\), added when the model loads a tool; the request carries only the 3 tool names: \d+ characters/);
  assert.match(d.text, /1 description over 4,096 characters: Claude Code cuts it when the schemas are in the request and does not when the model loads the tool/);
  assert.match(d.text, /A server that offers resources also adds 3 tool names to the list \(ListMcpResourcesTool, ReadMcpResourceDirTool, ReadMcpResourceTool\)/);
  assert.equal(d.json.resourceTools.nameChars, "ListMcpResourcesTool\nReadMcpResourceDirTool\nReadMcpResourceTool\n".length);

  const u = answers.upfront;
  assert.equal(u.json.toolSearch.mode, "upfront");
  assert.equal(u.json.toolSearch.setting, "false");
  assert.equal(u.json.totals.carriedChars, u.json.totals.toolSchemaChars, "off: the schemas are what the request carries");
  assert.match(u.text, /Tool search is off \(ENABLE_TOOL_SEARCH=false switches tool search off\): the request carries the schemas of the 7 tools/);
  assert.match(u.text, /tool schemas: [\d,]+ characters, about [\d,]+ tokens \(characters \/ 4, an estimate\); server instructions 34 characters/);
  assert.match(u.text, /1 description cut at 4,096 characters, as Claude Code cuts them\n/);
  assert.match(u.text, /A server that offers resources also makes Claude Code send 3 tools of its own/);
  assert.doesNotMatch(u.text, /deferred, only their names/);

  const a = answers.auto;
  assert.equal(a.json.toolSearch.mode, "auto");
  assert.equal(a.json.toolSearch.autoPercent, 20);
  assert.equal(a.json.totals.carriedChars, null);
  assert.equal(a.json.totals.carriedTokensEstimate, null);
  assert.match(a.text, /ENABLE_TOOL_SEARCH=auto:20: the schemas are in the request until the MCP tools pass 20% of the context window/);
  assert.match(a.text, /The context window of your model is not known to this tool\./);

  const p = answers.depends;
  assert.equal(p.json.toolSearch.mode, "depends");
  assert.equal(p.json.toolSearch.host, "127.0.0.1:1");
  assert.equal(p.json.totals.carriedChars, null);
  assert.match(p.text, /Claude Code 2\.1\.304 and newer defer MCP tools on every host, older ones only on Anthropic's own host/);
  assert.match(p.text, /If tool search is on, the request carries the names of the 7 tools, \d+ characters, about \d+ tokens, and a schema when the model loads a tool; if it is off, it carries all the schemas, [\d,]+ characters, about [\d,]+ tokens\. The server instructions, 68 characters, are in the request either way\./);
});

test("check reads the setting where Claude Code reads it: the settings files' env blocks win over the environment, local over project over user", async () => {
  const modeOf = async (w, env = {}) => (await run(["check", "--json", "--timeout", "5000"], w, { env })).json().toolSearch;
  const w = world("ts-settings");
  w.claudeJson({ mcpServers: { s: fake("ok") } });
  assert.equal((await modeOf(w)).mode, "deferred");
  w.user({ env: { ENABLE_TOOL_SEARCH: "false" } });
  assert.equal((await modeOf(w)).mode, "upfront", "the user settings' env");
  assert.equal((await modeOf(w, { ENABLE_TOOL_SEARCH: "true" })).mode, "upfront", "settings over the environment");
  w.user({ env: { ENABLE_TOOL_SEARCH: "true" } });
  assert.equal((await modeOf(w, { ENABLE_TOOL_SEARCH: "false" })).mode, "deferred", "settings over the environment, the other way");
  w.project({ env: { ENABLE_TOOL_SEARCH: "false" } });
  assert.equal((await modeOf(w)).mode, "upfront", "project over user");
  w.local({ env: { ENABLE_TOOL_SEARCH: "auto" } });
  assert.equal((await modeOf(w)).mode, "auto", "local over project");
  assert.equal((await modeOf(w)).autoPercent, 10);
  // an environment variable of the settings counts for the base URL as well
  const v = world("ts-settings2");
  v.claudeJson({ mcpServers: { s: fake("ok") } });
  v.project({ env: { ANTHROPIC_BASE_URL: "http://localhost:9" } });
  const r = await modeOf(v, { AI_AGENT: "claude-code_2-1-303_agent" });
  assert.equal(r.mode, "upfront");
  assert.equal(r.host, "localhost:9");
});

test("show says it too: one line when a server loads, the document always, and no line when no server loads", async () => {
  const w = world("ts-show");
  w.claudeJson({ mcpServers: { s: fake("ok") } });
  const text = (await run(["show"], w)).out;
  assert.match(text, /^tools {5}tool search is on: the request carries the names of MCP tools, and a schema once the model loads that tool \(ENABLE_TOOL_SEARCH is not set: Claude Code defers MCP tools by default\)$/m);
  const off = (await run(["show"], w, { env: { ENABLE_TOOL_SEARCH: "0" } })).out;
  assert.match(off, /^tools {5}tool search is off: the request carries every MCP tool schema \(ENABLE_TOOL_SEARCH=0 switches tool search off\)$/m);
  const doc = (await run(["show", "--json"], w, { env: { ENABLE_TOOL_SEARCH: "auto:30" } })).json();
  assert.deepEqual(Object.keys(doc.toolSearch), ["mode", "autoPercent", "setting", "betasOff", "host", "version", "versionSource", "refusable", "reason"]);
  assert.equal(doc.toolSearch.mode, "auto");
  assert.equal(doc.toolSearch.autoPercent, 30);
  const none = world("ts-show-none");
  assert.doesNotMatch((await run(["show"], none)).out, /^tools {5}/m, "no server, no line");
  assert.equal((await run(["show", "--json"], none)).json().toolSearch.mode, "deferred");
});

test("a server that does not answer adds nothing to the figures, and a project without servers gets no paragraph", async () => {
  const w = world("ts-none");
  w.claudeJson({ mcpServers: { gone: { command: "definitely-not-a-command-xyz" } } });
  const r = await run(["check", "--timeout", "2000"], w);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /Tool search is/);
  const j = (await run(["check", "--json", "--timeout", "2000"], w)).json();
  assert.equal(j.totals.nameChars, 0);
  assert.equal(j.totals.carriedChars, 0);
  assert.equal(j.toolSearch.mode, "deferred");
  const empty = world("ts-empty");
  assert.doesNotMatch((await run(["check"], empty)).out, /Tool search is/);
});
