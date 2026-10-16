// Find and read the settings files that decide which MCP servers load, and pick out what matters to them. The paths and the
// order come from claude-settings-doctor's loader (managed, local, project, user); this one keeps the keys that approve or
// reject a .mcp.json server, the allow and deny lists, the `env` blocks and the enabled plugins.
//
// Nothing here writes. Claude Code ignores a settings file that is not strict JSON (a comment or a trailing comma is enough),
// so such a file is kept in the list, marked ignored, and its keys are not used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, localSettingsPaths, managedDir, shortPath } from "./paths.mjs";
import { isObject, readJsonFile } from "./jsonfile.mjs";
import { parseList } from "./policy.mjs";

export const SCOPES = ["managed", "local", "project", "user"];
const NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Reads every settings file that applies. Returns { configDir, configSource, files } with files highest precedence first;
 * each file is { scope, label, path, display, rank, exists, empty, error, data, usable }.
 *   env, home, platform   injectable so that tests never touch the real machine
 *   managed               override the folder searched for managed settings (tests)
 */
export function loadSettingsFiles({ project, env = process.env, home = os.homedir(), platform = process.platform, managed } = {}) {
  const cfg = configDir(env, home);
  const proj = path.resolve(project || process.cwd());
  const files = [];
  const add = (scope, label, file, rank) => {
    const r = readJsonFile(file);
    const usable = r.exists && !r.error && !r.empty && isObject(r.data);
    const error = r.error || (r.exists && !r.empty && !isObject(r.data) ? "does not hold a JSON object" : null);
    files.push({ scope, label, path: file, display: shortPath(file, { home, project: proj }), rank, exists: r.exists, empty: r.empty, error, data: usable ? r.data : null, text: r.text, usable });
  };
  const mdir = managed || env.CLAUDE_MCP_CHECK_MANAGED_DIR || managedDir(platform);
  add("managed", "managed settings", path.join(mdir, "managed-settings.json"), 40);
  try {
    const drop = path.join(mdir, "managed-settings.d");
    const names = fs.readdirSync(drop).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
    names.forEach((name, i) => add("managed", `managed settings (${name})`, path.join(drop, name), 41 + i));
  } catch { /* no drop-in folder */ }
  localSettingsPaths(proj, { home, platform }).forEach((p, i) => add("local", "local settings", p, 30 - i));
  add("project", "project settings", path.join(proj, ".claude", "settings.json"), 20);
  add("user", "user settings", path.join(cfg.dir, "settings.json"), 10);
  files.sort((a, b) => b.rank - a.rank);
  return { configDir: cfg.dir, configSource: cfg.source, managedDir: mdir, files };
}

/** One list key of a settings file: { names, kind } with kind "array", "string" (one name as plain text), "bad" or "absent". */
export function readNameList(value) {
  if (value === undefined) return { names: [], kind: "absent" };
  if (Array.isArray(value)) return { names: value.filter((v) => typeof v === "string"), kind: "array", ignoredItems: value.filter((v) => typeof v !== "string").length };
  if (typeof value === "string" && NAME.test(value)) return { names: [value], kind: "string" };
  return { names: [], kind: "bad" };
}

/**
 * What the settings files and the project's entry of .claude.json say about MCP servers.
 *   trusted   whether the project folder is trusted (projects[key].hasTrustDialogAccepted): the project and local files
 *             approve a .mcp.json server only in a trusted folder (put to the binary), the user and managed files always
 *   entry     the project's entry in .claude.json (or {}): it may hold the older enabledMcpjsonServers, disabledMcpjsonServers,
 *             enableAllProjectMcpServers and the disabledMcpServers list of servers switched off for the project
 * Returns the approvals, the policy lists, the env blocks, the enabled plugins and the problems with list keys.
 */
