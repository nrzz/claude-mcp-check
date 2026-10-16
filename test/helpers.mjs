// Shared test helpers: throwaway worlds (a Claude config folder, a home folder, project folders) and ways to run the CLI.
//
// SAFETY: nothing here reads or writes the real Claude folder or the real ~/.claude.json. Importing this file points HOME,
// USERPROFILE, CLAUDE_CONFIG_DIR and the managed-settings folder of the test process at an empty temporary folder, so even a
// test that forgets to pass its own environment cannot reach them. Every child process gets a world's environment, and
// runCli refuses to run with a config or home folder outside the OS temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "bin", "claude-mcp-check.mjs");
export const SERVER = path.join(ROOT, "test", "fake-mcp-server.mjs");
export const NOW = Date.parse("2026-10-16T12:00:00.000Z");

const made = [];
export function tmpDir(prefix = "cmc-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder eventually */ } } });

// The guard: an empty home, config folder and managed folder for this process.
const guard = tmpDir("cmc-guard-");
process.env.HOME = guard;
process.env.USERPROFILE = guard;
process.env.CLAUDE_CONFIG_DIR = path.join(guard, ".claude");
process.env.CLAUDE_MCP_CHECK_MANAGED_DIR = path.join(guard, "no-managed-settings");
process.env.NO_COLOR = "1";
for (const k of Object.keys(process.env)) if (/^(CLAUDE_CODE_|ANTHROPIC_|MCP_|ENABLE_TOOL_SEARCH)/.test(k)) delete process.env[k];
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDECODE;

const underTmp = (p) => path.resolve(p).toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase());
const configDirOf = (e) => e.CLAUDE_CONFIG_DIR || path.join((process.platform === "win32" ? e.USERPROFILE || e.HOME : e.HOME) || "", ".claude");

const asText = (v) => (typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`);
export const put = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, asText(v)); return file; };
export const fwd = (p) => String(p).split(path.sep).join("/");

/** The `mcpServers` entry of the fake server in a mode, with the arguments after it. */
export function fake(mode = "ok", { args = [], env = {} } = {}) {
  return { command: process.execPath, args: [SERVER, "serve", mode, ...args], ...(Object.keys(env).length ? { env } : {}) };
}

/**
 * A throwaway world. base/home/.claude is the config folder (CLAUDE_CONFIG_DIR), so ~/.claude.json of the world is
 * base/home/.claude/.claude.json; base/work/proj is the project folder, and base/managed the managed-settings folder.
 *   trusted   write the project's entry in .claude.json with hasTrustDialogAccepted (default true)
 */
export function world(name = "w", { trusted = true, configDir = true } = {}) {
  const base = tmpDir(`cmc-${name}-`);
  const home = path.join(base, "home");
  const claude = path.join(home, ".claude");
  const work = path.join(base, "work", "proj");
  const managedDir = path.join(base, "managed");
  for (const d of [claude, work]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", CLAUDE_MCP_CHECK_MANAGED_DIR: managedDir };
  if (configDir) env.CLAUDE_CONFIG_DIR = claude; else delete env.CLAUDE_CONFIG_DIR;
  delete env.FORCE_COLOR;
  const claudeJsonFile = configDir ? path.join(claude, ".claude.json") : path.join(home, ".claude.json");
  const w = {
    base, home, claude, work, managedDir, env,
    claudeJsonFile,
    userFile: path.join(claude, "settings.json"),
    projectFile: path.join(work, ".claude", "settings.json"),
    localFile: path.join(work, ".claude", "settings.local.json"),
    mcpJsonFile: path.join(work, ".mcp.json"),
    managedFile: path.join(managedDir, "managed-settings.json"),
    // the key of the project in .claude.json
    key: fwd(work),
    write: (file, v) => put(file, v),
    read: (file) => fs.readFileSync(file, "utf8"),
    exists: (file) => fs.existsSync(file),
    readJson: (file) => JSON.parse(fs.readFileSync(file, "utf8")),
    user: (v) => put(w.userFile, v),
    project: (v) => put(w.projectFile, v),
    local: (v) => put(w.localFile, v),
    mcpJson: (v, file = w.mcpJsonFile) => put(file, v),
    managedSettings: (v) => put(w.managedFile, v),
    // .claude.json: merge top-level keys, and keep the project's entry (with its trust) in place
    claudeJson: (patch = {}, projectPatch) => {
      const current = fs.existsSync(claudeJsonFile) ? JSON.parse(fs.readFileSync(claudeJsonFile, "utf8")) : { hasCompletedOnboarding: true, projects: {} };
      const next = { ...current, ...patch };
      if (projectPatch) { next.projects = { ...(next.projects || {}) }; next.projects[w.key] = { ...(next.projects[w.key] || {}), ...projectPatch }; }
      put(claudeJsonFile, next);
      return next;
    },
    backups: (file) => { try { return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.bak-mcp-check-`)).sort(); } catch { return []; } },
  };
  put(claudeJsonFile, { hasCompletedOnboarding: true, projects: trusted ? { [w.key]: { hasTrustDialogAccepted: true, allowedTools: [] } } : {} });
  return w;
}

/** Runs the real CLI in a child process. */
export function runCli(args, { cwd, env, input, timeout = 120000 } = {}) {
  const e = { ...process.env, ...env };
  if (!underTmp(configDirOf(e)) || !underTmp(e.HOME || "") || !underTmp(e.USERPROFILE || "")) {
    throw new Error("runCli needs an environment from world(): the Claude config and home folders must be temporary");
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: e, input, encoding: "utf8", windowsHide: true, timeout });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", all: `${r.stdout || ""}${r.stderr || ""}` };
}

/** Runs main() in this process and captures what it prints. */
export async function run(args, w, { cwd, env = {}, now = NOW, platform } = {}) {
  let out = "";
  let err = "";
  const code = await main(args, {
    cwd: cwd || w.work,
    env: { ...w.env, ...env },
    home: w.home,
    managed: w.managedDir,
    mcpJsonRoot: w.base,
    platform,
    now,
    stdout: { write: (s) => { out += s; return true; } },
    stderr: { write: (s) => { err += s; return true; } },
  });
  return { code, out, err, all: out + err, json: () => JSON.parse(out) };
}

/** Is a process alive? (The tests use it to see that check ended every server it started.) */
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** The command line of a running process, or null: tells a server that was left running from an unrelated process that was given its pid. */
export function commandLineOf(pid) {
  try {
    const n = Number(pid);
    const r = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${n}').CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 30000 })
      : spawnSync("ps", ["-p", String(n), "-o", "command="], { encoding: "utf8", timeout: 30000 });
    return (r.stdout || "").trim() || null;
  } catch { return null; }
}

/**
 * The processes of `pids` that are still running after a short wait: a process takes a moment to go (a killed one is a zombie until
 * its parent is told), and a pid can be handed to an unrelated process once it is free. With `needle`, a process that is still there
 * counts only when its command line holds it.
 */
export async function stillRunning(pids, { needle = null, ms = 5000 } = {}) {
  let left = pids.filter(alive);
  for (const end = Date.now() + ms; left.length && Date.now() < end;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    left = left.filter(alive);
  }
  return needle ? left.filter((pid) => (commandLineOf(pid) || "").includes(needle)) : left;
}

/** Reads the log lines that the fake server wrote. */
export function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
