// Switching a server on or off for a project, with the keys and files that the real binary honours (README, "What was
// verified"):
//   a .mcp.json server   disabledMcpjsonServers rejects it (also with enableAllProjectMcpServers); enabledMcpjsonServers approves it.
//                        Both are lists in the project's .claude/settings.local.json, the file `claude mcp reset-project-choices` clears
//                        and the one that is not checked into the repository. --off adds the name to disabledMcpjsonServers; --on
//                        takes it out, and approves the server when nothing else does.
//   any other server     disabledMcpServers in ~/.claude.json, under projects["<project key>"]: the list that
//                        `claude mcp list` calls "Disabled for this project". --off adds the name, --on takes it out.
// Nothing is written without a backup next to the file, only the one list is changed (the text of the file is edited, nothing
// else moves), a file that is not valid JSON is left alone, and ~/.claude.json is written under the lock Claude Code uses.
import fs from "node:fs";
import { findMember, insertItem, insertMember, parseDoc, removeItem, removeMember, replaceNode, valueOf } from "./jsonedit.mjs";
import { localSettingsPaths, shortPath } from "./paths.mjs";
import { approvalOf } from "./state.mjs";
import { withClaudeJsonLock, writeWithBackup } from "./write.mjs";

/**
 * Adds or removes a name in a list of the JSON text `text`, where the list is `listKey` of the object at `ownerKeys`.
 * Returns { text, changed } or { error }. A missing object or list is created by an add; a list that holds a plain string
 * (one name) becomes a list; the last name taken out takes the key with it.
 */
export function editNameList(text, ownerKeys, listKey, name, op) {
  const doc = parseDoc(text);
  if (!doc.ok) return { error: `is not valid JSON (${doc.reason})` };
  if (doc.root.type !== "object") return { error: "does not hold a JSON object" };
  let node = doc.root;
  for (let i = 0; i < ownerKeys.length; i++) {
    const found = findMember(node, ownerKeys[i]);
    if (!found) {
      if (op === "remove") return { text, changed: false };
      let nested = { [listKey]: [name] };
      for (const k of ownerKeys.slice(i + 1).reverse()) nested = { [k]: nested };
      return { text: insertMember(text, node, ownerKeys[i], nested), changed: true };
    }
    node = found.member.value;
    if (node.type !== "object") return { error: `holds "${ownerKeys[i]}" that is not an object` };
  }
  const found = findMember(node, listKey);
  if (!found) {
    if (op === "remove") return { text, changed: false };
    return { text: insertMember(text, node, listKey, [name]), changed: true };
  }
  const list = found.member.value;
  if (list.type === "array") {
    const at = list.items.findIndex((it) => it.type === "string" && valueOf(text, it) === name);
    if (op === "add") return at >= 0 ? { text, changed: false } : { text: insertItem(text, list, name), changed: true };
    if (at < 0) return { text, changed: false };
    if (list.items.length === 1) return { text: removeMember(text, node, found.index), changed: true };
    return { text: removeItem(text, list, at), changed: true };
  }
  if (list.type === "string") {
    const current = valueOf(text, list);
    if (op === "add") return current === name ? { text, changed: false } : { text: replaceNode(text, list, [current, name]), changed: true };
    return current === name ? { text: removeMember(text, node, found.index), changed: true } : { text, changed: false };
  }
  return { error: `holds "${listKey}" that is neither a list nor a name` };
}

const similar = (name, names) => names.filter((n) => n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(n.toLowerCase())).slice(0, 5);

/**
 * Plans what `toggle <name> --on|--off` would do. Returns { name, on, ok, refused, kind, mechanism, changes, notes, before }:
 *   changes   [{ target: "settings-local" | "claude-json", file, display, ownerKeys, key, op, item }]
 *   refused   why nothing is done (a string), or null
 */