export function mcpFacts(files, entry, { trusted = false, claudeJsonDisplay = ".claude.json" } = {}) {
  const facts = {
    enableAll: [], enabled: [], disabled: [], allowed: [], denied: [], allowDefined: false, allowFiles: [], allowManagedOnly: false,
    env: { managed: {}, local: {}, project: {}, user: {} }, enabledPlugins: {}, managedMcpServers: null, problems: [],
    disabledForProject: [], enabledForProject: [],
  };
  const managedOnly = files.some((f) => f.usable && f.scope === "managed" && f.data.allowManagedMcpServersOnly === true);
  facts.allowManagedOnly = managedOnly;

  const counts = (scope) => scope === "user" || scope === "managed" || trusted;
  for (const f of files) {
    if (!f.usable) continue;
    const d = f.data;
    const src = { scope: f.scope, file: f.path, display: f.display };
    const sourceCounts = counts(f.scope);
    if (d.enableAllProjectMcpServers === true) facts.enableAll.push({ ...src, counts: sourceCounts });
    for (const [key, target] of [["enabledMcpjsonServers", facts.enabled], ["disabledMcpjsonServers", facts.disabled]]) {
      const r = readNameList(d[key]);
      if (r.kind === "string" || r.kind === "bad") facts.problems.push({ ...src, key, kind: r.kind, value: d[key] });
      for (const name of r.names) target.push({ ...src, name, counts: key === "disabledMcpjsonServers" ? true : sourceCounts });
    }
    for (const key of ["allowedMcpServers", "deniedMcpServers"]) {
      if (d[key] === undefined) continue;
      const parsed = parseList(d[key]);
      if (parsed.notArray) facts.problems.push({ ...src, key, kind: "bad", value: d[key] });
      if (parsed.bad.length) facts.problems.push({ ...src, key, kind: "entries", count: parsed.bad.length });
      if (key === "deniedMcpServers") { for (const e of parsed.entries) facts.denied.push({ entry: e, file: f.display }); continue; }
      if (managedOnly && f.scope !== "managed") continue;
      facts.allowDefined = true;
      facts.allowFiles.push(f.display);
      for (const e of parsed.entries) facts.allowed.push({ entry: e, file: f.display });
    }
    if (isObject(d.env)) facts.env[f.scope] = { ...facts.env[f.scope], ...Object.fromEntries(Object.entries(d.env).map(([k, v]) => [k, typeof v === "string" ? v : v === null || v === undefined ? "" : String(v)])) };
    if (f.scope === "managed" && isObject(d.managedMcpServers)) facts.managedMcpServers = { servers: d.managedMcpServers, file: f.path, display: f.display };
    if (isObject(d.enabledPlugins)) facts.enabledPlugins = { ...facts.enabledPlugins }; // merged below, lowest precedence first
  }
  // enabledPlugins: the highest file that mentions a plugin decides
  for (const f of [...files].reverse()) if (f.usable && isObject(f.data.enabledPlugins)) for (const [id, v] of Object.entries(f.data.enabledPlugins)) facts.enabledPlugins[id] = v;

  // the project's entry of .claude.json: the older home of the approvals, and the lists of servers switched off or on for the project
  const src = { scope: "claude.json", file: null, display: claudeJsonDisplay };
  if (isObject(entry)) {
    if (entry.enableAllProjectMcpServers === true) facts.enableAll.push({ ...src, counts: true });
    for (const [key, target] of [["enabledMcpjsonServers", facts.enabled], ["disabledMcpjsonServers", facts.disabled]]) {
      const r = readNameList(entry[key]);
      if (r.kind === "bad") facts.problems.push({ ...src, key, kind: "bad", value: entry[key] });
      for (const name of r.names) target.push({ ...src, name, counts: true });
    }
    for (const [key, target] of [["disabledMcpServers", facts.disabledForProject], ["enabledMcpServers", facts.enabledForProject]]) {
      if (entry[key] === undefined) continue;
      if (!Array.isArray(entry[key])) { facts.problems.push({ ...src, key, kind: "bad", value: entry[key] }); continue; }
      for (const name of entry[key]) if (typeof name === "string") target.push({ ...src, name });
    }
  }
  return facts;
}
