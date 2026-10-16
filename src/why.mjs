// `why <name>`: the reason a server does not come up, in one of a fixed set of causes. The static ones (not approved,
// switched off, blocked by a list, an invalid definition, a command that is not on the PATH, a ${VAR} that is set nowhere)
// need no process; the others come from starting the server and asking it, as `check` does.
//
// causes   not-found invalid-config blocked-by-policy disabled not-approved duplicate command-not-found command-not-executable
//          variable-unset variable-empty non-json-stdout early-exit timeout handshake-error tools-list-failed
//          needs-login endpoint-not-found wrong-transport server-error unreachable tls-error redirect not-mcp not-probed ok
import { checkServer } from "./check.mjs";

const lastLines = (text, n = 6) => String(text || "").split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
const list = (items) => items.map((x) => `\${${x.name}}`).join(", ");

function unsetDetail(refs) {
  const where = refs.missing.map((m) => `\${${m.name}} in ${m.field}`).join("; ");
  return `${where} ${refs.missing.length === 1 ? "is" : "are"} set nowhere that Claude Code looks, so it passes the text unchanged to the server. It looks in the environment of the shell that starts Claude Code and in the env of your user settings.json. The env of a project or local settings file does reach the server's own environment, but is not used to fill in \${VAR}.`;
}
const unsetFix = (refs) => `Set ${refs.missing.map((m) => m.name).filter((n, i, a) => a.indexOf(n) === i).join(", ")} before you start Claude Code, or put it in "env" in your user settings.json, or write a default: \${${refs.missing[0].name}:-value}.`;

