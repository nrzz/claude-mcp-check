// How a definition becomes a process: expansion of every field, the split of a command string, the lookup of the command.
import { SERVER, fake, put, tmpDir, world } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { cmdLine, endpointOf, expandedView, launchSpec, resolveCommand, splitCommand } from "../src/launch.mjs";
import { loadContext } from "../src/context.mjs";
import { buildModel } from "../src/state.mjs";

const IS_WIN = process.platform === "win32";
const NODE = process.execPath;

function defOf(w, name, extra = {}) {
  const ctx = loadContext({ project: w.work, env: { ...w.env, ...(extra.env || {}) }, home: w.home, managed: w.managedDir, mcpJsonRoot: w.base });
  const model = buildModel(ctx);
  return { ctx, def: model.servers.find((s) => s.name === name).def };
}

test("every field is expanded, and what could not be is reported with the field it was in", () => {
  const w = world("l1");
  w.claudeJson({ mcpServers: { x: { command: "${BIN:-node}", args: ["--a=${HOME}", "--b=${NOPE}", "${EMPTY}"], env: { K: "${NOPE2}", L: "lit" } } } });
  const { ctx, def } = defOf(w, "x", { env: { EMPTY: "" } });
  const v = expandedView(def, ctx);
  assert.equal(v.command, "node");
  assert.deepEqual(v.args, [`--a=${w.home}`, "--b=${NOPE}", ""]);
  assert.deepEqual(v.env, { K: "${NOPE2}", L: "lit" });
  assert.deepEqual(v.refs.missing, [{ name: "NOPE", field: "args[1]" }, { name: "NOPE2", field: "env.K" }]);
  assert.deepEqual(v.refs.empty, [{ name: "EMPTY", field: "args[2]" }]);
  assert.deepEqual(v.refs.defaulted, [{ name: "BIN", field: "command" }]);
});

test("a remote server's url and headers read the credential names as empty", () => {
  const w = world("l2");
  w.claudeJson({ mcpServers: { r: { type: "http", url: "https://x/mcp?k=${NPM_TOKEN}", headers: { A: "Bearer ${NPM_TOKEN}", B: "${GITHUB_TOKEN}" } } } });
  const { ctx, def } = defOf(w, "r", { env: { NPM_TOKEN: "secret", GITHUB_TOKEN: "ghp" } });
  const v = expandedView(def, ctx);
  assert.equal(v.url, "https://x/mcp?k=");
  assert.deepEqual(v.headers, { A: "Bearer ", B: "ghp" });
  assert.deepEqual(v.refs.readAsEmpty.map((r) => r.name), ["NPM_TOKEN", "NPM_TOKEN"]);
});

test("a plugin's server sees CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA and CLAUDE_PROJECT_DIR, written with slashes", () => {
  const w = world("l3");
  const dir = path.join(w.claude, "plugins", "cache", "m", "pp", "1.0.0");
  w.write(path.join(dir, ".mcp.json"), { mcpServers: { a: { command: "x", args: ["${CLAUDE_PLUGIN_ROOT}/s.js", "${CLAUDE_PLUGIN_DATA}", "${CLAUDE_PROJECT_DIR}"] } } });
  w.write(path.join(w.claude, "plugins", "installed_plugins.json"), { version: 2, plugins: { "pp@m": [{ scope: "user", installPath: dir }] } });
  w.user({ enabledPlugins: { "pp@m": true } });
  const { ctx, def } = defOf(w, "plugin:pp:a");
  const v = expandedView(def, ctx);
  const posix = (p) => p.split(path.sep).join("/");
  assert.deepEqual(v.args, [`${posix(dir)}/s.js`, posix(path.join(w.claude, "plugins", "data", "pp-m")), posix(w.work)]);
  assert.deepEqual(v.refs.missing, []);
});

test("the endpoint: a command and its arguments, or a normalized URL", () => {
  assert.equal(endpointOf({ type: "stdio", command: "node", args: ["a"] }), 'cmd:["node","a"]');
  const a = endpointOf({ type: "http", url: "HTTPS://Example.com:443/mcp/" });
  assert.equal(a, endpointOf({ type: "http", url: "https://example.com/mcp" }));
  assert.notEqual(a, endpointOf({ type: "http", url: "https://example.com:8443/mcp" }));
  assert.notEqual(a, endpointOf({ type: "http", url: "https://example.com/mcp?x=1" }));
});

test("a command string is split on spaces and tabs, double quotes group, single quotes and backslashes do not", () => {
  const base = tmpDir("cmc-split-");
  const opts = { env: { PATH: "" }, cwd: base, platform: process.platform };
  assert.deepEqual(splitCommand("node", opts), ["node"]);
  assert.deepEqual(splitCommand("node a b", opts), ["node", "a", "b"]);
  assert.deepEqual(splitCommand("node\ta   b", opts), ["node", "a", "b"]);
  assert.deepEqual(splitCommand('node "a b" c', opts), ["node", "a b", "c"]);
  assert.deepEqual(splitCommand('"C:/Program Files/x/node.exe" s.js', opts), ["C:/Program Files/x/node.exe", "s.js"]);
  assert.deepEqual(splitCommand("node 'a b'", opts), ["node", "'a", "b'"]);
  assert.deepEqual(splitCommand("node a\\ b", opts), ["node", "a\\", "b"]);
  assert.deepEqual(splitCommand("node a ", opts), ["node", "a"], "a trailing space adds nothing");
  assert.deepEqual(splitCommand(" node", opts), ["", "node"], "a leading space makes an empty command, which cannot start");
  assert.deepEqual(splitCommand("node | cat", opts), ["node", "|", "cat"], "no shell syntax");
});

