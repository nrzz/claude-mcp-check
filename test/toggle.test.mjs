// toggle and restore: the plan, the files that are written, the backups, the refusals. Against the real binary:
// test/e2e-claude.test.mjs.
import { fake, run, world } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ORIGINAL = '{\n  "model": "m-local",\n  "permissions": {\n    "allow": ["Bash(ls)"]\n  }\n}\n';

function setup(name = "t1") {
  const w = world(name);
  w.claudeJson({ mcpServers: { u: fake("ok") } }, { mcpServers: { l: fake("ok") } });
  w.mcpJson({ mcpServers: { p: fake("ok"), q: fake("ok") } });
  w.local(ORIGINAL);
  return w;
}
const tog = (w, args) => run(["toggle", ...args, "--json"], w);

test("--on for a .mcp.json server approves it in settings.local.json, after a backup, and changes nothing else", async () => {
  const w = setup();
  const r = await tog(w, ["p", "--on"]);
  assert.equal(r.code, 0, r.out);
  const doc = r.json();
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.changes.map((c) => [c.key, c.op, c.item, c.changed]), [["enabledMcpjsonServers", "add", "p", true]]);
  const after = JSON.parse(w.read(w.localFile));
  assert.deepEqual(after.enabledMcpjsonServers, ["p"]);
  assert.deepEqual({ ...after, enabledMcpjsonServers: undefined }, { ...JSON.parse(ORIGINAL), enabledMcpjsonServers: undefined });
  const backups = w.backups(w.localFile);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(w.localFile), backups[0]), "utf8"), ORIGINAL, "the backup is the file as it was, byte for byte");
  assert.equal(doc.changes[0].backup, path.join(path.dirname(w.localFile), backups[0]));
});

test("--off rejects it, --on takes the rejection out: off and on again leave an approved file as it was", async () => {
  const w = setup("t2");
  await tog(w, ["p", "--on"]);
  const approved = w.read(w.localFile);
  assert.equal((await tog(w, ["p", "--off"])).code, 0);
  assert.deepEqual(JSON.parse(w.read(w.localFile)).disabledMcpjsonServers, ["p"]);
  assert.equal((await tog(w, ["p", "--on"])).code, 0);
  assert.equal(w.read(w.localFile), approved, "byte for byte");
});

test("--on does not approve twice, --off does not reject twice, and the answer says there was nothing to do", async () => {
  const w = setup("t3");
  await tog(w, ["p", "--on"]);
  const before = w.read(w.localFile);
  const again = await run(["toggle", "p", "--on"], w);
  assert.equal(again.code, 0);
  assert.match(again.out, /nothing to change/);
  assert.equal(w.read(w.localFile), before);
  assert.equal(w.backups(w.localFile).length, 1, "no backup for a change that did not happen");
  await tog(w, ["q", "--off"]);
  const off = await run(["toggle", "q", "--off"], w);
  assert.match(off.out, /already rejected/);
});

test("with enableAllProjectMcpServers a server is approved already: --on has nothing to add, --off rejects it", async () => {
  const w = setup("t4");
  w.local({ enableAllProjectMcpServers: true });
  const on = await tog(w, ["p", "--on"]);
  assert.deepEqual(on.json().changes, []);
  const off = await tog(w, ["p", "--off"]);
  assert.deepEqual(off.json().changes.map((c) => c.key), ["disabledMcpjsonServers"]);
  assert.equal(JSON.parse(w.read(w.localFile)).enableAllProjectMcpServers, true);
});

test("--on is refused when another file still rejects the server; nothing is written", async () => {
  const w = setup("t5");
  w.project({ disabledMcpjsonServers: ["p"] });
  w.local({ disabledMcpjsonServers: ["p"] });
  const before = w.read(w.localFile);
  const r = await tog(w, ["p", "--on"]);
  assert.equal(r.code, 1);
  assert.match(r.json().refused, /also rejected in \.claude\/settings\.json/);
  assert.equal(w.read(w.localFile), before);
  assert.deepEqual(w.backups(w.localFile), []);
});