/** The cause, from what check found. Returns { cause, ok, summary, details, fix, warnings }. */
export function classify(ctx, server, r, { timeoutMs, mcpTimeout } = {}) {
  const out = { cause: "ok", ok: false, summary: "", details: [], fix: null, warnings: [] };
  const name = server.name;
  const def = server.winner || server.headlessWinner || server.def;

  if (!r.checked) {
    switch (server.state) {
      case "pending": {
        out.cause = "not-approved";
        out.summary = "a .mcp.json server that nobody approved";
        out.details.push("A session of Claude Code asks before it starts a server from a .mcp.json file and does nothing until you say yes. `claude -p`, the Agent SDK and cloud sessions load it without asking.");
        const inactive = server.approval && server.approval.inactive;
        if (inactive && inactive.length) out.details.push(`An approval is written in ${inactive.map((i) => i.file).join(", ")}, but this folder is not trusted yet (projects[...].hasTrustDialogAccepted), and the project's own settings files approve nothing until it is.`);
        out.fix = `claude-mcp-check toggle ${name} --on   (writes enabledMcpjsonServers in .claude/settings.local.json), or approve it when claude asks.`;
        return out;
      }
      case "rejected":
        out.cause = "disabled";
        out.summary = "rejected by disabledMcpjsonServers";
        out.details.push(`The name is in disabledMcpjsonServers in ${(server.approval ? server.approval.by : []).map((b) => b.file).join(", ") || "a settings file"}. A rejection wins over an approval and over enableAllProjectMcpServers (\`claude -p\` loaded no rejected server in any permission mode tried).`);
        out.fix = `claude-mcp-check toggle ${name} --on`;
        return out;
      case "disabled":
        out.cause = "disabled";
        out.summary = "switched off for this project";
        out.details.push(`The name is in disabledMcpServers of this project in ${ctx.claudeJson.display} (\`claude mcp list\` says "Disabled for this project").`);
        out.fix = `claude-mcp-check toggle ${name} --on`;
        return out;
      case "blocked": {
        out.cause = "blocked-by-policy";
        const by = server.policy.by || {};
        out.summary = "kept out by a policy list";
        out.details.push(`${by.list}${by.entry ? ` (${JSON.stringify(by.entry)})` : ""}${by.file ? ` in ${by.file}` : ""} keeps it out. A blocked server is not listed anywhere and Claude Code starts no process for it.`);
        out.fix = "Change the list in that file; this tool does not write policy lists.";
        return out;
      }
      case "duplicate":
        out.cause = "duplicate";
        out.summary = "a plugin server with the endpoint of another server";
        out.details.push(`Claude Code connects "${server.duplicateOf}", which has the same command or URL, and leaves this one out.`);
        return out;
      default:
        out.cause = "invalid-config";
        out.summary = "Claude Code skips the definition";
        out.details.push(...server.defs.filter((d) => !d.validation.ok).map((d) => `${d.display}${d.line ? `:${d.line}` : ""}: ${d.validation.message}`));
        out.fix = "Fix the entry; the message above is what `claude mcp list` prints for it.";
        return out;
    }
  }

  const p = r.probe;
  const refs = r.refs;
  const mcpNote = mcpTimeout ? ` MCP_TIMEOUT is set to ${mcpTimeout} ms.` : " MCP_TIMEOUT is not set (Claude Code waits 30 seconds).";

  if (def.type === "stdio") {
    if (p.spawnError) {
      const code = p.spawnError.code;
      if (code === "EACCES") {
        out.cause = "command-not-executable";
        out.summary = `the file ${r.command.resolved || r.command.command} is not executable`;
        out.fix = "Make it executable (chmod +x) or point `command` at the interpreter that runs it.";
      } else if (code === "ENOENT") {
        out.cause = "command-not-found";
        out.summary = `the command "${r.command.command}" was not found`;
        out.details.push(`It was looked up in the PATH of the server's environment${r.command.searched.length ? ` (${r.command.searched.length} folders, the first: ${r.command.searched.slice(0, 3).join(", ")})` : ""} and, for a relative name, in the project folder. Claude Code reports this as "CONNECTION_CLOSED: Connection closed", which does not say so.`);
        out.fix = "Install it, or write the full path in `command`. The PATH in the server's `env` counts, and so does the PATH of the shell that starts Claude Code.";
      } else {
        out.cause = "spawn-failed";
        out.summary = `the process could not be started (${code}: ${p.spawnError.message})`;
      }
      if (refs.missing.some((m) => m.field === "command")) {
        // the command is a ${VAR} that is set nowhere: that is the cause, and the text "${VAR}" is what was looked for
        out.details.unshift(unsetDetail(refs), `What happened: ${out.summary}.`);
        out.cause = "variable-unset";
        out.summary = `${list(refs.missing)} ${refs.missing.length === 1 ? "is" : "are"} not set`;
        out.fix = unsetFix(refs);
      } else if (refs.missing.length) out.warnings.push(unsetDetail(refs));
      return out;
    }
    if (p.initialize && p.initialize.ok) {
      out.ok = true;
      out.summary = `it starts and answers initialize in ${p.initialize.ms} ms`;
      if (p.tools && !p.tools.ok) { out.cause = "tools-list-failed"; out.ok = false; out.summary = `it answers initialize, but tools/list fails (${p.tools.timeout ? "no answer" : p.tools.error ? `${p.tools.error.code}: ${p.tools.error.message}` : "closed"})`; }
    } else if (p.initialize && p.initialize.error) {
      out.cause = "handshake-error";
      out.summary = `it answers initialize with an error (${p.initialize.error.code}: ${p.initialize.error.message})`;
      out.details.push("Claude Code reports this as the same code and message under \"Failed to connect\".");
    } else if (p.exit) {
      out.cause = "early-exit";
      out.summary = `it exited with ${p.exit.signal ? `signal ${p.exit.signal}` : `code ${p.exit.code}`} after ${p.exit.ms} ms, before it answered initialize`;
      const tail = lastLines(p.stderr);
      if (tail.length) out.details.push(`stderr (last ${tail.length} lines):`, ...tail.map((l) => `  ${l}`));
      else out.details.push("It wrote nothing to stderr.");
      if (p.other.lines) out.details.push(`stdout held ${p.other.lines} line(s) that are not JSON-RPC, the first: ${p.other.samples[0]}`);
      out.details.push("Claude Code reports this as \"CONNECTION_CLOSED: Connection closed\".");
      out.fix = "Run the command in a terminal with the same environment and read what it prints.";
    } else if (p.timedOut) {
      if (p.other.lines) {
        out.cause = "non-json-stdout";
        out.summary = `it wrote ${p.other.lines} line(s) to stdout that are not JSON-RPC and never answered initialize within ${timeoutMs} ms`;
        out.details.push(`The first: ${p.other.samples[0]}`, "stdout carries the protocol; a banner, a log line or an HTML page there means the program is not an MCP server over stdio, or it writes its logs to the wrong stream. Claude Code reports this as \"connection timed out\".");
        out.fix = "Write logs to stderr. Check that the command starts the MCP server and not a web server or a CLI.";
      } else {
        out.cause = "timeout";
        out.summary = `no answer to initialize within ${timeoutMs} ms`;
        out.details.push(`The process started and stayed alive without a single line of JSON-RPC.${mcpNote}`);
        const tail = lastLines(p.stderr, 4);
        if (tail.length) out.details.push("stderr:", ...tail.map((l) => `  ${l}`));
        out.fix = "A first start can be slow (npx downloads the package). Run it once in a terminal, then try again; raise MCP_TIMEOUT if it needs longer. Claude Code reports this as \"connection timed out\".";
      }
    } else {
      out.cause = "early-exit";
      out.summary = "the process ended without answering";
    }
    if (p.other.lines && out.ok) out.warnings.push(`stdout held ${p.other.lines} line(s) that are not JSON-RPC (the first: ${p.other.samples[0]}); Claude Code 2.1.295 and 2.1.299 ignored such a line before the handshake, a stricter client may not`);
  } else if (def.type === "ws") {
    out.cause = "not-probed";
    out.summary = "WebSocket servers are not probed";
    return out;
  } else {
    const why = {
      ok: null,
      "needs-login": { cause: "needs-login", fix: `Log in: \`claude mcp login ${name}\`. This tool sends no credentials and reads none${p.headerNames.length ? `; the configuration sets ${p.headerNames.join(", ")}, which was ${p.sentHeaders ? "sent" : "not sent (--send-headers sends it)"}` : ""}.` },
      "not-found": { cause: "endpoint-not-found", fix: "Check the path of the URL." },
      "wrong-transport": { cause: "wrong-transport", fix: "Check the type: a server that streams over SSE needs \"type\": \"sse\", one that takes POST needs \"type\": \"http\"." },
      "server-error": { cause: "server-error", fix: "The server is failing; try again later or ask its operator." },
      unreachable: { cause: "unreachable", fix: "Check the host name, the port and your network, and any proxy: this tool does not use one." },
      tls: { cause: "tls-error", fix: "The certificate is not trusted here. Check the URL; a corporate proxy that re-signs traffic is a common reason." },
      redirect: { cause: "redirect", fix: "Use the URL that the server redirects to." },
      timeout: { cause: "timeout", fix: "The server did not answer in time." },
      "not-mcp": { cause: "not-mcp", fix: "The URL answers, but not as an MCP server." },
      "handshake-error": { cause: "handshake-error", fix: null },
      "invalid-url": { cause: "variable-unset", fix: null },
      "empty-url": { cause: "invalid-config", fix: "Set the url." },
    }[p.outcome];
    if (p.outcome === "ok") {
      out.ok = true;
      out.summary = p.initialize ? `it answers initialize in ${p.initialize.ms} ms (${p.detail})` : p.detail;
      if (p.tools && !p.tools.ok) { out.cause = "tools-list-failed"; out.ok = false; out.summary = `it answers initialize, but tools/list fails (${p.tools.error ? p.tools.error.message : "no answer"})`; }
    } else if (why) {
      out.cause = why.cause;
      out.summary = p.detail;
      out.fix = why.fix;
      if (p.outcome === "needs-login") out.details.push("Claude Code treats the same answer as a login to start; it reports 401 and 403 as \"Needs authentication\" or fails during OAuth discovery.");
    } else { out.cause = "unreachable"; out.summary = p.detail; }
    if (p.note && !out.ok) out.details.push(p.note);
  }

  // an unset variable explains most failures of a server that needs a key
  if (refs.missing.length) {
    if (!out.ok && out.cause !== "ok") {
      const seen = out.summary;
      out.details.unshift(unsetDetail(refs), `What the server did: ${seen}.`);
      out.cause = "variable-unset";
      out.summary = `${list(refs.missing)} ${refs.missing.length === 1 ? "is" : "are"} not set`;
      out.fix = unsetFix(refs);
    } else out.warnings.push(`${unsetDetail(refs)} The server answered anyway.`);
  }
  if (refs.empty.length) {
    if (!out.ok) {
      if (out.cause !== "variable-unset") { out.details.push(`${list(refs.empty)} ${refs.empty.length === 1 ? "is" : "are"} set to an empty string, which is what the server receives.`); if (out.cause === "early-exit" || out.cause === "timeout" || out.cause === "handshake-error") { out.cause = "variable-empty"; out.summary = `${list(refs.empty)} ${refs.empty.length === 1 ? "is" : "are"} set but empty`; out.fix = `Give ${refs.empty.map((m) => m.name).join(", ")} a value.`; } }
    } else out.warnings.push(`${list(refs.empty)} ${refs.empty.length === 1 ? "is" : "are"} set to an empty string.`);
  }
  if (out.ok && r.cost) {
    if (r.cost.tools.leftOut.length) out.warnings.push(`${r.cost.tools.leftOut.length} tool(s) have a full name over 128 characters and Claude Code leaves them out: ${r.cost.tools.leftOut.map((t) => t.name).slice(0, 3).join(", ")}`);
    if (server.sharesPrefixWith.length) out.warnings.push(`its tool prefix ${server.toolPrefix} is shared with ${server.sharesPrefixWith.map((n) => `"${n}"`).join(", ")}: only the tools of the server that connects first reach the model, and the others are dropped without a word`);
  }
  return out;
}

