// From the definitions to the servers Claude Code would load: which definition of a name wins, whether a .mcp.json server is
// approved, rejected or pending, whether the project has switched it off, whether a policy list blocks it, whether two names
// share a tool prefix, and what `claude -p` does differently. Every rule was put to the real binary (README, "What was
// verified"); where two answers are possible the interactive session's answer is `state` and the other one is `headless`.
//
// state       active    Claude Code connects it
//             pending   a .mcp.json server nobody approved: a session asks first, `claude -p` loads it anyway
//             rejected  a .mcp.json server that a disabledMcpjsonServers entry rejects
//             disabled  the project switched it off (disabledMcpServers in .claude.json: `claude mcp list` says "Disabled for this project")
//             blocked   allowedMcpServers or deniedMcpServers keep it out: it is not listed anywhere
//             skipped   every definition of the name is invalid: Claude Code skips it
//             duplicate a plugin's server with the endpoint of another server: Claude Code connects the other one
import { discoverServers } from "./servers.mjs";
import { evaluatePolicy } from "./policy.mjs";
import { endpointOf, expandedView } from "./launch.mjs";
import { normalizeName } from "./names.mjs";

/** The approval of a .mcp.json server by name: { state: "approved" | "pending" | "rejected", by, inactive }. */
export function approvalOf(name, facts) {
  const rejectedBy = facts.disabled.filter((d) => d.name === name);
  if (rejectedBy.length) return { state: "rejected", by: rejectedBy.map(sourceOf), inactive: [] };
  const all = facts.enableAll.filter((e) => e.counts);
  const named = facts.enabled.filter((e) => e.name === name && e.counts);
  if (all.length || named.length) return { state: "approved", by: [...named.map((e) => ({ ...sourceOf(e), key: "enabledMcpjsonServers" })), ...all.map((e) => ({ ...sourceOf(e), key: "enableAllProjectMcpServers" }))], inactive: [] };
  const inactive = [...facts.enableAll.filter((e) => !e.counts).map((e) => ({ ...sourceOf(e), key: "enableAllProjectMcpServers" })), ...facts.enabled.filter((e) => e.name === name && !e.counts).map((e) => ({ ...sourceOf(e), key: "enabledMcpjsonServers" }))];
  return { state: "pending", by: [], inactive };
}
const sourceOf = (x) => ({ scope: x.scope, file: x.display || x.file });

const byPrecedence = (a, b) => b.rank - a.rank || b.order - a.order || a.id - b.id;

/**
 * Resolves the definitions into servers. Returns the model that show, check, why, lint and toggle work from:
 *   { servers, defs, sources, problems, collisions, notes }
 * Each server: { name, state, loads, headless, def, winner, headlessWinner, defs, approval, disabledBy, policy, view, endpoint,
 *   toolPrefix, normalized, sharesPrefixWith, notes }.
 */