test("a settings.local.json that does not exist is made; one that is not valid JSON is left alone", async () => {
  const w = world("t6");
  w.mcpJson({ mcpServers: { p: fake("ok") } });
  const r = await tog(w, ["p", "--on"]);
  assert.equal(r.code, 0);
  assert.equal(r.json().changes[0].created, true);
  assert.equal(w.read(w.localFile), '{\n  "enabledMcpjsonServers": [\n    "p"\n  ]\n}\n');
  assert.deepEqual(w.backups(w.localFile), [], "a new file has nothing to back up");
  const w2 = world("t6b");
  w2.mcpJson({ mcpServers: { p: fake("ok") } });
  w2.local('{ "model": "x", // comment\n }');
  const bad = await tog(w2, ["p", "--on"]);
  assert.equal(bad.code, 1);
  assert.match(bad.json().refused, /is not valid JSON.*left alone/);
  assert.equal(w2.read(w2.localFile), '{ "model": "x", // comment\n }');
});

test("--dry-run says what would change and writes nothing", async () => {
  const w = setup("t7");
  const r = await run(["toggle", "p", "--on", "--dry-run"], w);
  assert.equal(r.code, 0);
  assert.match(r.out, /would add p to enabledMcpjsonServers in \.claude\/settings\.local\.json/);
  assert.equal(w.read(w.localFile), ORIGINAL);
  assert.deepEqual(w.backups(w.localFile), []);
  const j = (await run(["toggle", "p", "--on", "--dry-run", "--json"], w)).json();
  assert.equal(j.dryRun, true);
  assert.equal(j.changes[0].changed, true);
  assert.equal(j.changes[0].backup, null);
});

test("a server in ~/.claude.json: --off writes disabledMcpServers under the project, after a backup, and --on takes it out", async () => {
  const w = setup("t8");
  fs.writeFileSync(w.claudeJsonFile, fs.readFileSync(w.claudeJsonFile, "utf8").trimEnd()); // Claude Code writes the file without a final newline
  const original = w.read(w.claudeJsonFile);
  for (const name of ["u", "l"]) assert.equal((await tog(w, [name, "--off"])).code, 0);
  const j = w.readJson(w.claudeJsonFile);
  assert.deepEqual(j.projects[w.key].disabledMcpServers, ["u", "l"]);
  assert.equal(w.backups(w.claudeJsonFile).length, 2);
  for (const name of ["u", "l"]) assert.equal((await tog(w, [name, "--on"])).code, 0);
  assert.equal(w.read(w.claudeJsonFile), original, "byte for byte");
  assert.ok(!fs.existsSync(`${w.claudeJsonFile}.lock`), "the lock is released");
});

test("~/.claude.json is written under Claude Code's lock: a lock that is held makes the tool wait, then refuse", async () => {
  const w = setup("t9");
  fs.mkdirSync(`${w.claudeJsonFile}.lock`);
  const t0 = Date.now();
  const r = await tog(w, ["u", "--off"]);
  assert.equal(r.code, 1);
  assert.match(r.json().refused, /locked by another program/);
  assert.ok(Date.now() - t0 >= 4000, "it waited for the lock");
  assert.deepEqual(w.readJson(w.claudeJsonFile).projects[w.key].disabledMcpServers, undefined);
  assert.ok(fs.existsSync(`${w.claudeJsonFile}.lock`), "and left the other program's lock alone");
  fs.rmdirSync(`${w.claudeJsonFile}.lock`);
});

