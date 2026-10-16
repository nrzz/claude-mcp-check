// The command line: the options, the help, the exit codes. 0 ok, 1 findings or a refusal, 2 a usage error.
import os from "node:os";
import path from "node:path";
import { VERSION } from "./version.mjs";
import { loadContext } from "./context.mjs";
import { buildModel } from "./state.mjs";
import { checkServers, timeoutFrom } from "./check.mjs";
import { explain } from "./why.mjs";
import { countFindings, lintModel } from "./lint.mjs";
import { applyToggle, planToggle } from "./toggle.mjs";
import { listBackups, restoreBackup } from "./write.mjs";
import { localSettingsPaths, shortPath } from "./paths.mjs";
import { checkJson, checkText, lintJson, lintMarkdown, lintText, showJson, showText, whyJson, whyText } from "./report.mjs";

export const HELP = `Usage: claude-mcp-check <command> [options]

Read (they change nothing):
  show     [--project <dir>] [--mcp-config <file>]...
           every MCP server Claude Code would load for the project: the file and the key each
           definition is in, scope, transport, command or URL, the approval of .mcp.json servers
           (approved, pending, rejected), whether the project switched it off or a policy blocks it,
           and which definition wins when a name is defined twice
  lint     [--project <dir>] [--mcp-config <file>]... [--markdown]
           a name defined in two scopes, a command that is not on the PATH, a \${VAR} that is set
           nowhere, a .mcp.json server nobody approved, a server both enabled and disabled, a list
           key that holds a plain string, a plain-http URL, an invalid entry or file, names that
           share a tool prefix. Exit 1 on an error or a warning. --markdown is the short report the
           /mcp-check:check skill hands to Claude (at most 12 findings, 16 lines); it always exits 0, because
           Claude Code drops a skill whose command fails

Start servers (they run the commands you configured, and connect to the URLs you configured):
  check    [name] [--project <dir>] [--mcp-config <file>]... [--timeout <ms>] [--send-headers]
           [--include-unapproved]
           start each stdio server with the command, arguments, environment and folder Claude Code
           would use, perform the MCP handshake, list its tools, resources and prompts, time the
           answer to initialize and size the tool schemas (characters, and characters / 4 as a token
           estimate); probe an HTTP or SSE URL and say from the status code whether it wants a login.
           A .mcp.json server nobody approved is not started unless --include-unapproved. Every
           child is ended before the command returns. Exit 1 when a server did not answer
  why      <name> [same options as check]
           the cause that a server does not come up: not approved, switched off, blocked by a list,
           an invalid definition, command not found, a \${VAR} set nowhere, non-JSON on stdout, an
           exit before the handshake (with the exit code and the end of stderr), no answer within
           the timeout, needs login. Exit 1 when there is one

Change (they write after a backup next to the file; --dry-run shows the change and writes nothing):
  toggle   <name> --on | --off [--project <dir>] [--dry-run]
           a .mcp.json server: disabledMcpjsonServers or enabledMcpjsonServers in the project's
           .claude/settings.local.json. Any other server: disabledMcpServers of the project in
           ~/.claude.json, the list behind "Disabled for this project" in claude mcp list
  restore  [--project <dir>] [--claude-json] [--list] [--dry-run]
           put the newest backup of .claude/settings.local.json back (of ~/.claude.json with
           --claude-json); --list names the backups. The file it replaces is saved first

Options for every command:
  --project <dir>   the folder Claude Code starts in (default: the folder you are in)
  --mcp-config <f>  also read the servers of this file, as claude --mcp-config does (repeat it for more files)
  --json            one JSON document on stdout
  -h, --help        this text
  -v, --version     the version

Exit codes: 0 ok; 1 findings, a failed server or a refusal; 2 a usage error or an unexpected error.
Environment: CLAUDE_CONFIG_DIR (Claude's config folder), MCP_TIMEOUT (the default of --timeout),
and CLAUDE_MCP_CHECK_MANAGED_DIR (the folder to read managed-mcp.json and managed-settings.json from,
instead of the system folder; the tests use it).
It reads configuration files. Only check and why start programs or open connections, and only the
servers and URLs you configured. It writes only with toggle and restore, and it sends nothing to
Anthropic or anyone else.
`;

const COMMANDS = {
  show: { options: ["project", "mcpConfig", "json"], positional: 0 },
  lint: { options: ["project", "mcpConfig", "json", "markdown"], positional: 0 },
  check: { options: ["project", "mcpConfig", "json", "timeout", "sendHeaders", "includeUnapproved"], positional: 1 },
  why: { options: ["project", "mcpConfig", "json", "timeout", "sendHeaders", "includeUnapproved"], positional: 1, required: true },
  toggle: { options: ["project", "json", "on", "off", "dryRun"], positional: 1, required: true },
  restore: { options: ["project", "json", "claudeJson", "list", "dryRun"], positional: 0 },
};

