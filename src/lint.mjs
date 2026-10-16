// `lint`: what is wrong in the configuration of MCP servers, with the file and the line, and what Claude Code does about it.
// Every finding below describes something the real binary was seen to do (README, "What was verified"); the table of
// configurations in test/lint-table.mjs puts each one to `claude mcp list`.
//
// A finding has a severity:
//   error     Claude Code drops something the file says (the whole file, a server, a setting)
//   warning   the configuration still applies, but something in it is probably not what you meant
//   note      worth knowing, nothing is lost
import { endpointOf, launchSpec, notFoundWords } from "./launch.mjs";
import { locator } from "./servers.mjs";
import { redactUrl } from "./redact.mjs";
import { isObject } from "./jsonfile.mjs";

const SEVERITY = { error: 0, warning: 1, note: 2 };
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;
const listText = (names) => names.map((n) => `"${n}"`).join(", ");

/** All the findings for a model, sorted: errors first, then warnings, then notes, each in the order of the places that were read. */
export function lintModel(ctx, model) {
  const findings = [];
  const add = (f) => findings.push({ severity: "warning", effect: "none", server: null, file: null, display: null, line: null, ...f });
  const defFields = (d) => ({ server: d.name, file: d.file, display: d.display, line: d.line });
  const facts = ctx.facts;

  // --- files as a whole
  for (const p of model.problems) {
    add({ id: p.id === "invalid-json" ? "invalid-json" : p.id, severity: p.id === "unreadable" ? "warning" : p.id === "no-mcpservers" ? (p.empty ? "note" : "warning") : "error", effect: "file", file: p.file, display: p.display, line: p.line || null, message: p.message, fix: p.id === "invalid-json" ? "Keep to strict JSON: no comments, no trailing commas." : p.id === "wrong-top-key" ? 'Rename the key to "mcpServers" (VS Code\'s mcp.json says "servers"; Claude Code does not).' : p.id === "servers-not-object" ? 'Make "mcpServers" an object: { "name": { ... } }.' : p.id === "no-mcpservers" ? 'Write { "mcpServers": {} } for a file that holds no server, or put the servers under "mcpServers".' : p.id === "not-object" ? 'Make the file an object: { "mcpServers": { ... } }.' : null, does: p.effect });
  }
  // a settings file that Claude Code cannot read, and that holds MCP keys
  for (const f of ctx.settings.files) {
    if (f.exists && f.error && typeof f.text === "string" && /(enabledMcpjsonServers|disabledMcpjsonServers|enableAllProjectMcpServers|allowedMcpServers|deniedMcpServers)/.test(f.text)) {
      add({ id: "settings-ignored", severity: "error", effect: "file", file: f.path, display: f.display, line: typeof f.error === "object" ? f.error.line : null, message: `${f.display} is not valid JSON${typeof f.error === "object" ? ` (${f.error.message})` : ""}, and it holds MCP approval or policy keys`, does: "Claude Code ignores the whole settings file: the approvals and lists in it do nothing", fix: "Keep to strict JSON (claude-settings-doctor lint shows the line)." });
    }
  }

  // --- definitions
  for (const d of model.defs) {
    if (!d.validation.ok) {
      add({ id: "skipped-server", severity: "error", effect: "server", ...defFields(d), message: `"${d.name}": ${d.validation.message}`, does: "Claude Code skips this server (`claude mcp list`: \"Skipped —\" and the same words)", fix: "Fix the entry." });
    }
  }

  // --- servers
  for (const s of model.servers) {
    const valid = s.defs.filter((d) => d.validation.ok);
    // a name defined more than once
    if (valid.length > 1) {
      const used = s.winner || s.headlessWinner || valid[0];
      const eps = new Set(valid.map((d) => (d.view ? endpointOf(d.view) : "")));
      const others = valid.filter((d) => d !== used);
      add({ id: "duplicate-name", severity: eps.size > 1 ? "warning" : "note", effect: "name", ...defFields(used), message: `"${s.name}" is defined in ${valid.map((d) => `${d.scopeLabel} (${d.display}${d.line ? `:${d.line}` : ""})`).join(" and ")}${eps.size > 1 ? ", with different commands or URLs" : ", with the same command or URL"}`, does: `Claude Code uses the ${used.scopeLabel} definition whole (${used.display}) and ignores ${others.map((d) => `the ${d.scopeLabel} one`).join(" and ")}; fields are not merged`, fix: eps.size > 1 && ["user", "local", "project"].includes(others[0].scopeLabel) ? `Keep one: claude mcp remove ${s.name} -s ${others[0].scopeLabel}` : null });
    }
    const def = s.winner || s.headlessWinner || s.def;
    const view = def.view;
    const relevant = s.state === "active" || s.state === "pending";

    if (s.state === "pending") {
      const inactive = s.approval && s.approval.inactive && s.approval.inactive.length;
      add({ id: "unapproved", severity: "warning", effect: "approval", ...defFields(def), message: `"${s.name}" in ${def.display} is not approved${inactive ? " (an approval exists in a settings file of the project, but the folder is not trusted yet)" : ""}`, does: "a session of Claude Code asks before it starts it; `claude mcp list` says \"Pending approval\"; `claude -p` loads it without asking", fix: `claude-mcp-check toggle ${s.name} --on` });
    } else if (s.state === "rejected") {
      add({ id: "rejected", severity: "note", effect: "approval", ...defFields(def), message: `"${s.name}" is rejected by disabledMcpjsonServers (${(s.approval ? s.approval.by : []).map((b) => b.file).join(", ")})`, does: "Claude Code does not load it (`claude -p` loaded no rejected server in any permission mode tried); `claude mcp list` leaves it out", fix: `claude-mcp-check toggle ${s.name} --on` });
    } else if (s.state === "disabled") {
      add({ id: "disabled-for-project", severity: "note", effect: "name", ...defFields(def), message: `"${s.name}" is switched off for this project (disabledMcpServers in ${ctx.claudeJson.display})`, does: "Claude Code does not connect to it (`claude mcp list`: \"Disabled for this project\")", fix: `claude-mcp-check toggle ${s.name} --on` });
    } else if (s.state === "blocked") {
      const by = s.policy.by || {};
      add({ id: "blocked-by-policy", severity: "note", effect: "name", ...defFields(def), message: `"${s.name}" is kept out by ${by.list}${by.entry ? ` ${JSON.stringify(by.entry)}` : ""}${by.file ? ` in ${by.file}` : ""}`, does: "Claude Code neither lists it nor starts it", fix: null });
    } else if (s.state === "duplicate") {
      add({ id: "plugin-duplicate", severity: "note", effect: "server", ...defFields(def), message: `the plugin server "${s.name}" has the same command or URL as "${s.duplicateOf}"`, does: "Claude Code connects the other one and leaves this one out", fix: null });
    }
    if (!relevant || !view) continue;

    // commands
    if (view.type === "stdio") {
      const spec = launchSpec(def, ctx, view);
      if (!spec.resolved.found) {
        add({ id: "command-not-found", severity: "warning", effect: "server", ...defFields(def), message: `"${s.name}": the command "${spec.command}" is ${spec.resolved.reason === "not-executable" ? "not executable" : "not on the PATH"}${spec.resolved.reason === "not-executable" ? "" : ` (the PATH of the server's env, ${spec.resolved.searched.length} folder${spec.resolved.searched.length === 1 ? "" : "s"})`}`, does: `the server cannot start; Claude Code reports ${ctx.platform === "win32" ? "only " : ""}"${notFoundWords(ctx.platform)}"`, fix: ctx.platform !== "win32" && /\s/.test(spec.command) ? "Put the program alone in `command` and its arguments in `args`: Claude Code does not split `command` at spaces on Linux and macOS." : "Install it, or write its full path in `command`." });
      }
    }
    // variables
    const unset = view.refs.missing;
    if (unset.length) {
      const names = [...new Set(unset.map((m) => m.name))];
      const inProject = names.filter((n) => facts.env.project[n] !== undefined || facts.env.local[n] !== undefined);
      const notes = [];
      if (inProject.length) notes.push(`${inProject.map((n) => `\${${n}}`).join(", ")} is set in the env of a project or local settings file, which Claude Code does not use for \${VAR} (it does reach the server's own environment)`);
      if (names.includes("CLAUDE_PROJECT_DIR") && !def.plugin) notes.push("CLAUDE_PROJECT_DIR is not available to ${VAR} outside a plugin: write ${CLAUDE_PROJECT_DIR:-.}");
      add({ id: "variable-unset", severity: "warning", effect: "server", ...defFields(def), message: `"${s.name}": ${names.map((n) => `\${${n}}`).join(", ")} ${names.length === 1 ? "is" : "are"} set nowhere (${[...new Set(unset.map((m) => m.field))].join(", ")})${notes.length ? `; ${notes.join("; ")}` : ""}`, does: "Claude Code passes the text \"${VAR}\" unchanged (and says so under \"MCP config diagnostics\" in `claude mcp list`)", fix: `Set ${names[0]} before you start Claude Code, or in "env" of your user settings.json, or write \${${names[0]}:-default}.` });
    }
    if (view.refs.readAsEmpty.length) {
      const names = [...new Set(view.refs.readAsEmpty.map((m) => m.name))];
      add({ id: "credential-read-as-empty", severity: "warning", effect: "server", ...defFields(def), message: `"${s.name}": ${names.map((n) => `\${${n}}`).join(", ")} in ${[...new Set(view.refs.readAsEmpty.map((m) => m.field))].join(", ")} reads as empty`, does: "Claude Code expands these credential names to nothing in the url and headers of a remote server, set or not", fix: "Copy the value to a variable of your own name and use that." });
    }
    // remote servers
    if (view.type !== "stdio" && view.url) {
      let u = null;
      try { u = new URL(view.url); } catch { /* not a URL */ }
      if (u && u.protocol === "http:" && !LOOPBACK.test(u.hostname)) add({ id: "plain-http", severity: "warning", effect: "none", ...defFields(def), message: `"${s.name}" talks to ${redactUrl(view.url).replace(/\?.*$/, "")} over plain http`, does: "everything it sends, headers and tokens included, can be read on the way", fix: "Use an https URL." });
      if (!u && view.refs.missing.length === 0) add({ id: "invalid-url", severity: "warning", effect: "server", ...defFields(def), message: `"${s.name}": the url "${redactUrl(view.url)}" cannot be parsed`, does: "Claude Code lists the server and fails to connect", fix: "Write a full URL, with its scheme." });
    }
    if ((view.type === "http" || view.type === "sse") && view.url === "") add({ id: "empty-url", severity: "note", effect: "server", ...defFields(def), message: `"${s.name}" has an empty url`, does: "Claude Code lists it as \"Not configured\" and does not connect", fix: "Set the url, or remove the server." });
  }

  // --- names that become the same tool prefix: one finding for each group
  for (const c of model.collisions) {
    const first = model.servers.find((s) => s.name === c.names[0]).def;
    add({ id: "name-collision", severity: "warning", effect: "name", ...defFields(first), message: `${c.names.map((n) => `"${n}"`).join(", ")} all become the tool prefix ${c.prefix}`, does: "only the tools of the server that connects first reach the model; the others are dropped without a word, although they show as connected", fix: "Rename all but one, with letters, digits, _ and - only." });
  }

  // --- the lists in the settings files
  for (const p of facts.problems) {
    const where = { file: p.file, display: p.display };
    const loc = p.file && ctx.settings.files.find((f) => f.path === p.file);
    const line = loc && loc.text ? locator(loc)([p.key]) : null;
    if (p.kind === "string" && /McpjsonServers$/.test(p.key)) {
      add({ id: "list-is-string", severity: "warning", effect: "file", ...where, line, message: `${p.key} is the text "${p.value}" and not a list`, does: "Claude Code before 2.1.299 ignores the whole settings file for this (seen with 2.1.295: the model setting next to it was dropped and nothing was approved or rejected); 2.1.299 and newer read one name made of letters, digits, - or _ as a list of one", fix: `Write ${p.key} as a list: ["${p.value}"].` });
    } else if (p.kind === "bad") {
      add({ id: "list-is-not-a-list", severity: "warning", effect: "none", ...where, line, message: `${p.key} is not a list of names`, does: /^(allowed|denied)McpServers$/.test(p.key) ? "Claude Code ignores the key" : /^(en|dis)abledMcpServers$/.test(p.key) ? "a non-list value crashed Claude Code at startup before 2.1.200; newer versions ignore it" : "Claude Code ignores the key or, before 2.1.299, the whole file", fix: "Write a list." });
    } else if (p.kind === "entries") {
      add({ id: "policy-entry", severity: "warning", effect: "none", ...where, line, message: `${p.count} entr${p.count === 1 ? "y" : "ies"} of ${p.key} ${p.count === 1 ? "is" : "are"} not an object with serverName, serverCommand or serverUrl`, does: "Claude Code ignores the list when its entries are of the wrong shape (seen: [\"name\"] blocked nothing)", fix: 'Write { "serverName": "name" } (or serverCommand, or serverUrl).' });
    }
  }
  // approvals that name no server
  const mcpJsonNames = new Set(model.defs.filter((d) => d.kind === "project").map((d) => d.name));
  if (mcpJsonNames.size || ctx.mcpJson.some((f) => f.exists)) {
    for (const [list, key] of [[facts.enabled, "enabledMcpjsonServers"], [facts.disabled, "disabledMcpjsonServers"]]) {
      for (const e of list) {
        if (e.scope === "user" || e.scope === "managed" || mcpJsonNames.has(e.name)) continue;
        const near = [...mcpJsonNames].filter((n) => n.toLowerCase().includes(e.name.toLowerCase()) || e.name.toLowerCase().includes(n.toLowerCase()));
        add({ id: "unknown-server-name", severity: "note", effect: "none", file: e.file, display: e.display, message: `${key} names "${e.name}", and no .mcp.json server has that name${near.length ? ` (did you mean ${listText(near)}?)` : ""}`, does: "the entry does nothing", fix: null });
      }
    }
  }
  // a server both approved and rejected
  const both = [...new Set(facts.enabled.map((e) => e.name))].filter((n) => facts.disabled.some((d) => d.name === n));
  for (const n of both) {
    const d = facts.disabled.find((x) => x.name === n);
    add({ id: "enabled-and-disabled", severity: "warning", effect: "approval", file: d.file, display: d.display, message: `"${n}" is in enabledMcpjsonServers (${facts.enabled.filter((e) => e.name === n).map((e) => e.display).join(", ")}) and in disabledMcpjsonServers (${facts.disabled.filter((x) => x.name === n).map((x) => x.display).join(", ")})`, does: "the rejection wins: Claude Code does not load it", fix: `Take it out of one of them (claude-mcp-check toggle ${n} --on clears the rejection in .claude/settings.local.json).` });
  }
  // .mcp.json files above the project
  ctx.mcpJson.forEach((f, i) => {
    if (i > 0 && f.exists && !f.error && isObject(f.data) && isObject(f.data.mcpServers) && Object.keys(f.data.mcpServers).length) {
      add({ id: "mcp-json-above-project", severity: "note", effect: "none", file: f.path, display: f.display, message: `${f.display} is in a folder above the project and holds ${Object.keys(f.data.mcpServers).length} server${Object.keys(f.data.mcpServers).length === 1 ? "" : "s"}`, does: "Claude Code reads the .mcp.json of every folder above the one it starts in, up to the root of the drive", fix: null });
    }
  });

  // errors first, then warnings, then notes; inside a severity by file and line (the sort is stable)
  findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || String(a.display).localeCompare(String(b.display)) || (a.line || 0) - (b.line || 0));
  return findings;
}

export const countFindings = (findings) => ({ error: findings.filter((f) => f.severity === "error").length, warning: findings.filter((f) => f.severity === "warning").length, note: findings.filter((f) => f.severity === "note").length });
