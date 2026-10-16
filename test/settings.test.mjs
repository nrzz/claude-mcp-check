// The settings files and the project's entry of ~/.claude.json, and what they say about MCP servers.
import { world } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { loadSettingsFiles, mcpFacts, readNameList } from "../src/settings.mjs";
import { loadContext } from "../src/context.mjs";
import { approvalOf } from "../src/state.mjs";

const ctxOf = (w, extra = {}) => loadContext({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, mcpJsonRoot: w.base, ...extra });

test("the files are read from the highest precedence down: managed, local, project, user; a file with a comment is ignored", () => {
  const w = world("set1");
  w.user({ env: { A: "user" } });
  w.project({ env: { A: "project" } });
  w.local('{\n  // note\n  "env": { "A": "local" }\n}\n');
  w.managedSettings({ env: { A: "managed" } });
  const s = loadSettingsFiles({ project: w.work, env: w.env, home: w.home, platform: "win32", managed: w.managedDir });
  assert.deepEqual(s.files.map((f) => f.scope), ["managed", "local", "project", "user"]);
  const local = s.files.find((f) => f.scope === "local");
  assert.equal(local.usable, false);
  assert.match(local.error.message, /JSON/);
  assert.ok(s.files.find((f) => f.scope === "user").usable);
});

test("a name list: a list, one name as plain text, and what is neither", () => {
  assert.deepEqual(readNameList(["a", "b", 5]), { names: ["a", "b"], kind: "array", ignoredItems: 1 });
  assert.deepEqual(readNameList("shared-docs_2"), { names: ["shared-docs_2"], kind: "string" });
  assert.deepEqual(readNameList("two words"), { names: [], kind: "bad" });
  assert.deepEqual(readNameList({ a: 1 }), { names: [], kind: "bad" });
  assert.deepEqual(readNameList(undefined), { names: [], kind: "absent" });
});

test("approvals count from the user and managed files always, from the project and local files only in a trusted folder, and rejections always", () => {
  for (const trusted of [true, false]) {
    const w = world("set2", { trusted });
    w.user({ enabledMcpjsonServers: ["from-user"] });
    w.project({ enabledMcpjsonServers: ["from-project"], disabledMcpjsonServers: ["rejected-in-project"] });
    w.local({ enableAllProjectMcpServers: true });
    const ctx = ctxOf(w);
    assert.equal(ctx.trusted, trusted);
    assert.equal(approvalOf("from-user", ctx.facts).state, "approved");
    assert.equal(approvalOf("from-project", ctx.facts).state, trusted ? "approved" : "pending");
    assert.equal(approvalOf("anything", ctx.facts).state, trusted ? "approved" : "pending", "enableAllProjectMcpServers of the local file");
    assert.equal(approvalOf("rejected-in-project", ctx.facts).state, "rejected", "a rejection counts in any folder");
    if (!trusted) assert.ok(approvalOf("from-project", ctx.facts).inactive.length >= 1, "the approval that does not count is named");
  }
});

test("a rejection wins over an approval and over enableAllProjectMcpServers", () => {
  const w = world("set3");
  w.local({ enabledMcpjsonServers: ["x"], disabledMcpjsonServers: ["x", "y"], enableAllProjectMcpServers: true });
  const ctx = ctxOf(w);
  assert.equal(approvalOf("x", ctx.facts).state, "rejected");
  assert.equal(approvalOf("y", ctx.facts).state, "rejected");
  assert.equal(approvalOf("z", ctx.facts).state, "approved");
});

test("the project's entry of .claude.json: the older approvals, and the lists of servers switched off and on for the project", () => {
  const w = world("set4");
  w.claudeJson({}, { enabledMcpjsonServers: ["old"], disabledMcpjsonServers: ["gone"], disabledMcpServers: ["off"], enabledMcpServers: ["on"] });
  const ctx = ctxOf(w);
  assert.equal(approvalOf("old", ctx.facts).state, "approved");
  assert.equal(approvalOf("gone", ctx.facts).state, "rejected");
  assert.deepEqual(ctx.facts.disabledForProject.map((x) => x.name), ["off"]);
  assert.deepEqual(ctx.facts.enabledForProject.map((x) => x.name), ["on"]);
});

