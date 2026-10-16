// Where Claude Code keeps what an MCP server list is made of. Every place below was put to the real binary (README,
// "What was verified"): the config folder, ~/.claude.json, the project key that .claude.json uses, the .mcp.json files
// a folder inherits, and the settings files that approve or reject them. Nothing here writes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const toPosix = (p) => String(p).split(path.sep).join("/");

/** The folder Claude Code keeps its settings, plugins and transcripts in. */
export function configDir(env = process.env, home = os.homedir()) {
  if (env.CLAUDE_CONFIG_DIR) return { dir: path.resolve(env.CLAUDE_CONFIG_DIR), source: "CLAUDE_CONFIG_DIR" };
  return { dir: path.join(home, ".claude"), source: "default" };
}

/**
 * The .claude.json that holds user-scope and local-scope servers. With CLAUDE_CONFIG_DIR it is inside that folder; without
 * it, it is ~/.claude.json (a ~/.claude/.claude.json is not read: put to the binary).
 */
export function claudeJsonPath(env = process.env, home = os.homedir()) {
  if (env.CLAUDE_CONFIG_DIR) return path.join(path.resolve(env.CLAUDE_CONFIG_DIR), ".claude.json");
  return path.join(home, ".claude.json");
}

/** Where a machine-wide managed-settings.json (and managed-mcp.json) lives on this system. */
export function managedDir(platform = process.platform) {
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  return "/etc/claude-code";
}

/** The git repository root above `dir` (a worktree resolves to its main checkout), or null. */
export function gitRoot(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    const dotgit = path.join(d, ".git");
    let st = null;
    try { st = fs.statSync(dotgit); } catch { /* not here */ }
    if (st) {
      if (st.isFile()) {
        try {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, "utf8"));
          if (m) {
            const gd = path.resolve(d, m[1].trim());
            const w = gd.split(path.sep).lastIndexOf("worktrees");
            if (w > 0) return path.dirname(gd.split(path.sep).slice(0, w).join(path.sep));
          }
        } catch { /* use d */ }
      }
      return d;
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/**
 * The folder as the process of Claude Code sees its working folder: with symbolic links resolved on Linux and macOS
 * (getcwd does that), and as it was written on Windows (the case of the drive letter and short names are kept).
 */
export function realPath(dir, platform = process.platform) {
  const resolved = path.resolve(dir);
  if (platform === "win32") return resolved;
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

/**
 * The key of a project in .claude.json: the root of the git repository the folder is in, else the folder itself,
 * with backslashes written as slashes. Local-scope servers, the folder's trust and its disabledMcpServers list are
 * kept under it. A parent folder's entry does not count, and neither does the entry of a folder inside a repository.
 */
export function projectKeyOf(project) {
  const dir = realPath(project);
  return toPosix(gitRoot(dir) || dir);
}

/**
 * The .mcp.json files a folder inherits, nearest first: the folder's own and one in every folder above it, up to the root of
 * the drive (put to the binary: it read one above the git repository too). `stopAt` ends the climb at a folder (the tests use it).
 */
export function mcpJsonPaths(project, stopAt) {
  const out = [];
  let d = path.resolve(project);
  const stop = stopAt ? path.resolve(stopAt) : null;
  for (let i = 0; i < 64; i++) {
    out.push(path.join(d, ".mcp.json"));
    if (stop && d === stop) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/**
 * Where the local settings file is, for a session started in `project`: the repository root in a git repository, else
 * the folder itself. Not at the root on Windows, when the root is the home folder, or when the folder's owner is
 * someone else. The first entry is the file Claude Code writes. (From claude-permission-doctor's loader.)
 */
export function localSettingsPaths(project, { home = os.homedir(), platform = process.platform } = {}) {
  const own = path.join(project, ".claude", "settings.local.json");
  if (platform === "win32") return [own];
  const root = gitRoot(project);
  if (!root || path.resolve(root) === path.resolve(home)) return [own];
  try {
    const me = typeof process.getuid === "function" ? process.getuid() : null;
    if (me !== null && fs.statSync(root).uid !== me) return [own];
  } catch { /* cannot tell: use the root */ }
  const atRoot = path.join(root, ".claude", "settings.local.json");
  return atRoot === own ? [own] : [atRoot, own];
}

/** Display form of a path: relative to the project inside it, ~/... under the home folder, else the whole path. */
export function shortPath(file, { home, project } = {}) {
  const f = path.resolve(file);
  const within = (base) => {
    if (!base) return null;
    const rel = path.relative(base, f);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
  };
  const p = within(project);
  if (p) return toPosix(p);
  const h = within(home);
  if (h) return `~/${toPosix(h)}`;
  // above the project: ../.mcp.json reads better than a long absolute path
  if (project) {
    const rel = path.relative(project, f);
    if (rel && !path.isAbsolute(rel) && rel.split(path.sep).filter((s) => s === "..").length <= 2) return toPosix(rel);
  }
  return toPosix(f);
}
