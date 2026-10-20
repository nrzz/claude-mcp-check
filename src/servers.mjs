// Every definition of an MCP server that Claude Code would read for a project, from every place it can come from, in the
// order of precedence (README, "How it works"):
//   managed   managed-mcp.json (exclusive control) and managedMcpServers in managed settings   (documentation only)
//   flag      --mcp-config <file>
//   local     ~/.claude.json, projects["<project key>"].mcpServers
//   project   .mcp.json in the folder and in every folder above it, the nearest first
//   user      ~/.claude.json, mcpServers
//   plugin    the .mcp.json or the mcpServers of every enabled plugin, named plugin:<plugin>:<server>
// A definition keeps the file and the key path it came from, and the line of it. Nothing is merged here.
import path from "node:path";
import { isObject, positionAt, readJsonFile } from "./jsonfile.mjs";
import { nodeAt, parseDoc } from "./jsonedit.mjs";
import { validateEntry } from "./validate.mjs";
import { shortPath } from "./paths.mjs";

export const RANK = { managed: 90, flag: 80, local: 70, project: 60, user: 50, plugin: 40 };
// the order in which Claude Code merges the scopes; of two names that become the same tool prefix the first one keeps its tools
export const MERGE_ORDER = { plugin: -1, user: 0, project: 1, local: 2, flag: 3, managed: 4 };

/** A function (keys) => 1-based line of that key path in a file's text, or null. The text is parsed once, on the first use. */
export function locator(file) {
  let doc;
  return (keys) => {
    if (doc === undefined) doc = file.text ? parseDoc(file.text) : { ok: false };
    if (!doc.ok) return null;
    const parent = nodeAt(doc.root, keys.slice(0, -1));
    if (!parent) return null;
    const last = keys[keys.length - 1];
    if (typeof last === "number" && parent.type === "array") {
      const item = parent.items[last];
      return item ? positionAt(file.text, item.start).line : null;
    }
    if (parent.type !== "object") return null;
    const m = parent.members.filter((x) => x.key === last).pop();
    return m ? positionAt(file.text, m.start).line : null;
  };
}

let nextId = 1;
function makeDef(base) {
  const validation = validateEntry(base.name, base.entry);
  return { id: nextId++, ...base, validation, type: validation.type, order: MERGE_ORDER[base.kind] };
}

/** The servers of an object that holds them ({ name: entry }), as definitions. */
function fromObject(servers, base, locate, keyPrefix) {
  const defs = [];
  for (const [name, entry] of Object.entries(servers)) {
    defs.push(makeDef({ ...base, name, entry, keyPath: [...keyPrefix, name], line: locate ? locate([...keyPrefix, name]) : null }));
  }
  return defs;
}

/** Looks at a file that should hold { "mcpServers": { ... } } and says what is wrong with it, as Claude Code does. */
function topLevel(file, problems, { kind, label }) {
  if (!file.exists) return null;
  const base = { file: file.path, display: file.display, kind };
  if (file.error) {
    if (typeof file.error === "string") problems.push({ ...base, id: "unreadable", message: `${label} ${file.error}`, effect: "none of its servers can be read" });
    else problems.push({ ...base, id: "invalid-json", line: file.error.line, column: file.error.column, message: `${label} is not valid JSON (${file.error.message})`, effect: "Claude Code ignores the whole file: none of its servers load (`claude mcp list`: \"MCP config is not a valid JSON\")" });
    return null;
  }
  if (file.empty) return {};
  if (!isObject(file.data)) { problems.push({ ...base, id: "not-object", message: `${label} does not hold a JSON object`, effect: "Claude Code ignores the whole file and prints \"Failed to parse\" for it (`claude mcp list`: Invalid input: expected object)" }); return null; }
  if (file.data.mcpServers === undefined) {
    if (isObject(file.data.servers)) problems.push({ ...base, id: "wrong-top-key", message: `${label} has \"servers\" at the top and no \"mcpServers\"`, effect: "Claude Code reads servers from \"mcpServers\" only: none of these load (`claude mcp list`: Missing \"mcpServers\" — found \"servers\" instead)" });
    else if (kind === "project") {
      // put to the binary: `{}` and `{ "foo": 1 }` in a .mcp.json are "Failed to parse" in `claude mcp list` (the key is required)
      const keys = Object.keys(file.data);
      const named = keys.slice(0, 5).map((k) => `\"${k}\"`).join(", ");
      problems.push({ ...base, id: "no-mcpservers", empty: keys.length === 0, message: keys.length === 0 ? `${label} is an empty object: it has no \"mcpServers\" key` : `${label} has no \"mcpServers\" key (it has ${named}${keys.length > 5 ? ", ..." : ""})`, effect: "no server loads from it, and `claude mcp list` prints \"Failed to parse\" for it (mcpServers: Invalid input: expected record, received undefined)" });
    }
    return {};
  }
  if (!isObject(file.data.mcpServers)) {
    problems.push({ ...base, id: "servers-not-object", message: `\"mcpServers\" in ${label} is not an object`, effect: "Claude Code ignores the whole file (`claude mcp list`: mcpServers: Invalid input: expected record)" });
    return null;
  }
  return file.data.mcpServers;
}

