// From definitions to servers: which definition wins, and what state each name ends in. Every rule here has a check against the
// real binary in test/e2e-claude.test.mjs; these run without it.
import { fake, world } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadContext } from "../src/context.mjs";
import { buildModel } from "../src/state.mjs";
import { keyPathText } from "../src/report.mjs";

const modelOf = (w, extra = {}) => {
  const ctx = loadContext({ project: w.work, env: w.env, home: w.home, managed: w.managedDir, mcpJsonRoot: w.base, ...extra });
  return { ctx, model: buildModel(ctx) };
};
const states = (model) => Object.fromEntries(model.servers.map((s) => [s.name, s.state]));
const s = (model, name) => model.servers.find((x) => x.name === name);

test("scopes in order: --mcp-config, local, project, user; the whole entry of the winner is used", () => {
  const w = world("st1");
  w.claudeJson({ mcpServers: { dup: fake("ok", { args: ["user"] }) } }, { mcpServers: { dup: fake("ok", { args: ["local"] }) } });
  w.mcpJson({ mcpServers: { dup: fake("ok", { args: ["project"] }) } });
  w.local({ enableAllProjectMcpServers: true });
  let { model } = modelOf(w);
  assert.equal(s(model, "dup").winner.scopeLabel, "local");
  assert.deepEqual(s(model, "dup").defs.map((d) => [d.scopeLabel, d.role]), [["local", "winner"], ["project", "shadowed"], ["user", "shadowed"]]);
  const flag = w.write(path.join(w.base, "flag.json"), { mcpServers: { dup: fake("ok", { args: ["flag"] }) } });
  ({ model } = modelOf(w, { mcpConfig: [flag] }));
  assert.equal(s(model, "dup").winner.scopeLabel, "--mcp-config");
});

test("an invalid higher definition is skipped and a lower valid one is used", () => {
  const w = world("st2");
  w.claudeJson({ mcpServers: { dup: fake("ok") } }, { mcpServers: { dup: { command: 5 } } });
  const { model } = modelOf(w);
  const dup = s(model, "dup");
  assert.equal(dup.state, "active");
  assert.equal(dup.winner.scopeLabel, "user");
  assert.deepEqual(dup.defs.map((d) => d.role), ["skipped", "winner"]);
});

test("a name with only invalid definitions is skipped", () => {
  const w = world("st3");
  w.claudeJson({ mcpServers: { bad: { args: ["x"] } } });
  assert.equal(s(modelOf(w).model, "bad").state, "skipped");
});

test(".mcp.json: pending, approved, rejected; a pending definition does not shadow a user one in a session, and does in -p", () => {
  const w = world("st4");
  w.claudeJson({ mcpServers: { dup: fake("ok", { args: ["user"] }), both: fake("ok", { args: ["user"] }) } });
  w.mcpJson({ mcpServers: { dup: fake("ok", { args: ["project"] }), only: fake("ok"), approved: fake("ok"), rejected: fake("ok"), both: fake("ok", { args: ["project"] }) } });
  w.local({ enabledMcpjsonServers: ["approved", "both"], disabledMcpjsonServers: ["rejected"] });
  const { model } = modelOf(w);
  assert.deepEqual(states(model), { dup: "active", only: "pending", approved: "active", rejected: "rejected", both: "active" });
  const dup = s(model, "dup");
  assert.equal(dup.winner.scopeLabel, "user");
  assert.equal(dup.headless.def.scopeLabel, "project", "-p loads the pending one");
  assert.equal(dup.headlessLoads, true);
  assert.equal(s(model, "only").loads, false);
  assert.equal(s(model, "only").headlessLoads, true);
  assert.equal(s(model, "rejected").headlessLoads, false);
  assert.equal(s(model, "both").winner.scopeLabel, "project", "approved: the project definition wins over the user one");
});