export function planToggle(ctx, model, name, on) {
  const plan = { name, on, ok: false, refused: null, kind: null, mechanism: null, changes: [], notes: [], before: null };
  const server = model.servers.find((s) => s.name === name);
  if (!server) {
    const near = similar(name, model.servers.map((s) => s.name));
    plan.refused = `there is no server called "${name}"${near.length ? ` (did you mean ${near.map((n) => `"${n}"`).join(", ")}?)` : ""}`;
    return plan;
  }
  plan.before = server.state;
  const def = server.winner || server.headlessWinner || server.def;
  plan.kind = def.kind;
  if (def.kind === "flag") { plan.refused = `"${name}" comes from --mcp-config and exists for one run only: leave it off the command line`; return plan; }
  if (!def.validation.ok) { plan.refused = `"${name}" is skipped by Claude Code (${def.validation.message}); fix the definition first`; return plan; }

  const localFile = localSettingsPaths(ctx.project, { home: ctx.home, platform: ctx.platform })[0];
  const settingsLocal = (key, op) => ({ target: "settings-local", file: localFile, display: shortPath(localFile, { home: ctx.home, project: ctx.project }), ownerKeys: [], key, op, item: name });
  const claudeJson = (op) => ({ target: "claude-json", file: ctx.claudeJson.path, display: ctx.claudeJson.display, ownerKeys: ["projects", ctx.projectKey], key: "disabledMcpServers", op, item: name });
  const inClaudeJson = ctx.facts.disabledForProject.some((x) => x.name === name);

  if (server.policy && server.policy.blocked && on) {
    const by = server.policy.by;
    plan.refused = `"${name}" is blocked by ${by.list}${by.file ? ` (${by.file})` : ""}: that list is not changed here`;
    return plan;
  }

  if (def.kind === "project") {
    plan.mechanism = "settings.local.json";
    if (!on) {
      if (server.state === "rejected") plan.notes.push(`"${name}" is already rejected (disabledMcpjsonServers)`);
      else plan.changes.push(settingsLocal("disabledMcpjsonServers", "add"));
    } else {
      const rejectedElsewhere = ctx.facts.disabled.filter((d) => d.name === name && d.file !== localFile);
      if (rejectedElsewhere.length) {
        plan.refused = `"${name}" is also rejected in ${rejectedElsewhere.map((d) => d.display).join(", ")}; take it out there, this tool writes only ${shortPath(localFile, { home: ctx.home, project: ctx.project })}`;
        return plan;
      }
      if (ctx.facts.disabled.some((d) => d.name === name)) plan.changes.push(settingsLocal("disabledMcpjsonServers", "remove"));
      // approved by something else once the rejection is gone?
      const withoutRejection = approvalOf(name, { ...ctx.facts, disabled: [] });
      if (withoutRejection.state !== "approved") {
        plan.changes.push(settingsLocal("enabledMcpjsonServers", "add"));
        if (!ctx.trusted) plan.notes.push("this folder is not trusted yet: approvals in the project's own settings files count only after you accept the trust dialog (run claude here once), or put the approval in your user settings");
      }
      if (inClaudeJson) plan.changes.push(claudeJson("remove"));
    }
  } else {
    plan.mechanism = "disabledMcpServers";
    if (!ctx.claudeJson.exists) {
      plan.refused = `${ctx.claudeJson.display} does not exist; there is nothing to switch`;
      return plan;
    }
    if (ctx.claudeJson.error) {
      plan.refused = `${ctx.claudeJson.display} is not valid JSON; it is left alone`;
      return plan;
    }
    if (!on) {
      if (server.state === "disabled") plan.notes.push(`"${name}" is already disabled for this project`);
      else plan.changes.push(claudeJson("add"));
    } else if (inClaudeJson) plan.changes.push(claudeJson("remove"));
    else plan.notes.push(`"${name}" is not disabled for this project`);
    if (def.kind === "managed" || def.kind === "managed-file") plan.notes.push("this server is provided by your organization; this writes the project's own list in ~/.claude.json, and what Claude Code does with that list for a managed server was not tried");
  }
  plan.ok = true;
  return plan;
}

/** The new text for one change, or { error }, or { changed: false }. */
function newTextFor(change, current) {
  if (current === null || current === undefined || current.replace(/^﻿/, "").trim() === "") {
    if (change.op === "remove") return { text: current, changed: false };
    let nested = { [change.key]: [change.item] };
    for (const k of [...change.ownerKeys].reverse()) nested = { [k]: nested };
    return { text: `${JSON.stringify(nested, null, 2)}\n`, changed: true, created: current === null || current === undefined };
  }
  return editNameList(current, change.ownerKeys, change.key, change.item, change.op);
}

/**
 * Does the plan: each file is backed up (next to itself), changed in the one list and written through a temporary file.
 * With dryRun nothing is written. Returns { ok, refused, dryRun, changes: [{ ...change, changed, backup, created }] }.
 */
export function applyToggle(ctx, plan, { dryRun = false, now = new Date() } = {}) {
  const result = { ...plan, dryRun, changes: [] };
  if (!plan.ok) return result;
  const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
  // Settings files first: compute every new text before anything is written, so that a refusal changes nothing.
  const staged = [];
  for (const change of plan.changes) {
    if (change.target === "claude-json") { staged.push({ change }); continue; }
    const current = readText(change.file);
    const r = newTextFor(change, current);
    if (r.error) { result.ok = false; result.refused = `${change.display} ${r.error}; it is left alone`; result.changes = []; return result; }
    staged.push({ change, current, r });
  }
  const done = [];
  for (const s of staged) {
    const { change } = s;
    if (change.target === "settings-local") {
      const entry = { ...change, changed: Boolean(s.r.changed), backup: null, created: Boolean(s.r.created) };
      if (s.r.changed && !dryRun) entry.backup = writeWithBackup(change.file, s.r.text, { now }).backup;
      done.push(entry);
      continue;
    }
    // ~/.claude.json: the lock, then the file as it is now
    const run = () => {
      const current = readText(change.file);
      if (current === null) return { ...change, changed: false, backup: null, error: `${change.display} does not exist` };
      const r = newTextFor(change, current);
      if (r.error) return { ...change, changed: false, backup: null, error: `${change.display} ${r.error}` };
      const entry = { ...change, changed: Boolean(r.changed), backup: null };
      if (r.changed && !dryRun) entry.backup = writeWithBackup(change.file, r.text, { now }).backup;
      return entry;
    };
    let entry;
    try { entry = dryRun ? run() : withClaudeJsonLock(change.file, run); } catch (e) { entry = { ...change, changed: false, backup: null, error: String(e.message || e) }; }
    if (entry.error) { result.ok = false; result.refused = `${entry.error}${/left alone|locked/.test(entry.error) ? "" : "; it is left alone"}`; result.changes = done; return result; }
    done.push(entry);
  }
  result.changes = done;
  return result;
}