export function buildModel(ctx) {
  const { defs, sources, problems } = discoverServers(ctx);
  const facts = ctx.facts;
  const byName = new Map();
  for (const d of defs) { if (!byName.has(d.name)) byName.set(d.name, []); byName.get(d.name).push(d); }

  const exclusive = defs.some((d) => d.kind === "managed-file" && d.validation.ok) || (ctx.managedMcp.exists && !ctx.managedMcp.error);
  const policyLists = { allowed: facts.allowed, denied: facts.denied, allowDefined: facts.allowDefined, allowFiles: facts.allowFiles };
  const servers = [];

  for (const [name, group] of byName) {
    group.sort(byPrecedence);
    // roles of the definitions
    for (const d of group) {
      d.view = d.validation.ok ? expandedView(d, ctx) : null;
      d.approval = d.kind === "project" ? approvalOf(name, facts) : null;
    }
    const valid = group.filter((d) => d.validation.ok);
    const interactive = valid.filter((d) => d.kind !== "project" || d.approval.state === "approved");
    const headlessCands = valid.filter((d) => d.kind !== "project" || d.approval.state !== "rejected");
    const winner = interactive[0] || null;
    const headlessWinner = headlessCands[0] || null;
    const display = winner || headlessWinner || group[0];
    const server = { name, normalized: normalizeName(name), toolPrefix: `mcp__${normalizeName(name)}__`, defs: group, winner, headlessWinner, def: display, notes: [], sharesPrefixWith: [], policy: { blocked: false, by: null }, disabledBy: null, approval: display.approval || null, view: display.view, endpoint: display.view ? endpointOf(display.view) : null };

    for (const d of group) {
      if (!d.validation.ok) d.role = "skipped";
      else if (d.kind === "project" && d.approval.state === "rejected") d.role = "rejected";
      else if (d === winner) d.role = "winner";
      else if (d.kind === "project" && d.approval.state !== "approved") d.role = "pending";
      else d.role = "shadowed";
    }
    for (const d of group) if (d.role === "shadowed" && winner) d.shadowedBy = winner;
    if (headlessWinner && headlessWinner !== winner) server.headless = { def: headlessWinner, differs: true };

    // exclusive control by managed-mcp.json
    const managedOk = (d) => d.kind === "managed-file" || d.kind === "managed";
    if (exclusive && display && !managedOk(display) && !valid.some(managedOk)) {
      server.state = "blocked";
      server.policy = { blocked: true, by: { list: "managed-mcp.json", entry: null, file: ctx.managedMcp.display } };
    } else if (!winner && !headlessWinner) {
      server.state = group.some((d) => d.role === "rejected") ? "rejected" : "skipped";
    } else {
      // policy and the project's own switch apply to the definition that was picked, then the name is gone
      const chosen = winner || headlessWinner;
      const v = chosen.view;
      const skipAllow = chosen.kind === "managed" || (chosen.kind === "managed-file" && !(v.refs.missing.length || v.refs.empty.length || v.refs.defaulted.length));
      const lists = skipAllow ? { ...policyLists, allowDefined: false } : policyLists;
      const pol = evaluatePolicy(lists, { name, type: v.type, command: v.command, args: v.args, url: v.url }, { env: ctx.expansionEnv, platform: ctx.platform });
      server.policy = pol;
      const off = facts.disabledForProject.find((x) => x.name === name);
      if (pol.blocked) server.state = "blocked";
      else if (!winner) server.state = "pending";
      else if (off) { server.state = "disabled"; server.disabledBy = off; }
      else server.state = "active";
    }
    server.loads = server.state === "active";
    // what `claude -p` does: it loads a pending .mcp.json server, and nothing that a rejection, the project's switch or a policy keeps out
    server.headlessLoads = server.state === "active" || (server.state === "pending" && !server.policy.blocked && !facts.disabledForProject.some((x) => x.name === name));
    servers.push(server);
  }

  // a plugin's server that points where another server already points is a duplicate: Claude Code connects the other one
  const endpoints = new Map();
  for (const s of servers) if (s.def.kind !== "plugin" && (s.state === "active" || s.state === "pending") && s.endpoint) if (!endpoints.has(s.endpoint)) endpoints.set(s.endpoint, s);
  for (const s of servers) {
    if (s.def.kind === "plugin" && s.state === "active" && s.endpoint && endpoints.has(s.endpoint)) {
      s.state = "duplicate";
      s.loads = false;
      s.headlessLoads = false;
      s.duplicateOf = endpoints.get(s.endpoint).name;
    }
  }

  // two names that become the same tool prefix: the tools of the server that connects first stay, the others are dropped (put to the
  // binary: with equal servers the first in the file usually wins, with a slower first server the second did)
  const collisions = [];
  const groups = new Map();
  for (const s of servers) if (s.headlessLoads || s.loads) { if (!groups.has(s.normalized)) groups.set(s.normalized, []); groups.get(s.normalized).push(s); }
  for (const [normalized, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.def.order - b.def.order || a.def.id - b.def.id);
    for (const s of list) s.sharesPrefixWith = list.filter((o) => o !== s).map((o) => o.name);
    collisions.push({ normalized, prefix: `mcp__${normalized}__`, names: list.map((s) => s.name) });
  }

  // order: the highest precedence first, then by name
  servers.sort((a, b) => b.def.rank - a.def.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { servers, defs, sources, problems, collisions, facts, exclusive };
}