/** Looks the server up and says why it does not come up (or that it does). Returns { found, name, server, check, ...classification }. */
export async function explain(ctx, model, name, opts = {}) {
  const server = model.servers.find((s) => s.name === name);
  if (!server) {
    const near = model.servers.map((s) => s.name).filter((n) => n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(n.toLowerCase())).slice(0, 5);
    return { found: false, name, cause: "not-found", ok: false, summary: `no server called "${name}" in any place Claude Code reads`, details: [near.length ? `Similar names: ${near.join(", ")}` : `Servers: ${model.servers.map((s) => s.name).slice(0, 12).join(", ") || "(none)"}`], fix: "Run `claude-mcp-check show` to see every server and where it comes from.", warnings: [] };
  }
  const r = await checkServer(ctx, server, opts);
  const c = classify(ctx, server, r, opts);
  // the definition that is used may not be the one in the file the user looks at
  const used = server.winner || server.headlessWinner;
  if (used && c.cause !== "invalid-config") {
    const others = server.defs.filter((d) => d !== used && d.validation.ok);
    if (others.length) c.warnings.push(`"${name}" is also defined in ${others.map((d) => `${d.scopeLabel} (${d.display})`).join(", ")}; the ${used.scopeLabel} definition is the one used`);
  }
  return { found: true, name, server, check: r, ...c, command: r.command ? `${r.command.command} ${r.command.args.join(" ")}`.trim() : null };
}