test("allow and deny lists from every file; allowManagedMcpServersOnly keeps only the managed allowlist", () => {
  const w = world("set5");
  w.user({ allowedMcpServers: [{ serverName: "u" }], deniedMcpServers: [{ serverName: "d-user" }] });
  w.project({ allowedMcpServers: [{ serverName: "p" }], deniedMcpServers: [{ serverName: "d-project" }] });
  let f = ctxOf(w).facts;
  assert.deepEqual(f.allowed.map((a) => a.entry.value).sort(), ["p", "u"]);
  assert.deepEqual(f.denied.map((a) => a.entry.value).sort(), ["d-project", "d-user"]);
  assert.equal(f.allowDefined, true);
  w.managedSettings({ allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverName: "m" }] });
  f = ctxOf(w).facts;
  assert.deepEqual(f.allowed.map((a) => a.entry.value), ["m"]);
  assert.equal(f.allowManagedOnly, true);
  assert.deepEqual(f.denied.map((a) => a.entry.value).sort(), ["d-project", "d-user"], "the denylist merges from every file");
});

test("a list of the wrong shape and entries of the wrong shape are noted", () => {
  const w = world("set6");
  w.local({ enabledMcpjsonServers: "shared", disabledMcpjsonServers: { a: 1 }, deniedMcpServers: ["plain"] });
  const f = ctxOf(w).facts;
  const kinds = f.problems.map((p) => `${p.key}:${p.kind}`).sort();
  assert.deepEqual(kinds, ["deniedMcpServers:entries", "disabledMcpjsonServers:bad", "enabledMcpjsonServers:string"]);
});

test("env blocks are kept by scope, with non-strings turned into strings; enabledPlugins: the highest file decides", () => {
  const w = world("set7");
  w.user({ env: { A: 1, B: null, C: true, D: "x" }, enabledPlugins: { "p@m": true, "q@m": true } });
  w.project({ env: { P: "p" }, enabledPlugins: { "q@m": false } });
  w.local({ env: { L: "l" } });
  const f = ctxOf(w).facts;
  assert.deepEqual(f.env.user, { A: "1", B: "", C: "true", D: "x" });
  assert.deepEqual(f.env.project, { P: "p" });
  assert.deepEqual(f.env.local, { L: "l" });
  assert.deepEqual(f.enabledPlugins, { "p@m": true, "q@m": false });
});

test("the environment for ${VAR} has the user settings' env on top of the process; the child's env has project and local on top too", () => {
  const w = world("set8");
  w.user({ env: { A: "user", SETTINGS_ONLY: "u" } });
  w.project({ env: { PROJ_ONLY: "p", A: "project" } });
  w.local({ env: { LOCAL_ONLY: "l" } });
  const ctx = ctxOf(w, { env: { ...w.env, A: "process", B: "process" } });
  assert.equal(ctx.expansionEnv.A, "user");
  assert.equal(ctx.expansionEnv.B, "process");
  assert.equal(ctx.expansionEnv.SETTINGS_ONLY, "u");
  assert.equal(ctx.expansionEnv.PROJ_ONLY, undefined, "the project env is not used for ${VAR}");
  assert.equal(ctx.expansionEnv.LOCAL_ONLY, undefined);
  assert.equal(ctx.childEnv.A, "project", "project over user over process, in the server's own environment");
  assert.equal(ctx.childEnv.LOCAL_ONLY, "l");
  assert.equal(ctx.childEnv.B, "process");
});

test("the context: the project key, the trust, an unreadable .claude.json", () => {
  const w = world("set9");
  const ctx = ctxOf(w);
  assert.equal(ctx.projectKey, w.key);
  assert.equal(ctx.trusted, true);
  assert.equal(ctx.claudeJson.path, w.claudeJsonFile);
  w.write(w.claudeJsonFile, "{ not json");
  const bad = ctxOf(w);
  assert.ok(bad.claudeJson.error);
  assert.equal(bad.trusted, false);
});

test("mcpFacts tolerates a missing project entry and files that did not parse", () => {
  const facts = mcpFacts([{ usable: false, scope: "user", data: null }], undefined, { trusted: false });
  assert.deepEqual([facts.enabled, facts.disabled, facts.allowed, facts.denied], [[], [], [], []]);
});