/** Reads the servers of one plugin: its .mcp.json and the mcpServers of its plugin.json (an object, a path, or a list of those). */
function pluginDefs(plugin, ctx, problems) {
  const defs = [];
  const root = plugin.root;
  const sources = [{ file: path.join(root, ".mcp.json"), inline: null }];
  const manifestFile = path.join(root, ".claude-plugin", "plugin.json");
  const manifest = readJsonFile(manifestFile);
  const declared = isObject(manifest.data) ? manifest.data.mcpServers : undefined;
  if (declared !== undefined) {
    for (const item of Array.isArray(declared) ? declared : [declared]) {
      if (typeof item === "string") sources.push({ file: path.resolve(root, item), inline: null });
      else if (isObject(item)) sources.push({ file: manifestFile, inline: item });
    }
  }
  const pluginName = isObject(manifest.data) && typeof manifest.data.name === "string" ? manifest.data.name : plugin.name;
  for (const s of sources) {
    let servers;
    let file;
    if (s.inline) { file = manifest; servers = isObject(s.inline.mcpServers) ? s.inline.mcpServers : s.inline; }
    else {
      file = readJsonFile(s.file);
      if (!file.exists) continue;
      if (file.error || !isObject(file.data)) { problems.push({ id: "invalid-json", kind: "plugin", file: s.file, display: shortPath(s.file, { home: ctx.home, project: ctx.project }), message: `the MCP file of plugin ${plugin.id} cannot be read`, effect: "its servers do not load" }); continue; }
      servers = isObject(file.data.mcpServers) ? file.data.mcpServers : file.data; // a wrapper, or the servers themselves
    }
    const display = shortPath(file.path || s.file, { home: ctx.home, project: ctx.project });
    const locate = file.text ? locator(file) : null;
    const prefix = s.inline ? ["mcpServers"] : isObject(file.data) && isObject(file.data.mcpServers) ? ["mcpServers"] : [];
    for (const [name, entry] of Object.entries(servers)) {
      const full = `plugin:${pluginName}:${name}`;
      defs.push(makeDef({
        name: full, shortName: name, kind: "plugin", scopeLabel: "plugin", rank: RANK.plugin, file: file.path || s.file, display, entry,
        keyPath: [...prefix, name], line: locate ? locate([...prefix, name]) : null,
        plugin: { id: plugin.id, name: pluginName, marketplace: plugin.marketplace, root, dataDir: plugin.dataDir, version: plugin.version },
      }));
    }
  }
  return defs;
}

/**
 * Finds every definition. Returns { defs, sources, problems }:
 *   sources    the places that were looked at, highest precedence first: { kind, file, display, exists, servers, note? }
 *   problems   what is wrong with a file as a whole (invalid JSON, "servers" instead of "mcpServers", ...)
 */