test("the project's switch (disabledMcpServers) turns a name off whole, whichever scope it came from; pending stays pending", () => {
  const w = world("st5");
  w.claudeJson({ mcpServers: { u: fake("ok") } }, { mcpServers: { l: fake("ok") }, disabledMcpServers: ["u", "l", "p", "pending"] });
  w.mcpJson({ mcpServers: { p: fake("ok"), pending: fake("ok") } });
  w.local({ enabledMcpjsonServers: ["p"] });
  const { model } = modelOf(w);
  assert.deepEqual(states(model), { u: "disabled", l: "disabled", p: "disabled", pending: "pending" });
  assert.equal(s(model, "u").loads, false);
});

test("policy: the list decides about the definition that was picked, and the name is gone, with no fallback", () => {
  const w = world("st6");
  w.claudeJson({ mcpServers: { dup: fake("ok", { args: ["user"] }), keep: fake("ok") } }, { mcpServers: { dup: fake("ok", { args: ["local"] }) } });
  w.user({ deniedMcpServers: [{ serverCommand: [process.execPath, path.join(w.base, "never")] }, { serverName: "nothing" }] });
  let { model } = modelOf(w);
  assert.deepEqual(states(model), { dup: "active", keep: "active" });
  w.user({ deniedMcpServers: [{ serverCommand: fake("ok", { args: ["local"] }).args.slice(0, 0).concat([process.execPath, ...fake("ok", { args: ["local"] }).args]) }] });
  ({ model } = modelOf(w));
  assert.equal(s(model, "dup").state, "blocked");
  assert.equal(s(model, "dup").policy.by.list, "deniedMcpServers");
  assert.equal(s(model, "keep").state, "active");
});

test("an allowlist blocks what it does not name", () => {
  const w = world("st7");
  w.claudeJson({ mcpServers: { a: fake("ok"), b: fake("ok"), web: { type: "http", url: "https://example.invalid/mcp" } } });
  w.user({ allowedMcpServers: [{ serverName: "a" }] });
  assert.deepEqual(states(modelOf(w).model), { a: "active", b: "blocked", web: "blocked" });
  w.user({ allowedMcpServers: [] });
  assert.deepEqual(states(modelOf(w).model), { a: "blocked", b: "blocked", web: "blocked" });
});

test("names that become the same tool prefix are found, and each says which names it shares the prefix with", () => {
  const w = world("st8");
  w.claudeJson({ mcpServers: { "my.server": fake("ok"), "my server": fake("ok"), my_server: fake("ok"), other: fake("ok") } });
  const { model } = modelOf(w);
  assert.equal(model.collisions.length, 1);
  assert.equal(model.collisions[0].prefix, "mcp__my_server__");
  assert.deepEqual([...model.collisions[0].names].sort(), ["my server", "my.server", "my_server"]);
  assert.deepEqual([...s(model, "my_server").sharesPrefixWith].sort(), ["my server", "my.server"]);
  assert.deepEqual(s(model, "other").sharesPrefixWith, []);
  // across scopes too
  const w2 = world("st8b");
  w2.claudeJson({ mcpServers: { "my.server": fake("ok") } }, { mcpServers: { my_server: fake("ok") } });
  assert.deepEqual([...modelOf(w2).model.collisions[0].names].sort(), ["my.server", "my_server"]);
  // a server that does not load does not take part
  const w3 = world("st8c");
  w3.claudeJson({ mcpServers: { "my.server": fake("ok"), my_server: fake("ok") } }, { disabledMcpServers: ["my_server"] });
  assert.deepEqual(modelOf(w3).model.collisions, []);
});

test("a plugin server with the endpoint of another server is a duplicate", () => {
  const w = world("st9");
  const dir = path.join(w.claude, "plugins", "cache", "m", "pp", "1.0.0");
  w.write(path.join(dir, ".claude-plugin", "plugin.json"), { name: "pp", version: "1.0.0" });
  w.write(path.join(dir, ".mcp.json"), { mcpServers: { theirs: fake("ok"), different: fake("ok", { args: ["other"] }) } });
  w.write(path.join(w.claude, "plugins", "installed_plugins.json"), { version: 2, plugins: { "pp@m": [{ scope: "user", installPath: dir, version: "1.0.0" }] } });
  w.user({ enabledPlugins: { "pp@m": true } });
  w.claudeJson({ mcpServers: { mine: fake("ok") } });
  const { model } = modelOf(w);
  assert.deepEqual(states(model), { mine: "active", "plugin:pp:theirs": "duplicate", "plugin:pp:different": "active" });
  assert.equal(s(model, "plugin:pp:theirs").duplicateOf, "mine");
  assert.equal(s(model, "plugin:pp:different").def.plugin.id, "pp@m");
});