test("a stale lock (older than ten seconds) is taken over", async () => {
  const w = setup("t10");
  fs.mkdirSync(`${w.claudeJsonFile}.lock`);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${w.claudeJsonFile}.lock`, old, old);
  assert.equal((await tog(w, ["u", "--off"])).code, 0);
  assert.ok(!fs.existsSync(`${w.claudeJsonFile}.lock`));
});

test("refusals: no such server, a --mcp-config server, an invalid definition, ~/.claude.json that is not valid JSON, a blocked server", async () => {
  const w = setup("t11");
  assert.match((await tog(w, ["zzz", "--off"])).json().refused, /there is no server called "zzz"/);
  assert.match((await tog(w, ["pp", "--off"])).json().refused, /did you mean "p"/);
  const flag = w.write(path.join(w.base, "flag.json"), { mcpServers: { f: fake("ok") } });
  const rf = await run(["toggle", "f", "--off", "--json", "--mcp-config", "x"], w);
  assert.equal(rf.code, 2, "toggle does not take --mcp-config");
  void flag;
  w.claudeJson({ mcpServers: { u: fake("ok"), bad: { args: ["x"] } } });
  assert.match((await tog(w, ["bad", "--off"])).json().refused, /skipped by Claude Code/);
  w.user({ deniedMcpServers: [{ serverName: "u" }] });
  assert.match((await tog(w, ["u", "--on"])).json().refused, /blocked by deniedMcpServers/);
  fs.writeFileSync(w.claudeJsonFile, "{ not json");
  assert.match((await tog(w, ["l", "--off"])).json().refused ?? "", /./, "a .claude.json that is not valid JSON hides the servers in it");
});

test("the usage: --on or --off, not both, not neither", async () => {
  const w = setup("t12");
  assert.equal((await run(["toggle", "p"], w)).code, 2);
  assert.equal((await run(["toggle", "p", "--on", "--off"], w)).code, 2);
  assert.equal((await run(["toggle", "--on"], w)).code, 2);
});

test("restore puts the newest backup back, saves what it replaces, and can be undone", async () => {
  const w = setup("t13");
  await tog(w, ["p", "--on"]);
  const afterOn = w.read(w.localFile);
  await tog(w, ["q", "--on"]);
  const list = await run(["restore", "--list", "--json"], w);
  assert.equal(list.json().backups.length, 2);
  const r = await run(["restore", "--json"], w);
  assert.equal(r.code, 0);
  assert.equal(w.read(w.localFile), afterOn, "the state before the last change");
  assert.equal(w.backups(w.localFile).length, 3, "the file it replaced is saved too");
  const undo = await run(["restore"], w);
  assert.equal(undo.code, 0);
  assert.deepEqual(JSON.parse(w.read(w.localFile)).enabledMcpjsonServers, ["p", "q"], "restoring again undoes the restore");
  const dry = await run(["restore", "--dry-run"], w);
  assert.match(dry.out, /would put/);
  const none = world("t13b");
  const refused = await run(["restore"], none);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /there is no backup/);
});

test("restore --claude-json restores ~/.claude.json", async () => {
  const w = setup("t14");
  const original = w.read(w.claudeJsonFile);
  await tog(w, ["u", "--off"]);
  assert.notEqual(w.read(w.claudeJsonFile), original);
  const r = await run(["restore", "--claude-json"], w);
  assert.equal(r.code, 0, r.out);
  assert.equal(w.read(w.claudeJsonFile), original);
});

test("a symlink to the settings file stays a link when the file is changed", { skip: process.platform === "win32" && "creating a symlink needs a privilege on Windows" }, async () => {
  const w = world("t15");
  w.mcpJson({ mcpServers: { p: fake("ok") } });
  const real = w.write(path.join(w.base, "real-settings.json"), ORIGINAL);
  fs.mkdirSync(path.dirname(w.localFile), { recursive: true });
  fs.symlinkSync(real, w.localFile);
  assert.equal((await tog(w, ["p", "--on"])).code, 0);
  assert.ok(fs.lstatSync(w.localFile).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")).enabledMcpjsonServers, ["p"]);
});
