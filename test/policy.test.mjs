// allowedMcpServers and deniedMcpServers: the matching of serverName, serverCommand and serverUrl, held to what the binary did
// (test/e2e-claude.test.mjs puts the same lists to it) and to the examples in Claude Code's documentation of managed MCP.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, parseList, urlMatches } from "../src/policy.mjs";

const lists = (allowed, denied) => {
  const a = allowed === undefined ? [] : parseList(allowed).entries.map((entry) => ({ entry, file: "settings.json" }));
  const d = denied === undefined ? [] : parseList(denied).entries.map((entry) => ({ entry, file: "settings.json" }));
  return { allowed: a, denied: d, allowDefined: allowed !== undefined, allowFiles: ["settings.json"] };
};
const stdio = (name, command = "node", args = ["server.js"]) => ({ name, type: "stdio", command, args });
const remote = (name, url) => ({ name, type: "http", url });
const blocked = (l, s) => evaluatePolicy(l, s).blocked;

test("parseList keeps objects with one of the three keys and sets the rest apart", () => {
  const p = parseList([{ serverName: "a" }, { serverCommand: ["node", "x"] }, { serverUrl: "https://x/*" }, "plain", { serverName: "" }, { serverCommand: [] }, { other: 1 }, 5]);
  assert.deepEqual(p.entries.map((e) => e.key), ["serverName", "serverCommand", "serverUrl"]);
  assert.equal(p.bad.length, 5);
  assert.equal(parseList("a").notArray, true);
  assert.equal(parseList(undefined).notArray, false);
});

test("a denylist blocks by name, by the whole command, and by URL pattern", () => {
  const l = lists(undefined, [{ serverName: "d1" }, { serverCommand: ["node", "bad.js", "--x"] }, { serverUrl: "https://*.untrusted.example.com/*" }]);
  assert.ok(blocked(l, stdio("d1")));
  assert.ok(blocked(l, stdio("other", "node", ["bad.js", "--x"])));
  assert.ok(!blocked(l, stdio("other", "node", ["bad.js"])), "the command must be the same, argument for argument");
  assert.ok(blocked(l, remote("r", "https://api.untrusted.example.com/mcp")));
  assert.ok(!blocked(l, remote("r", "https://api.example.com/mcp")));
});

test("an allowlist that is not set allows everything; an empty one allows nothing", () => {
  assert.ok(!blocked(lists(undefined, undefined), stdio("a")));
  assert.ok(blocked(lists([], undefined), stdio("a")));
  assert.ok(blocked(lists([], undefined), remote("r", "https://x/mcp")));
});

test("an allowlist: stdio servers match a serverCommand, or a serverName when there is no serverCommand entry", () => {
  const nameOnly = lists([{ serverName: "github" }], undefined);
  assert.ok(!blocked(nameOnly, stdio("github", "anything", ["at", "all"])));
  assert.ok(blocked(nameOnly, stdio("other")));
  const both = lists([{ serverName: "github" }, { serverCommand: ["npx", "-y", "approved-package"] }], undefined);
  assert.ok(!blocked(both, stdio("local-tool", "npx", ["-y", "approved-package"])));
  assert.ok(blocked(both, stdio("github", "node", ["server.js"])), "a name does not help a stdio server once there is a command entry");
  assert.ok(!blocked(both, remote("github", "https://x/mcp")), "a remote server matches by name when there is no serverUrl entry");
  assert.ok(blocked(both, remote("other-api", "https://x/mcp")));
});

test("an allowlist: remote servers match a serverUrl, and a name does not help once there is one", () => {
  const l = lists([{ serverUrl: "https://mcp.example.com/*" }, { serverName: "github" }], undefined);
  assert.ok(!blocked(l, remote("any", "https://mcp.example.com/api")));
  assert.ok(blocked(l, remote("github", "https://elsewhere.example.org/mcp")));
  const onlyCommands = lists([{ serverCommand: ["node", "a.js"] }], undefined);
  assert.ok(blocked(onlyCommands, remote("r", "https://x/mcp")), "no serverName or serverUrl entry: a remote server is blocked");
});

test("the denylist wins over the allowlist", () => {
  const l = lists([{ serverUrl: "https://*.example.com/*" }], [{ serverUrl: "https://staging.example.com/*" }]);
  assert.ok(!blocked(l, remote("a", "https://mcp.example.com/api")));
  assert.ok(blocked(l, remote("b", "https://staging.example.com/api")));
  assert.ok(!blocked(l, remote("c", "https://staging.example.com:8443/api")), "a pattern without a port means the default port only");
});

test("serverUrl patterns: the examples of the documentation", () => {
  const yes = (pattern, url) => assert.ok(urlMatches(pattern, url), `${pattern} should match ${url}`);
  const no = (pattern, url) => assert.ok(!urlMatches(pattern, url), `${pattern} should not match ${url}`);
  yes("https://mcp.example.com/*", "https://mcp.example.com/api");
  no("https://mcp.example.com/*", "https://mcp.example.com:8443/api");
  yes("https://mcp.example.com", "https://mcp.example.com/any/path");
  yes("https://mcp.example.com:8443/*", "https://mcp.example.com:8443/x");
  no("https://mcp.example.com:8443/*", "https://mcp.example.com/x");
  yes("https://mcp.example.com:*/*", "https://mcp.example.com/x");
  yes("https://mcp.example.com:*/*", "https://mcp.example.com:9000/x");
  yes("https://*.example.com/*", "https://a.b.example.com:1234/x");
  yes("http://localhost:*/*", "http://localhost:3000/mcp");
  yes("*://mcp.example.com/*", "https://mcp.example.com/x");
  yes("*://mcp.example.com/*", "http://mcp.example.com/x");
  no("*://mcp.example.com/*", "http://mcp.example.com:81/x");
  yes("https://Mcp.Example.com/*", "https://mcp.example.com/api");
  yes("https://mcp.example.com./*", "https://mcp.example.com/api");
  no("https://mcp.example.com/Api", "https://mcp.example.com/api");
  no("https://mcp.example.com/*", "ftp://mcp.example.com/api");
});

test("${VAR} in a serverCommand or serverUrl entry expands before matching", () => {
  const l = lists(undefined, [{ serverCommand: ["${BIN}/server"] }]);
  assert.ok(evaluatePolicy(l, stdio("x", "/opt/bin/server", []), { env: { BIN: "/opt/bin" }, platform: "linux" }).blocked);
  assert.ok(!evaluatePolicy(l, stdio("x", "/opt/bin/server", []), { env: {}, platform: "linux" }).blocked);
});

test("the answer says which list and entry decided", () => {
  const r = evaluatePolicy(lists(undefined, [{ serverName: "d1" }]), stdio("d1"));
  assert.deepEqual(r, { blocked: true, by: { list: "deniedMcpServers", entry: { serverName: "d1" }, file: "settings.json" } });
  assert.equal(evaluatePolicy(lists([], undefined), stdio("a")).by.list, "allowedMcpServers");
});