test("a plugin that is installed and not enabled adds no server; one installed for another project adds none here", () => {
  const w = world("st10");
  const dir = path.join(w.claude, "plugins", "cache", "m", "pp", "1.0.0");
  w.write(path.join(dir, ".mcp.json"), { mcpServers: { a: fake("ok") } });
  w.write(path.join(w.claude, "plugins", "installed_plugins.json"), { version: 2, plugins: { "pp@m": [{ scope: "project", installPath: dir, version: "1.0.0", projectPath: path.join(w.base, "elsewhere") }] } });
  w.user({ enabledPlugins: { "pp@m": true } });
  assert.deepEqual(modelOf(w).model.servers, []);
  w.write(path.join(w.claude, "plugins", "installed_plugins.json"), { version: 2, plugins: { "pp@m": [{ scope: "project", installPath: dir, version: "1.0.0", projectPath: w.work }] } });
  assert.deepEqual(modelOf(w).model.servers.map((x) => x.name), ["plugin:pp:a"]);
  w.user({ enabledPlugins: { "pp@m": false } });
  assert.deepEqual(modelOf(w).model.servers, []);
});

test("each definition keeps its file, its key path and its line", () => {
  const w = world("st11");
  w.claudeJson({ mcpServers: { u: fake("ok") } }, { mcpServers: { l: fake("ok") } });
  w.mcpJson('{\n  "mcpServers": {\n    "p": { "command": "x" }\n  }\n}\n');
  const { model } = modelOf(w);
  const p = s(model, "p").def;
  assert.equal(p.line, 3);
  assert.equal(keyPathText(p), "mcpServers.p");
  assert.equal(p.file, w.mcpJsonFile);
  const l = s(model, "l").def;
  assert.equal(keyPathText(l), `projects["${w.key}"].mcpServers.l`);
  assert.ok(l.line > 1);
  assert.equal(l.file, w.claudeJsonFile);
  assert.equal(keyPathText(s(model, "u").def), "mcpServers.u");
});

test("files that cannot be read are problems, and do not stop the rest", () => {
  const w = world("st12");
  w.claudeJson({ mcpServers: { u: fake("ok") } });
  w.mcpJson('{\n  // note\n  "mcpServers": {}\n}\n');
  const flag = w.write(path.join(w.base, "flag.json"), '{ "servers": {} }');
  const { model } = modelOf(w, { mcpConfig: [flag, path.join(w.base, "missing.json")] });
  assert.deepEqual(model.problems.map((p) => p.id).sort(), ["invalid-json", "wrong-top-key"]);
  assert.equal(s(model, "u").state, "active");
  assert.ok(model.sources.some((x) => x.kind === "flag" && x.exists === false));
});

test("managed servers (documentation only): managed-mcp.json takes exclusive control", () => {
  const w = world("st13");
  w.claudeJson({ mcpServers: { u: fake("ok") } });
  w.write(path.join(w.managedDir, "managed-mcp.json"), { mcpServers: { corp: { type: "http", url: "https://corp.example.com/mcp" } } });
  const { model } = modelOf(w);
  assert.equal(s(model, "corp").state, "active");
  assert.equal(s(model, "u").state, "blocked");
  assert.equal(s(model, "u").policy.by.list, "managed-mcp.json");
  fs.rmSync(path.join(w.managedDir, "managed-mcp.json"));
  assert.equal(s(modelOf(w).model, "u").state, "active");
});

test("managedMcpServers in a managed settings file outranks every scope", () => {
  const w = world("st14");
  w.claudeJson({ mcpServers: { corp: fake("ok") } });
  w.managedSettings({ managedMcpServers: { corp: { type: "http", url: "https://corp.example.com/mcp" } } });
  const { model } = modelOf(w);
  assert.equal(s(model, "corp").winner.scopeLabel, "managed");
});
