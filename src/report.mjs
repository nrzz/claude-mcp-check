// The reports: text for a terminal, one JSON document for --json, and the short markdown that the skill hands to Claude.
// Nothing printed here may be a secret: environment values and header values are never shown (their names are), and
// arguments and URLs go through redact.mjs.
import { VERSION } from "./version.mjs";
import { redactArgs, redactCommand, redactText, redactUrl } from "./redact.mjs";
import { countFindings } from "./lint.mjs";
import { RESOURCE_TOOLS } from "./measure.mjs";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - String(s).length));
const num = (n) => Number(n).toLocaleString("en-US");
const where = (d) => (d ? `${d.display}${d.line ? `:${d.line}` : ""}` : "");

function table(rows, widths) {
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : pad(c, widths[i]))).join("  ").trimEnd());
}

const STATE_TEXT = {
  active: "active",
  pending: "pending approval",
  rejected: "rejected",
  disabled: "disabled for this project",
  blocked: "blocked by policy",
  skipped: "skipped (invalid)",
  duplicate: "duplicate of another server",
};

/** What a definition points at, with credentials hidden. */
function target(d) {
  if (!d.view) return "";
  if (d.view.type === "stdio") return [redactCommand(d.entry.command === undefined ? "" : String(d.entry.command)), ...redactArgs(Array.isArray(d.entry.args) ? d.entry.args.map(String) : [])].join(" ").trim();
  return redactUrl(typeof d.entry.url === "string" ? d.entry.url : "");
}
const transportOf = (d) => d.type || (d.entry && typeof d.entry === "object" && d.entry.url !== undefined ? "?" : "stdio");

