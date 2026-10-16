// Where Claude Code keeps what the server list is made of: the files, the project key, the .mcp.json files a folder inherits.
import { tmpDir } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { claudeJsonPath, configDir, gitRoot, localSettingsPaths, managedDir, mcpJsonPaths, projectKeyOf, realPath, shortPath, toPosix } from "../src/paths.mjs";

test("the config folder is CLAUDE_CONFIG_DIR, else ~/.claude", () => {
  assert.deepEqual(configDir({ CLAUDE_CONFIG_DIR: "/x/cfg" }, "/home/me"), { dir: path.resolve("/x/cfg"), source: "CLAUDE_CONFIG_DIR" });
  assert.deepEqual(configDir({}, "/home/me"), { dir: path.join("/home/me", ".claude"), source: "default" });
});

test("~/.claude.json is inside CLAUDE_CONFIG_DIR when it is set, and in the home folder when it is not", () => {
  assert.equal(claudeJsonPath({ CLAUDE_CONFIG_DIR: "/x/cfg" }, "/home/me"), path.join(path.resolve("/x/cfg"), ".claude.json"));
  assert.equal(claudeJsonPath({}, "/home/me"), path.join("/home/me", ".claude.json"));
});

test("the managed folder of each system", () => {
  assert.equal(managedDir("win32"), "C:\\Program Files\\ClaudeCode");
  assert.equal(managedDir("darwin"), "/Library/Application Support/ClaudeCode");
  assert.equal(managedDir("linux"), "/etc/claude-code");
});

test("the project key is the root of the git repository, else the folder, with slashes", () => {
  const base = tmpDir("cmc-paths-");
  const plain = path.join(base, "plain");
  const repo = path.join(base, "repo");
  const sub = path.join(repo, "pkg", "sub");
  fs.mkdirSync(plain, { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(projectKeyOf(plain), toPosix(realPath(plain)));
  assert.equal(projectKeyOf(sub), toPosix(realPath(repo)), "inside a repository the key is the root");
  assert.equal(projectKeyOf(repo), toPosix(realPath(repo)));
  assert.equal(gitRoot(plain), null);
  assert.equal(path.resolve(gitRoot(sub)), path.resolve(repo));
  assert.ok(!projectKeyOf(sub).includes("\\"));
});

test("a worktree resolves to the repository it belongs to", () => {
  const base = tmpDir("cmc-wt-");
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
  assert.equal(path.resolve(gitRoot(wt)), path.resolve(main));
});

test(".mcp.json files: the folder's own and one in every folder above it, the nearest first; the climb can stop", () => {
  const base = tmpDir("cmc-up-");
  const sub = path.join(base, "a", "b");
  fs.mkdirSync(sub, { recursive: true });
  const all = mcpJsonPaths(sub);
  assert.equal(all[0], path.join(sub, ".mcp.json"));
  assert.equal(all[1], path.join(base, "a", ".mcp.json"));
  assert.equal(all[2], path.join(base, ".mcp.json"));
  assert.ok(all.length > 3, "up to the root of the drive");
  assert.deepEqual(mcpJsonPaths(sub, base), [path.join(sub, ".mcp.json"), path.join(base, "a", ".mcp.json"), path.join(base, ".mcp.json")]);
});

test("the local settings file: the folder's own on Windows, the repository root's first elsewhere", () => {
  const base = tmpDir("cmc-local-");
  const repo = path.join(base, "repo");
  const sub = path.join(repo, "sub");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  assert.deepEqual(localSettingsPaths(sub, { home: base, platform: "win32" }), [path.join(sub, ".claude", "settings.local.json")]);
  const posix = localSettingsPaths(sub, { home: base, platform: "linux" });
  assert.equal(posix[0], path.join(repo, ".claude", "settings.local.json"));
  assert.equal(posix[1], path.join(sub, ".claude", "settings.local.json"));
  assert.deepEqual(localSettingsPaths(repo, { home: repo, platform: "linux" }), [path.join(repo, ".claude", "settings.local.json")], "not at a root that is the home folder");
});

test("display paths: relative inside the project, ~/ under the home folder, a short ../ above", () => {
  const home = path.resolve("/h/me");
  const project = path.join(home, "shop");
  assert.equal(shortPath(path.join(project, ".mcp.json"), { home, project }), ".mcp.json");
  assert.equal(shortPath(path.join(home, ".claude", ".claude.json"), { home, project }), "~/.claude/.claude.json");
  assert.equal(shortPath(path.join(home, ".mcp.json"), { home, project }), "~/.mcp.json", "the home folder wins over a ../");
  assert.equal(shortPath(path.resolve("/srv/.mcp.json"), { home, project: path.resolve("/srv/a/b") }), "../../.mcp.json");
  assert.equal(shortPath(path.resolve("/etc/x.json"), { home, project }), toPosix(path.resolve("/etc/x.json")));
});
