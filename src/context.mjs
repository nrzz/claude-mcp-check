// Reads everything an MCP server list is made of, once: the settings files, ~/.claude.json, the .mcp.json files of the folder
// and of every folder above it, the plugins that are installed and enabled, the files named by --mcp-config, and the managed
// files. Nothing here writes, starts a process or opens a connection.
import os from "node:os";
import path from "node:path";
import { claudeJsonPath, configDir, gitRoot, managedDir, mcpJsonPaths, projectKeyOf, realPath, shortPath, toPosix } from "./paths.mjs";
import { isObject, readJsonFile } from "./jsonfile.mjs";
import { loadSettingsFiles, mcpFacts } from "./settings.mjs";
import { expansionEnv } from "./expand.mjs";

/** The environment a server's own process gets: the process environment with the env of the user, project, local and managed settings layered on it. */
function childEnvOf(processEnv, facts) {
  return { ...processEnv, ...facts.env.user, ...facts.env.project, ...facts.env.local, ...facts.env.managed };
}

/** The plugins that are installed and enabled for this project, with their folders. */
function loadPlugins({ cfgDir, project, projectKey, facts, platform }) {
  const out = { file: path.join(cfgDir, "plugins", "installed_plugins.json"), read: null, plugins: [] };
  out.read = readJsonFile(out.file);
  if (!out.read.exists || out.read.error || !isObject(out.read.data) || !isObject(out.read.data.plugins)) return out;
  const same = (a, b) => (platform === "win32" ? toPosix(a).toLowerCase() === toPosix(b).toLowerCase() : toPosix(a) === toPosix(b));
  for (const [id, value] of Object.entries(out.read.data.plugins)) {
    const records = Array.isArray(value) ? value : isObject(value) ? [value] : [];
    const name = id.split("@")[0];
    const marketplace = id.includes("@") ? id.slice(id.indexOf("@") + 1) : "";
    const enabled = facts.enabledPlugins[id] === true;
    // a user install applies everywhere; a project or local install only in the project it was made for
    const record = records.find((r) => isObject(r) && typeof r.installPath === "string" && (r.scope === undefined || r.scope === "user" || (typeof r.projectPath === "string" && (same(r.projectPath, project) || same(r.projectPath, projectKey)))));
    if (!record) continue;
    out.plugins.push({ id, name, marketplace, enabled, root: record.installPath, scope: record.scope || "user", version: record.version, dataDir: path.join(cfgDir, "plugins", "data", `${name}-${marketplace || "inline"}`) });
  }
  return out;
}

/**
 * Loads the world of a project.
 *   project     the folder Claude Code starts in
 *   mcpConfig   files named by --mcp-config
 *   env, home, platform, managed   injectable so that tests never touch the real machine
 */
export function loadContext({ project, mcpConfig = [], env = process.env, home = os.homedir(), platform = process.platform, managed, cwd = process.cwd(), mcpJsonRoot } = {}) {
  const proj = realPath(path.resolve(cwd, project || "."), platform);
  const projectKey = projectKeyOf(proj);
  const cfg = configDir(env, home);
  const settings = loadSettingsFiles({ project: proj, env, home, platform, managed });
  const claudeJsonFile = claudeJsonPath(env, home);
  const claudeJson = readJsonFile(claudeJsonFile);
  claudeJson.display = shortPath(claudeJsonFile, { home, project: proj });
  const data = claudeJson.data;
  const projects = isObject(data) && isObject(data.projects) ? data.projects : {};
  const entry = isObject(projects[projectKey]) ? projects[projectKey] : {};
  const trusted = entry.hasTrustDialogAccepted === true;
  const facts = mcpFacts(settings.files, entry, { trusted, claudeJsonDisplay: claudeJson.display });
  const mcpJson = mcpJsonPaths(proj, mcpJsonRoot).map((p) => {
    const r = readJsonFile(p);
    r.display = shortPath(p, { home, project: proj });
    r.dir = path.dirname(p);
    return r;
  });
  const flags = mcpConfig.map((f) => {
    const p = path.resolve(cwd, f);
    const r = readJsonFile(p);
    r.display = shortPath(p, { home, project: proj });
    return r;
  });
  const plugins = loadPlugins({ cfgDir: cfg.dir, project: proj, projectKey, facts, platform });
  const mdir = managed || env.CLAUDE_MCP_CHECK_MANAGED_DIR || managedDir(platform);
  const managedMcp = readJsonFile(path.join(mdir, "managed-mcp.json"));
  managedMcp.display = shortPath(managedMcp.path, { home, project: proj });
  return {
    platform, env, home, cwd,
    project: proj, projectKey, gitRoot: gitRoot(proj), trusted,
    configDir: cfg.dir, configSource: cfg.source,
    settings, facts, claudeJson, projectEntry: entry,
    mcpJson, flags, plugins, managedMcp,
    expansionEnv: expansionEnv(env, facts.env.user && { ...facts.env.user, ...facts.env.managed }),
    childEnv: childEnvOf(env, facts),
  };
}