export const keyPathText = (d) => d.keyPath.map((k, i) => (typeof k === "number" ? `[${k}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? (i ? `.${k}` : k) : `["${k}"]`)).join("");

// ---------------------------------------------------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------------------------------------------------

export function showJson(ctx, model) {
  const defView = (d) => ({
    scope: d.scopeLabel, kind: d.kind, role: d.role, file: d.file, display: d.display, line: d.line || null, keyPath: keyPathText(d), transport: transportOf(d),
    ...(d.view ? (d.view.type === "stdio" ? { command: redactCommand(d.entry.command === undefined ? "" : String(d.entry.command)), args: redactArgs(Array.isArray(d.entry.args) ? d.entry.args.map(String) : []) } : { url: redactUrl(typeof d.entry.url === "string" ? d.entry.url : "") }) : {}),
    ...(d.validation.ok ? {} : { invalid: d.validation.message }),
    ...(d.approval ? { approval: d.approval.state } : {}),
  });
  return {
    project: ctx.project, projectKey: ctx.projectKey, trusted: ctx.trusted, configDir: ctx.configDir, configSource: ctx.configSource, claudeJson: { path: ctx.claudeJson.path, exists: ctx.claudeJson.exists, error: ctx.claudeJson.error ? (typeof ctx.claudeJson.error === "string" ? ctx.claudeJson.error : ctx.claudeJson.error.message) : null },
    sources: model.sources.map((s) => ({ kind: s.kind, file: s.file, display: s.display, exists: s.exists, servers: s.servers, ...(s.note ? { note: s.note } : {}) })),
    servers: model.servers.map((s) => {
      const d = s.def;
      const w = s.winner || s.headlessWinner;
      return {
        name: s.name, state: s.state, loads: s.loads, headlessLoads: s.headlessLoads,
        scope: d.scopeLabel, kind: d.kind, transport: transportOf(d),
        file: d.file, display: d.display, line: d.line || null, keyPath: keyPathText(d),
        ...(d.view ? (d.view.type === "stdio" ? { command: redactCommand(d.entry.command === undefined ? "" : String(d.entry.command)), args: redactArgs(Array.isArray(d.entry.args) ? d.entry.args.map(String) : []), envNames: Object.keys(d.entry.env && typeof d.entry.env === "object" ? d.entry.env : {}) } : { url: redactUrl(typeof d.entry.url === "string" ? d.entry.url : ""), headerNames: Object.keys(d.entry.headers && typeof d.entry.headers === "object" ? d.entry.headers : {}) }) : {}),
        approval: s.approval ? { state: s.approval.state, by: s.approval.by, inactive: s.approval.inactive } : null,
        disabledBy: s.disabledBy ? { file: s.disabledBy.display } : null,
        policy: s.policy.blocked ? { blocked: true, ...s.policy.by } : { blocked: false },
        toolPrefix: s.toolPrefix, sharesPrefixWith: s.sharesPrefixWith,
        headless: s.headless ? { scope: s.headless.def.scopeLabel, display: s.headless.def.display, line: s.headless.def.line || null } : null,
        ...(s.duplicateOf ? { duplicateOf: s.duplicateOf } : {}),
        references: w && w.view ? { missing: w.view.refs.missing, empty: w.view.refs.empty, readAsEmpty: w.view.refs.readAsEmpty } : { missing: [], empty: [], readAsEmpty: [] },
        ...(d.plugin ? { plugin: { id: d.plugin.id, version: d.plugin.version || null } } : {}),
        definitions: s.defs.map(defView),
      };
    }),
    collisions: model.collisions,
    problems: model.problems.map((p) => ({ id: p.id, file: p.file, display: p.display, line: p.line || null, message: p.message })),
    counts: { servers: model.servers.length, active: model.servers.filter((s) => s.loads).length, pending: model.servers.filter((s) => s.state === "pending").length },
  };
}

export function showText(ctx, model) {
  const out = [];
  out.push(`claude-mcp-check ${VERSION}  the MCP servers Claude Code would load`);
  out.push(`project   ${ctx.project}${ctx.projectKey !== ctx.project.split("\\").join("/") ? `  (project key ${ctx.projectKey}: the root of the git repository)` : ""}`);
  out.push(`config    ${ctx.configDir}  (${ctx.configSource === "CLAUDE_CONFIG_DIR" ? "from CLAUDE_CONFIG_DIR" : "default"}); servers in ${ctx.claudeJson.display}${ctx.claudeJson.exists ? "" : " (not found)"}`);
  out.push(`trust     ${ctx.trusted ? "this folder is trusted" : "this folder is not trusted yet: its own settings files approve no .mcp.json server"}`);
  out.push("");
  out.push("Where servers come from, highest precedence first");
  const rows = model.sources.map((s) => [s.kind === "flag" ? "--mcp-config" : s.kind === "managed-file" || s.kind === "managed" ? "managed" : s.kind, !s.exists ? "not found" : plural(s.servers, "server"), `${s.display}${s.note && s.exists ? `  (${s.note})` : ""}`]);
  out.push(...table(rows, [12, 10]).map((l) => `  ${l}`));
  for (const p of model.problems) out.push("", `! ${p.display}${p.line ? `:${p.line}` : ""}  ${p.message}`, `    ${p.effect}`);
  out.push("");
  const loading = model.servers.filter((s) => s.loads).length;
  out.push(`Servers (${model.servers.length}; ${loading} active)`);
  if (!model.servers.length) out.push("  none: Claude Code has no MCP server to start for this project");
  const wName = Math.min(28, Math.max(4, ...model.servers.map((s) => s.name.length)));
  for (const s of model.servers) {
    const d = s.def;
    out.push(`  ${pad(s.name, wName)}  ${pad(d.scopeLabel, 12)}  ${pad(transportOf(d), 5)}  ${pad(STATE_TEXT[s.state] || s.state, 26)}  ${target(d)}`);
    const sub = [];
    sub.push(`from ${where(d)}  ${keyPathText(d)}`);
    for (const o of s.defs) {
      if (o === d) continue;
      if (o.role === "skipped") sub.push(`${o.scopeLabel} definition in ${where(o)} is skipped: ${o.validation.message}`);
      else if (o.role === "shadowed") sub.push(`also defined in ${o.scopeLabel} (${where(o)}): not used, Claude Code takes the ${d.scopeLabel} entry whole`);
      else if (o.role === "pending") sub.push(`also defined in ${o.scopeLabel} (${where(o)}): not approved, so a session uses ${d.scopeLabel}${s.headless ? "; claude -p loads that one instead" : ""}`);
      else if (o.role === "rejected") sub.push(`also defined in ${o.scopeLabel} (${where(o)}): rejected`);
    }
    if (s.approval && s.approval.state !== "n/a") {
      if (s.approval.state === "approved") sub.push(`approved by ${s.approval.by.map((b) => `${b.key} in ${b.file}`).join(", ")}`);
      else if (s.approval.state === "rejected") sub.push(`rejected by disabledMcpjsonServers in ${s.approval.by.map((b) => b.file).join(", ")}`);
      else { sub.push("not approved: a session asks first; claude -p loads it without asking"); if (s.approval.inactive.length) sub.push(`approval in ${s.approval.inactive.map((i) => i.file).join(", ")} does not count: the folder is not trusted yet`); }
    }
    if (s.disabledBy) sub.push(`disabledMcpServers lists it for this project (${ctx.claudeJson.display}); claude mcp list says "Disabled for this project"`);
    if (s.policy.blocked) { const by = s.policy.by || {}; sub.push(`${by.list}${by.entry ? ` ${JSON.stringify(by.entry)}` : ""}${by.file ? ` in ${by.file}` : ""} keeps it out: Claude Code does not list or start it`); }
    if (s.sharesPrefixWith.length) sub.push(`shares the tool prefix ${s.toolPrefix} with ${s.sharesPrefixWith.map((n) => `"${n}"`).join(", ")}: only the tools of the server that connects first reach the model`);
    if (s.duplicateOf) sub.push(`a plugin server with the endpoint of "${s.duplicateOf}": Claude Code connects that one`);
    const entry = d.entry && typeof d.entry === "object" ? d.entry : {};
    if (entry.env && typeof entry.env === "object" && Object.keys(entry.env).length) sub.push(`env ${Object.keys(entry.env).join(", ")}  (values are never printed)`);
    if (entry.headers && typeof entry.headers === "object" && Object.keys(entry.headers).length) sub.push(`headers ${Object.keys(entry.headers).join(", ")}  (values are never printed)`);
    const w = s.winner || s.headlessWinner;
    if (w && w.view && w.view.refs.missing.length) sub.push(`\${${[...new Set(w.view.refs.missing.map((m) => m.name))].join("}, ${")}} is set nowhere: Claude Code passes the text unchanged`);
    for (const l of sub) out.push(`      ${l}`);
  }
  if (model.collisions.length) {
    out.push("", "Names that share a tool prefix (only the tools of the server that connects first reach the model)");
    for (const c of model.collisions) out.push(`  ${c.prefix}  ${c.names.map((n) => `"${n}"`).join(", ")}`);
  }
  out.push("", "Claude.ai connectors are fetched by Claude Code at start and are not listed here. Managed servers are read from the documented files only.");
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------------------------------

export function checkJson(ctx, results, { timeout }) {
  const slim = (r) => {
    const p = r.probe;
    return {
      name: r.name, state: r.state, scope: r.scope, transport: r.type, checked: r.checked, skipped: r.skipped, ok: r.ok,
      command: r.command ? { command: r.command.command, args: r.command.args, resolved: r.command.resolved, via: r.command.via } : null,
      url: r.url,
      references: r.refs,
      process: p && "pid" in p ? { started: p.started, spawnError: p.spawnError, exit: p.exit, timedOut: p.timedOut, killed: p.killed, stderr: p.stderr, nonJsonLines: p.other.lines, nonJsonSamples: p.other.samples } : null,
      http: p && "outcome" in p ? { status: p.status, outcome: p.outcome, detail: p.detail, headerNames: p.headerNames, sentHeaders: p.sentHeaders, note: p.note } : null,
      initialize: p && p.initialize ? { ok: p.initialize.ok, ms: p.initialize.ms, protocolVersion: p.initialize.protocolVersion || null, serverInfo: p.initialize.serverInfo || null, capabilities: p.initialize.capabilities || null, error: p.initialize.error || null } : null,
      counts: r.counts,
      tools: p && p.tools ? { ok: p.tools.ok, names: (p.tools.items || []).map((t) => t && t.name) } : null,
      resources: p && p.resources ? { ok: p.resources.ok, names: (p.resources.items || []).map((t) => t && (t.name || t.uri)) } : null,
      prompts: p && p.prompts ? { ok: p.prompts.ok, names: (p.prompts.items || []).map((t) => t && t.name) } : null,
      cost: r.cost ? { toolSchemaChars: r.cost.tools.chars, toolSchemaTokensEstimate: r.cost.tools.tokens, toolsSent: r.cost.tools.sent, toolsLeftOut: r.cost.tools.leftOut, descriptionsCut: r.cost.tools.cut, instructionsChars: r.cost.instructions.chars, instructionsTokensEstimate: r.cost.instructions.tokens, perTool: r.cost.tools.tools.map((t) => ({ name: t.name, chars: t.chars, tokensEstimate: t.tokens })) } : null,
      notes: r.notes,
    };
  };
  const answered = results.filter((r) => r.ok);
  const sum = (f) => answered.reduce((n, r) => n + f(r), 0);
  return {
    project: ctx.project, timeoutMs: timeout.ms, timeoutSource: timeout.source, mcpTimeout: timeout.mcpTimeout,
    servers: results.map(slim),
    totals: { servers: results.length, started: results.filter((r) => r.checked).length, answered: answered.length, failed: results.filter((r) => r.checked && !r.ok).length, skipped: results.filter((r) => !r.checked).length, tools: sum((r) => (r.counts ? r.counts.tools : 0)), toolSchemaChars: sum((r) => (r.cost ? r.cost.tools.chars : 0)), toolSchemaTokensEstimate: sum((r) => (r.cost ? r.cost.tools.tokens : 0)), instructionsChars: sum((r) => (r.cost ? r.cost.instructions.chars : 0)), serversOfferingResources: answered.filter((r) => r.counts && r.counts.resources !== null).length },
    resourceTools: { ...RESOURCE_TOOLS, tokensEstimate: Math.round(RESOURCE_TOOLS.chars / 4) },
    note: "Token figures are characters / 4, an estimate. They are what is sent when the schemas load up front; with tool search (the default on Claude Code's own API host) only the names load until the model asks for a tool.",
  };
}

export function checkText(ctx, results, { timeout }) {
  const out = [];
  out.push(`claude-mcp-check ${VERSION}  check`);
  out.push(`project   ${ctx.project}`);
  out.push(`timeout   ${num(timeout.ms)} ms${timeout.source === "default" ? " (Claude Code's default; MCP_TIMEOUT is not set)" : timeout.source === "MCP_TIMEOUT" ? " (from MCP_TIMEOUT)" : ` (--timeout${timeout.mcpTimeout ? `; MCP_TIMEOUT is ${num(timeout.mcpTimeout)}` : ""})`}`);
  out.push("");
  if (!results.length) out.push("No servers to check.");
  for (const r of results) {
    const p = r.probe;
    const head = `${r.name}  (${r.scope}, ${r.type || "?"})`;
    if (!r.checked) { out.push(head, `    not started: ${r.skipped}`, ""); continue; }
    const what = r.type === "stdio" ? `${r.command.command} ${r.command.args.join(" ")}`.trim() : r.url;
    out.push(head, `    ${what}`);
    if (r.refs.missing.length) out.push(`    ! \${${[...new Set(r.refs.missing.map((m) => m.name))].join("}, ${")}} is set nowhere: the server receives the text unchanged`);
    if (r.ok) {
      const init = p.initialize;
      out.push(`    answered initialize in ${num(init.ms)} ms (MCP ${init.protocolVersion || "?"}${init.serverInfo && init.serverInfo.name ? `, ${init.serverInfo.name} ${init.serverInfo.version}` : ""})`);
      const c = r.counts;
      out.push(`    ${plural(c.tools, "tool")}, ${c.resources === null ? "no resources" : plural(c.resources, "resource")}, ${c.prompts === null ? "no prompts" : plural(c.prompts, "prompt")}${p.tools && !p.tools.ok ? "  ! tools/list failed" : ""}`);
      const t = r.cost.tools;
      out.push(`    tool schemas: ${num(t.chars)} characters, about ${num(t.tokens)} tokens (characters / 4, an estimate)${r.cost.instructions.chars ? `; server instructions ${num(r.cost.instructions.chars)} characters, about ${num(r.cost.instructions.tokens)} tokens` : ""}`);
      if (t.cut) out.push(`    ${plural(t.cut, "description")} cut at 4,096 characters, as Claude Code cuts them`);
      if (t.leftOut.length) out.push(`    ! ${plural(t.leftOut.length, "tool")} left out by Claude Code: the full name is over 128 characters (${t.leftOut.map((x) => x.name).slice(0, 2).join(", ")})`);
      for (const n of r.notes) out.push(`    ! ${n}`);
      if (p.other && p.other.lines) out.push(`    ! stdout held ${plural(p.other.lines, "line")} that ${p.other.lines === 1 ? "is" : "are"} not JSON-RPC`);
    } else if (r.type === "stdio") {
      if (p.spawnError) out.push(`    not started: ${p.spawnError.code === "ENOENT" ? "the command was not found" : p.spawnError.message}`);
      else if (p.exit) out.push(`    exited with ${p.exit.signal ? `signal ${p.exit.signal}` : `code ${p.exit.code}`} after ${num(p.exit.ms)} ms, before answering initialize`);
      else if (p.timedOut) out.push(`    no answer to initialize within ${num(timeout.ms)} ms${p.other.lines ? `; stdout held ${plural(p.other.lines, "line")} that ${p.other.lines === 1 ? "is" : "are"} not JSON-RPC` : ""}`);
      else if (p.initialize && p.initialize.error) out.push(`    initialize failed: ${p.initialize.error.code}: ${p.initialize.error.message}`);
      out.push(`    run: claude-mcp-check why ${r.name}`);
    } else {
      out.push(`    ${p.detail}`);
      if (p.note) out.push(`    ${p.note}`);
      out.push(`    run: claude-mcp-check why ${r.name}`);
    }
    out.push("");
  }
  const answered = results.filter((r) => r.ok);
  if (results.length) {
    const chars = answered.reduce((n, r) => n + r.cost.tools.chars, 0);
    const tools = answered.reduce((n, r) => n + r.counts.tools, 0);
    const started = results.filter((r) => r.checked).length;
    out.push(`${plural(started, "server")} started, ${answered.length} answered, ${results.filter((r) => r.checked && !r.ok).length} failed, ${results.filter((r) => !r.checked).length} not started.`);
    if (answered.length) out.push(`${plural(tools, "tool")} in all; their schemas are ${num(chars)} characters, about ${num(Math.round(chars / 4))} tokens (characters / 4, an estimate).`);
    if (answered.some((r) => r.counts.resources !== null)) out.push(`A server that offers resources also makes Claude Code send ${RESOURCE_TOOLS.names.length} tools of its own (${RESOURCE_TOOLS.names.join(", ")}), once for all servers: ${num(RESOURCE_TOOLS.chars)} characters, about ${num(Math.round(RESOURCE_TOOLS.chars / 4))} tokens, as measured on Claude Code ${RESOURCE_TOOLS.measuredOn}.`);
    out.push("Those schemas load up front unless Claude Code defers them behind tool search (always with ENABLE_TOOL_SEARCH=true; automatically once MCP tool descriptions pass a share of the context window, says Claude Code's changelog): then only the names load until the model asks for a tool.");
  }
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// why
// ---------------------------------------------------------------------------------------------------------------------

export function whyJson(e) {
  return {
    name: e.name, found: e.found, cause: e.cause, ok: e.ok, summary: e.summary, details: e.details.map(redactText), fix: e.fix, warnings: e.warnings.map(redactText),
    state: e.server ? e.server.state : null, scope: e.server ? e.server.def.scopeLabel : null, display: e.server ? e.server.def.display : null,
    command: e.command || null,
    process: e.check && e.check.probe && "pid" in e.check.probe ? { exit: e.check.probe.exit, timedOut: e.check.probe.timedOut, stderr: e.check.probe.stderr, nonJsonLines: e.check.probe.other.lines } : null,
    http: e.check && e.check.probe && "outcome" in e.check.probe ? { status: e.check.probe.status, outcome: e.check.probe.outcome, detail: e.check.probe.detail } : null,
  };
}

export function whyText(e) {
  const out = [];
  out.push(`claude-mcp-check ${VERSION}  why ${e.name}`, "");
  out.push(e.ok ? "result    nothing is wrong" : `cause     ${e.cause}`);
  out.push(`what      ${e.summary}`);
  if (e.server) out.push(`from      ${e.server.def.scopeLabel}: ${where(e.server.def)}`);
  if (e.command) out.push(`command   ${e.command}`);
  if (e.details.length) { out.push(""); for (const d of e.details) out.push(`  ${redactText(d)}`); }
  if (e.warnings.length) { out.push(""); for (const w of e.warnings) out.push(`! ${redactText(w)}`); }
  if (e.fix) out.push("", `fix       ${e.fix}`);
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------------------------------------------------

export function lintJson(ctx, model, findings) {
  return {
    project: ctx.project, configDir: ctx.configDir, claudeJson: ctx.claudeJson.path,
    findings: findings.map((f) => ({ id: f.id, severity: f.severity, effect: f.effect, server: f.server, file: f.file, display: f.display, line: f.line, message: redactText(f.message), does: f.does || null, fix: f.fix || null })),
    counts: countFindings(findings),
    servers: model.servers.length,
  };
}

export function lintText(ctx, model, findings) {
  const out = [];
  out.push(`claude-mcp-check ${VERSION}  lint`);
  out.push(`project   ${ctx.project}`);
  out.push("");
  if (!findings.length) out.push("No findings.");
  const groups = new Map();
  for (const f of findings) { const head = f.display || "(settings)"; if (!groups.has(head)) groups.set(head, []); groups.get(head).push(f); }
  let first = true;
  for (const [head, list] of groups) {
    if (!first) out.push("");
    first = false;
    out.push(head);
    for (const f of list) {
      out.push(`  ${pad(f.severity, 7)} ${pad(f.id, 22)}${f.line ? `line ${f.line}  ` : ""}${f.server ? `[${f.server}]` : ""}`.trimEnd());
      out.push(`      ${redactText(f.message)}`);
      if (f.does) out.push(`      effect: ${f.does}`);
      if (f.fix) out.push(`      fix: ${f.fix}`);
    }
  }
  const c = countFindings(findings);
  out.push("", `${plural(c.error, "error")}, ${plural(c.warning, "warning")}, ${plural(c.note, "note")}; ${plural(model.servers.length, "server")}`);
  return `${out.join("\n")}\n`;
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The short report that the skill hands to Claude: at most `maxFindings` findings, each on a line of at most 300 characters (16 lines in all). */
export function lintMarkdown(ctx, model, findings, { maxFindings = 12 } = {}) {
  const c = countFindings(findings);
  const loading = model.servers.filter((s) => s.loads).length;
  const out = [`## mcp-check lint: ${ctx.project}`, `${plural(model.servers.length, "server")} found, ${loading} active; ${plural(c.error, "error")}, ${plural(c.warning, "warning")}, ${plural(c.note, "note")}.`];
  const shown = findings.filter((f) => f.severity !== "note").slice(0, maxFindings);
  if (!findings.length) out.push("No findings.");
  for (const f of shown) {
    const loc = f.display ? ` ${f.display}${f.line ? `:${f.line}` : ""}` : "";
    out.push(cut(`- ${f.severity.toUpperCase()} \`${f.id}\`${loc}${f.server ? ` [${f.server}]` : ""}: ${redactText(f.message)}${f.does ? ` Effect: ${f.does}.` : ""}${f.fix ? ` Fix: ${f.fix}` : ""}`, 300));
  }
  const more = findings.filter((f) => f.severity !== "note").length - shown.length;
  if (more > 0) out.push(`- ... and ${more} more (run \`claude-mcp-check lint\`)`);
  if (c.note && !shown.length && !more) out.push(`- ${plural(c.note, "note")} not shown (run \`claude-mcp-check lint\`)`);
  return `${out.join("\n")}\n`;
}