export function discoverServers(ctx) {
  const defs = [];
  const sources = [];
  const problems = [];
  const home = ctx.home;
  const note = (kind, file, display, exists, count, extra = {}) => sources.push({ kind, file, display, exists, servers: count, ...extra });

  // managed: documentation only (a system folder cannot be written by the checks)
  const mm = ctx.managedMcp;
  if (mm.exists) {
    const servers = topLevel(mm, problems, { kind: "managed", label: "managed-mcp.json" });
    const list = servers ? fromObject(servers, { kind: "managed-file", scopeLabel: "managed", rank: RANK.managed, file: mm.path, display: mm.display }, locator(mm), ["mcpServers"]) : [];
    defs.push(...list);
    note("managed-file", mm.path, mm.display, true, list.length, { note: "exclusive control: only these servers and managedMcpServers load" });
  }
  const mms = ctx.facts.managedMcpServers;
  if (mms) {
    const list = fromObject(mms.servers, { kind: "managed", scopeLabel: "managed", rank: RANK.managed - 1, file: mms.file, display: mms.display }, null, ["managedMcpServers"]);
    defs.push(...list);
    note("managed", mms.file, mms.display, true, list.length, { note: "managedMcpServers in managed settings" });
  }
  // --mcp-config
  for (const f of ctx.flags) {
    const servers = topLevel(f, problems, { kind: "flag", label: "the --mcp-config file" });
    const list = servers ? fromObject(servers, { kind: "flag", scopeLabel: "--mcp-config", rank: RANK.flag, file: f.path, display: f.display }, locator(f), ["mcpServers"]) : [];
    defs.push(...list);
    note("flag", f.path, f.display, f.exists, list.length, f.exists ? {} : { note: "no such file" });
  }
  // local scope: the project's entry of .claude.json
  const cj = ctx.claudeJson;
  const projects = isObject(cj.data) && isObject(cj.data.projects) ? cj.data.projects : {};
  const localServers = isObject(projects[ctx.projectKey]) && isObject(projects[ctx.projectKey].mcpServers) ? projects[ctx.projectKey].mcpServers : {};
  if (cj.exists && cj.error) problems.push({ id: "invalid-json", kind: "claude-json", file: cj.path, display: cj.display, message: `${cj.display} cannot be used: ${typeof cj.error === "string" ? cj.error : cj.error.message}`, effect: "user and local servers cannot be read" });
  const cjLocate = cj.text ? locator(cj) : null;
  const localList = fromObject(localServers, { kind: "local", scopeLabel: "local", rank: RANK.local, file: cj.path, display: cj.display }, cjLocate, ["projects", ctx.projectKey, "mcpServers"]);
  defs.push(...localList);
  note("local", cj.path, `${cj.display}  projects["${ctx.projectKey}"]`, cj.exists, localList.length);
  // project scope: .mcp.json, nearest folder first
  ctx.mcpJson.forEach((f, i) => {
    if (!f.exists) return;
    const servers = topLevel(f, problems, { kind: "project", label: `${f.display}` });
    const list = servers ? fromObject(servers, { kind: "project", scopeLabel: "project", rank: RANK.project - i * 0.01, file: f.path, display: f.display, dir: f.dir }, locator(f), ["mcpServers"]) : [];
    defs.push(...list);
    note("project", f.path, f.display, true, list.length, i > 0 ? { note: "in a folder above the project: Claude Code reads it too" } : {});
  });
  if (!ctx.mcpJson.some((f) => f.exists)) note("project", ctx.mcpJson[0].path, ctx.mcpJson[0].display, false, 0);
  // user scope
  const userServers = isObject(cj.data) && isObject(cj.data.mcpServers) ? cj.data.mcpServers : {};
  const userList = fromObject(userServers, { kind: "user", scopeLabel: "user", rank: RANK.user, file: cj.path, display: cj.display }, cjLocate, ["mcpServers"]);
  defs.push(...userList);
  note("user", cj.path, `${cj.display}  mcpServers`, cj.exists, userList.length);
  // plugins
  for (const p of ctx.plugins.plugins) {
    if (!p.enabled) { note("plugin", p.root, p.id, true, 0, { note: "installed, not enabled" }); continue; }
    const list = pluginDefs(p, ctx, problems);
    defs.push(...list);
    note("plugin", p.root, `plugin ${p.id}`, true, list.length);
  }
  return { defs, sources, problems };
}
