// What a server's tools cost in the model's context: names, the cut of a long description, the sizes, the estimate.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DESCRIPTION_LIMIT, RESOURCE_TOOLS, TRUNCATION, measureInstructions, measureTools, sentTool, tokensOf } from "../src/measure.mjs";
import { MAX_TOOL_NAME, normalizeName, toolNameFor, toolPrefix } from "../src/names.mjs";
import { BIG_TOOL, LONG_TOOLS, TOOLS } from "./fake-mcp-server.mjs";

test("names: characters outside A-Z a-z 0-9 _ - become _", () => {
  assert.equal(normalizeName("my.server"), "my_server");
  assert.equal(normalizeName("my server"), "my_server");
  assert.equal(normalizeName("Ünï"), "_n_");
  assert.equal(normalizeName("a-b_c"), "a-b_c");
  assert.equal(normalizeName("plugin:pp:a"), "plugin_pp_a");
  assert.equal(toolPrefix("github"), "mcp__github__");
  assert.equal(toolNameFor("my.server", "get.item"), "mcp__my_server__get_item");
});

test("a tool is sent as name, description and input_schema, the name prefixed", () => {
  const t = sentTool("fake", TOOLS[0]);
  assert.deepEqual(Object.keys(t).sort(), ["cut", "description", "input_schema", "name"]);
  assert.equal(t.name, "mcp__fake__echo");
  assert.equal(t.cut, false);
  assert.deepEqual(t.input_schema, TOOLS[0].inputSchema);
  assert.deepEqual(sentTool("fake", { name: "x" }).input_schema, { type: "object", properties: {} }, "a tool without a schema gets an empty one");
});

test("a description over the limit is cut to the limit and marked", () => {
  const t = sentTool("fake", BIG_TOOL);
  assert.equal(t.cut, true);
  assert.equal(t.description.length, DESCRIPTION_LIMIT + TRUNCATION.length);
  assert.ok(t.description.endsWith(TRUNCATION));
  assert.equal(sentTool("fake", BIG_TOOL, 2048).description.length, 2048 + TRUNCATION.length);
  assert.equal(sentTool("fake", { name: "a", description: "x".repeat(DESCRIPTION_LIMIT) }).cut, false, "exactly the limit is not cut");
});

test("the size of the tools is the size of the JSON that is sent, in characters, with the estimate characters / 4", () => {
  const m = measureTools("fake", TOOLS);
  const expected = TOOLS.map((t) => JSON.stringify({ name: `mcp__fake__${t.name}`, description: t.description, input_schema: t.inputSchema }).length);
  assert.equal(m.count, 3);
  assert.equal(m.sent, 3);
  assert.equal(m.chars, expected.reduce((a, b) => a + b, 0));
  assert.equal(m.tokens, Math.round(m.chars / 4));
  assert.deepEqual(m.tools.map((t) => t.name), ["mcp__fake__add", "mcp__fake__echo", "mcp__fake__list_items"], "sorted by name, as the request is");
  assert.equal(tokensOf(341), 85);
  assert.equal(tokensOf(0), 0);
});

test("with tool search the tool is loaded whole and the request lists the names: loadedChars and nameChars", () => {
  const m = measureTools("fake", [...TOOLS, BIG_TOOL]);
  const big = m.tools.find((t) => t.tool === "big_description");
  assert.equal(big.cut, true);
  assert.equal(big.loadedChars - big.chars, BIG_TOOL.description.length - (DESCRIPTION_LIMIT + TRUNCATION.length), "the description is not cut when the model loads the tool");
  for (const t of m.tools.filter((x) => x.tool !== "big_description")) assert.equal(t.loadedChars, t.chars, t.name);
  assert.equal(m.loadedChars, m.tools.reduce((n, t) => n + t.loadedChars, 0));
  assert.equal(m.loadedTokens, Math.round(m.loadedChars / 4));
  assert.equal(m.nameChars, m.tools.reduce((n, t) => n + t.name.length + 1, 0), "each name and a line feed");
  assert.equal(m.nameChars, "mcp__fake__add\nmcp__fake__big_description\nmcp__fake__echo\nmcp__fake__list_items\n".length);
  assert.equal(m.nameTokens, Math.round(m.nameChars / 4));
  // a tool left out for its name is not listed either
  const long = measureTools("fake", LONG_TOOLS);
  assert.equal(long.nameChars, long.tools.reduce((n, t) => n + t.name.length + 1, 0));
  assert.equal(RESOURCE_TOOLS.nameChars, "ListMcpResourcesTool\nReadMcpResourceDirTool\nReadMcpResourceTool\n".length);
});

test("a tool whose full name is over 128 characters is left out and counted apart", () => {
  const m = measureTools("fake", LONG_TOOLS);
  assert.equal(m.count, 4);
  assert.equal(m.sent, 2);
  assert.deepEqual(m.leftOut.map((x) => x.length).sort(), [129, 130]);
  assert.ok(m.tools.every((t) => t.name.length <= MAX_TOOL_NAME));
});

test("tools of a server without tools, and entries that are not tools", () => {
  assert.deepEqual(measureTools("x", []), { count: 0, sent: 0, leftOut: [], chars: 0, tokens: 0, cut: 0, loadedChars: 0, loadedTokens: 0, nameChars: 0, nameTokens: 0, tools: [] });
  assert.equal(measureTools("x", [null, {}, { name: "ok" }]).sent, 1);
  assert.equal(measureTools("x", undefined).count, 0);
});

test("server instructions are measured as they are sent, cut at the same limit", () => {
  assert.deepEqual(measureInstructions(""), { chars: 0, tokens: 0, cut: false });
  assert.deepEqual(measureInstructions("hello"), { chars: 5, tokens: 1, cut: false });
  const long = measureInstructions("y".repeat(5000));
  assert.equal(long.cut, true);
  assert.equal(long.chars, DESCRIPTION_LIMIT + TRUNCATION.length);
  assert.deepEqual(measureInstructions(undefined), { chars: 0, tokens: 0, cut: false });
});