test("a command string that is a file as a whole (a path with a space) stays whole", () => {
  const base = tmpDir("cmc-split2-");
  const dir = path.join(base, "dir with space");
  const file = path.join(dir, IS_WIN ? "tool.exe" : "tool");
  put(file, "x");
  if (!IS_WIN) fs.chmodSync(file, 0o755);
  assert.deepEqual(splitCommand(file, { env: { PATH: "" }, cwd: base, platform: process.platform }), [file]);
});

test("the lookup: PATH, a path in the project, the PATH of the server's own env, and what is not executable", () => {
  const base = tmpDir("cmc-find-");
  const bin = path.join(base, "bin");
  const tool = path.join(bin, IS_WIN ? "tool.cmd" : "tool");
  put(tool, IS_WIN ? "@echo off\r\n" : "#!/bin/sh\n");
  if (!IS_WIN) fs.chmodSync(tool, 0o755);
  const env = { PATH: `${bin}${path.delimiter}${path.dirname(NODE)}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const find = (command, over = {}) => resolveCommand(command, { env, cwd: base, platform: process.platform, ...over });
  assert.equal(find("tool").found, true);
  assert.equal(find("tool").path, tool);
  assert.equal(find("tool").via, IS_WIN ? "cmd" : "direct");
  assert.equal(find("nothing-like-this").found, false);
  assert.equal(find("nothing-like-this").reason, "not-found");
  assert.equal(find("").reason, "empty");
  assert.equal(find(NODE).found, true, "an absolute path");
  assert.equal(find(path.join("bin", path.basename(tool))).found, true, "a path relative to the project folder");
  assert.equal(find(`.${path.sep}bin${path.sep}${path.basename(tool)}`).found, true);
  assert.equal(find(`.${path.sep}${path.basename(NODE)}`).found, true, "./name that is not in the project falls back to the PATH");
  assert.equal(find(`sub${path.sep}${path.basename(NODE)}`).found, false, "sub/name does not");
  if (!IS_WIN) {
    const plain = path.join(bin, "plain");
    put(plain, "#!/bin/sh\n");
    fs.chmodSync(plain, 0o644);
    assert.equal(find("plain").found, false);
    assert.equal(find("plain").reason, "not-executable");
  }
});

test("on Windows the extensions .com .exe .bat .cmd are tried, the case of the name does not matter, and the PATH key may be Path", { skip: !IS_WIN && "Windows lookup" }, () => {
  const base = tmpDir("cmc-win-");
  put(path.join(base, "bin", "shim.bat"), "@echo off\r\n");
  const env = { Path: path.join(base, "bin") };
  const r = resolveCommand("SHIM", { env, cwd: base, platform: "win32" });
  assert.equal(r.found, true);
  assert.equal(r.via, "cmd");
  assert.equal(resolveCommand("shim.BAT", { env, cwd: base, platform: "win32" }).found, true);
  assert.equal(resolveCommand("shim.ps1", { env, cwd: base, platform: "win32" }).found, false);
});

test("the environment of the child: process, settings env, CLAUDE_PROJECT_DIR, then the server's own env, which wins and sets the PATH for the lookup", () => {
  const w = world("l4");
  w.user({ env: { FROM_USER: "u", BOTH: "user" } });
  w.local({ env: { BOTH: "local" } });
  w.claudeJson({ mcpServers: { x: { command: "tool", args: ["a"], env: { BOTH: "server", PATH: `${path.join(w.base, "bin")}${path.delimiter}${process.env.PATH}` } } } });
  const bin = path.join(w.base, "bin", IS_WIN ? "tool.cmd" : "tool");
  put(bin, IS_WIN ? "@echo off\r\n" : "#!/bin/sh\n");
  if (!IS_WIN) fs.chmodSync(bin, 0o755);
  const { ctx, def } = defOf(w, "x");
  const spec = launchSpec(def, ctx);
  assert.equal(spec.env.BOTH, "server");
  assert.equal(spec.env.FROM_USER, "u");
  assert.equal(spec.env.CLAUDE_PROJECT_DIR, ctx.project);
  assert.equal(spec.cwd, ctx.project);
  assert.equal(spec.resolved.found, true);
  assert.equal(spec.resolved.path, bin);
  assert.deepEqual(spec.args, ["a"]);
});

test("the words of a command string go in front of the arguments", () => {
  const w = world("l5");
  w.claudeJson({ mcpServers: { x: { command: `"${NODE}" some.js --flag`, args: ["last"] } } });
  const { ctx, def } = defOf(w, "x");
  const spec = launchSpec(def, ctx);
  assert.equal(spec.command, NODE);
  assert.deepEqual(spec.args, ["some.js", "--flag", "last"]);
  assert.equal(spec.resolved.found, true);
});

test("the command line for cmd.exe quotes every argument", () => {
  assert.equal(cmdLine("C:\\Program Files\\x\\shim.cmd", ["a b", 'say "hi"', "back\\"]), '"C:\\Program Files\\x\\shim.cmd" "a b" "say \\"hi\\"" "back\\\\"');
});

test("a fake server entry from the helpers is a plain stdio server", () => {
  assert.deepEqual(fake("sleep", { args: ["x"] }), { command: NODE, args: [SERVER, "serve", "sleep", "x"] });
});
