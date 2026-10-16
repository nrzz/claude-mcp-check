// `check`: starts the servers that Claude Code would start (or reaches the URLs it would reach), performs the MCP handshake,
// lists what each one offers and sizes the tool schemas. A server that Claude Code would not start (a .mcp.json server nobody
// approved, one that is rejected or switched off, one that a policy blocks, one that is skipped as invalid) is not started: a
// .mcp.json can come from a repository you cloned a minute ago, and running its commands is what the approval is for.
// `--include-unapproved` starts the unapproved ones anyway.
import { expandedView, launchSpec } from "./launch.mjs";
import { measureInstructions, measureTools } from "./measure.mjs";
import { probeStdio } from "./stdio.mjs";
import { probeHttp } from "./http.mjs";
import { redactArgs, redactCommand, redactText } from "./redact.mjs";

/** How long a server has to answer: --timeout, else MCP_TIMEOUT (what Claude Code waits), else its default of 30 seconds. */
export function timeoutFrom({ timeout, env = process.env } = {}) {
  const mcp = Number(env.MCP_TIMEOUT);
  const fromEnv = Number.isFinite(mcp) && mcp > 0 ? mcp : null;
  if (timeout !== undefined && timeout !== null) return { ms: timeout, source: "--timeout", mcpTimeout: fromEnv };
  if (fromEnv) return { ms: fromEnv, source: "MCP_TIMEOUT", mcpTimeout: fromEnv };
  return { ms: 30000, source: "default", mcpTimeout: null };
}

const REASONS = {
  pending: "not approved: Claude Code asks before it starts a .mcp.json server (use --include-unapproved to start it anyway)",
  rejected: "rejected by disabledMcpjsonServers: Claude Code does not start it",
  disabled: "switched off for this project (disabledMcpServers): Claude Code does not start it",
  blocked: "blocked by a policy list: Claude Code does not start it",
  skipped: "skipped: the definition is invalid",
  duplicate: "a duplicate: Claude Code connects the server with the same endpoint instead",
};

/** Starts and asks one server. Returns the result described at the top of the file. */
export async function checkServer(ctx, server, { timeoutMs = 30000, sendHeaders = false, includeUnapproved = false } = {}) {
  const out = { name: server.name, state: server.state, scope: server.def.scopeLabel, kind: server.def.kind, display: server.def.display, line: server.def.line, type: server.def.type, checked: false, skipped: null, ok: false, probe: null, command: null, url: null, refs: { missing: [], empty: [] }, counts: null, cost: null, notes: [] };
  let def = server.winner;
  if (server.state !== "active") {
    if (server.state === "pending" && includeUnapproved && server.headlessWinner) def = server.headlessWinner;
    else { out.skipped = REASONS[server.state] || `not started (${server.state})`; return out; }
  }
  if (!def) { out.skipped = REASONS.skipped; return out; }
  out.checked = true;
  out.type = def.type;
  out.scope = def.scopeLabel;
  out.display = def.display;
  const view = def.view || expandedView(def, ctx);
  out.refs = { missing: view.refs.missing, empty: view.refs.empty };

  let probe;
  if (def.type === "stdio") {
    const spec = launchSpec(def, ctx, view);
    out.command = { command: redactCommand(spec.command), args: redactArgs(spec.args), resolved: spec.resolved.found ? spec.resolved.path : null, via: spec.resolved.via, searched: spec.resolved.found ? [] : spec.resolved.searched.slice(0, 12), reason: spec.resolved.reason };
    probe = await probeStdio(spec, { timeoutMs });
    probe.stderr = redactText(probe.stderr);
    probe.other.samples = probe.other.samples.map(redactText);
  } else {
    probe = await probeHttp(view, { timeoutMs, sendHeaders });
    out.url = probe.url;
  }
  out.probe = probe;
  const init = probe.initialize;
  out.ok = Boolean(init && init.ok);
  if (out.ok) {
    const tools = probe.tools && probe.tools.ok ? probe.tools.items : [];
    out.counts = { tools: tools.length, resources: probe.resources && probe.resources.ok ? probe.resources.items.length : null, prompts: probe.prompts && probe.prompts.ok ? probe.prompts.items.length : null };
    out.cost = { tools: measureTools(server.name, tools), instructions: measureInstructions(init.instructions) };
    if (server.sharesPrefixWith.length) out.notes.push(`its tool prefix ${server.toolPrefix} is shared with ${server.sharesPrefixWith.map((n) => `"${n}"`).join(", ")}: only the tools of the server that connects first reach the model`);
  }
  return out;
}

/** Runs `fn` over the items, `width` at a time, and keeps the order. */
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

/** Checks every server of the model (or the one called `name`). */
export async function checkServers(ctx, model, { name, timeoutMs, sendHeaders, includeUnapproved } = {}) {
  const servers = name ? model.servers.filter((s) => s.name === name) : model.servers;
  return pool(servers, 4, (s) => checkServer(ctx, s, { timeoutMs, sendHeaders, includeUnapproved }));
}