const FLAGS = {
  "--json": "json", "--markdown": "markdown", "--dry-run": "dryRun", "--on": "on", "--off": "off", "--send-headers": "sendHeaders",
  "--include-unapproved": "includeUnapproved", "--claude-json": "claudeJson", "--list": "list", "-h": "help", "--help": "help", "-v": "version", "--version": "version",
};
const VALUES = { "--project": "project", "--timeout": "timeout", "--mcp-config": "mcpConfig" };

class UsageError extends Error {}

/** Reads the argument list. Returns { command, name, project, mcpConfig, timeout, json, markdown, ... } or throws a UsageError. */
export function parseArgs(argv) {
  const o = { command: null, name: null, project: undefined, mcpConfig: [], timeout: undefined, json: false, markdown: false, dryRun: false, on: false, off: false, sendHeaders: false, includeUnapproved: false, claudeJson: false, list: false, help: false, version: false, given: new Set() };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(a);
    const flag = eq ? eq[1] : a;
    if (Object.prototype.hasOwnProperty.call(VALUES, flag)) {
      const key = VALUES[flag];
      const value = eq ? eq[2] : argv[++i];
      if (value === undefined || (!eq && /^--?[A-Za-z]/.test(value) && key !== "project")) throw new UsageError(`${flag} needs a value`);
      o.given.add(key);
      if (key === "mcpConfig") o.mcpConfig.push(value);
      else if (key === "timeout") {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 3600000) throw new UsageError("--timeout takes a number of milliseconds between 1 and 3600000");
        o.timeout = Number(value);
      } else o[key] = value;
    } else if (Object.prototype.hasOwnProperty.call(FLAGS, flag) && !eq) {
      o[FLAGS[flag]] = true;
      o.given.add(FLAGS[flag]);
    } else if (a.startsWith("-") && a !== "-") {
      throw new UsageError(`unknown option ${a}`);
    } else positional.push(a);
  }
  if (o.help || o.version) return o;
  if (!positional.length) throw new UsageError("no command given");
  o.command = positional[0];
  const spec = COMMANDS[o.command];
  if (!spec) throw new UsageError(`unknown command "${o.command}"`);
  for (const key of o.given) if (key !== "help" && key !== "version" && !spec.options.includes(key)) throw new UsageError(`${o.command} does not take --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  const rest = positional.slice(1);
  if (rest.length > spec.positional) throw new UsageError(`${o.command} takes ${spec.positional === 0 ? "no name" : "one name"}, not "${rest.join(" ")}"`);
  if (spec.required && rest.length === 0) throw new UsageError(`${o.command} needs the name of a server`);
  o.name = rest[0] || null;
  if (o.command === "toggle" && o.on === o.off) throw new UsageError("toggle needs --on or --off, and not both");
  return o;
}

const errorDoc = (message) => ({ ok: false, error: message });

/**
 * Runs the command line. `io` replaces the real process for tests:
 *   { cwd, env, home, platform, now, stdout: { write }, stderr: { write }, managed }
 * Returns the exit code.
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const cwd = io.cwd || process.cwd();
  const home = io.home || os.homedir();
  const platform = io.platform || process.platform;
  const now = io.now ? new Date(io.now) : new Date();
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    if (argv.includes("--json")) stdout.write(`${JSON.stringify(errorDoc(e.message))}\n`);
    else stderr.write(`claude-mcp-check: ${e.message}\nRun claude-mcp-check --help for the commands.\n`);
    return 2;
  }
  if (o.help) { stdout.write(HELP); return 0; }
  if (o.version) { stdout.write(`claude-mcp-check ${VERSION}\n`); return 0; }
  const emit = (doc, text) => stdout.write(o.json ? `${JSON.stringify(doc, null, 2)}\n` : text);

  try {
    const ctx = loadContext({ project: o.project, mcpConfig: o.mcpConfig, env, home, platform, managed: io.managed, cwd, mcpJsonRoot: io.mcpJsonRoot });
    if (o.command === "restore") return restoreCommand(ctx, o, { stdout, now });
    const model = buildModel(ctx);

    if (o.command === "show") { emit(showJson(ctx, model), showText(ctx, model)); return 0; }

    if (o.command === "lint") {
      const findings = lintModel(ctx, model);
      if (o.markdown) { stdout.write(o.json ? `${JSON.stringify(lintJson(ctx, model, findings), null, 2)}\n` : lintMarkdown(ctx, model, findings)); return 0; }
      emit(lintJson(ctx, model, findings), lintText(ctx, model, findings));
      const c = countFindings(findings);
      return c.error + c.warning > 0 ? 1 : 0;
    }

    if (o.command === "check") {
      if (o.name && !model.servers.some((s) => s.name === o.name)) {
        const msg = `no server called "${o.name}"; run claude-mcp-check show to see them`;
        if (o.json) stdout.write(`${JSON.stringify({ ok: false, refused: true, error: msg }, null, 2)}\n`); else stderr.write(`${msg}\n`);
        return 1;
      }
      const timeout = timeoutFrom({ timeout: o.timeout, env });
      const results = await checkServers(ctx, model, { name: o.name, timeoutMs: timeout.ms, sendHeaders: o.sendHeaders, includeUnapproved: o.includeUnapproved });
      emit(checkJson(ctx, results, { timeout }), checkText(ctx, results, { timeout }));
      return results.some((r) => r.checked && !r.ok) ? 1 : 0;
    }

    if (o.command === "why") {
      const timeout = timeoutFrom({ timeout: o.timeout, env });
      const e = await explain(ctx, model, o.name, { timeoutMs: timeout.ms, mcpTimeout: timeout.mcpTimeout, sendHeaders: o.sendHeaders, includeUnapproved: o.includeUnapproved });
      emit(whyJson(e), whyText(e));
      return e.ok ? 0 : 1;
    }

    if (o.command === "toggle") {
      const plan = planToggle(ctx, model, o.name, o.on);
      const result = applyToggle(ctx, plan, { dryRun: o.dryRun, now });
      return toggleOutput(ctx, o, result, { stdout, stderr });
    }
  } catch (e) {
    if (o.json) stdout.write(`${JSON.stringify(errorDoc(String(e && e.message ? e.message : e)))}\n`);
    else stderr.write(`claude-mcp-check: ${e && e.message ? e.message : e}\n`);
    return 2;
  }
  return 2;
}

function toggleOutput(ctx, o, r, { stdout }) {
  const doc = { ok: r.ok, refused: r.ok ? null : r.refused, dryRun: r.dryRun, name: r.name, on: r.on, kind: r.kind, mechanism: r.mechanism, stateBefore: r.before, changes: r.changes.map((c) => ({ file: c.file, display: c.display, key: c.key, op: c.op, item: c.item, changed: c.changed, created: Boolean(c.created), backup: c.backup || null })), notes: r.notes };
  if (o.json) { stdout.write(`${JSON.stringify(doc, null, 2)}\n`); return r.ok ? 0 : 1; }
  const lines = [];
  if (!r.ok) lines.push(`refused: ${r.refused}`);
  else {
    const verb = r.on ? "on" : "off";
    if (!r.changes.length) lines.push(`${r.name}: nothing to change (already ${verb}).`);
    for (const c of r.changes) {
      const where = `${c.display} ${c.target === "claude-json" ? `(projects["${ctx.projectKey}"])` : ""}`.trim();
      if (!c.changed) lines.push(`${r.dryRun ? "would leave" : "left"} ${c.key} in ${where} as it is (${c.op === "add" ? "already lists" : "does not list"} ${c.item})`);
      else lines.push(`${r.dryRun ? "would " : ""}${c.op === "add" ? "add" : "remove"} ${c.item} ${c.op === "add" ? "to" : "from"} ${c.key} in ${where}${c.created ? " (a new file)" : ""}${c.backup ? `; the old file is saved as ${c.backup}` : ""}`);
    }
    if (r.changes.some((c) => c.changed) && !r.dryRun) lines.push("Restart Claude Code for a running session to pick it up. claude-mcp-check restore puts the old file back.");
  }
  for (const n of r.notes) lines.push(`note: ${n}`);
  stdout.write(`${lines.join("\n")}\n`);
  return r.ok ? 0 : 1;
}

function restoreCommand(ctx, o, { stdout, now }) {
  const file = o.claudeJson ? ctx.claudeJson.path : localSettingsPaths(ctx.project, { home: ctx.home, platform: ctx.platform })[0];
  const display = shortPath(file, { home: ctx.home, project: ctx.project });
  if (o.list) {
    const names = listBackups(file);
    if (o.json) stdout.write(`${JSON.stringify({ ok: true, file, backups: names.map((n) => path.join(path.dirname(file), n)) }, null, 2)}\n`);
    else stdout.write(names.length ? `${names.map((n) => path.join(path.dirname(file), n)).join("\n")}\n` : `no backup of ${display}\n`);
    return 0;
  }
  const r = restoreBackup(file, { now, dryRun: o.dryRun });
  if (o.json) { stdout.write(`${JSON.stringify({ ok: r.restored || (o.dryRun && !r.reason), refused: r.reason || null, dryRun: Boolean(o.dryRun), file, from: r.from || null, savedCurrent: r.savedCurrent || null }, null, 2)}\n`); return r.reason ? 1 : 0; }
  if (r.reason) { stdout.write(`refused: ${display}: ${r.reason}\n`); return 1; }
  stdout.write(`${o.dryRun ? "would put" : "put"} ${r.from} back as ${display}${r.savedCurrent ? `; the file as it was is saved as ${r.savedCurrent}` : ""}\n`);
  return 0;
}
