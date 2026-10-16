// The command line: the options, the help, the exit codes, the JSON documents, and the reports of show.
import { CLI, ROOT, fake, run, runCli, world } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { HELP, parseArgs } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";

const bad = (args) => { try { parseArgs(args); } catch (e) { return e.message; } return null; };

test("the options of each command, with their defaults", () => {
  const o = parseArgs(["check", "github", "--project", "/p", "--timeout", "500", "--json", "--send-headers", "--include-unapproved", "--mcp-config", "a.json", "--mcp-config", "b.json"]);
  assert.equal(o.command, "check");
  assert.equal(o.name, "github");
  assert.equal(o.project, "/p");
  assert.equal(o.timeout, 500);
  assert.deepEqual(o.mcpConfig, ["a.json", "b.json"]);
  assert.ok(o.json && o.sendHeaders && o.includeUnapproved);
  const t = parseArgs(["toggle", "x", "--off", "--dry-run"]);
  assert.ok(t.off && !t.on && t.dryRun && t.name === "x");
  assert.equal(parseArgs(["show"]).name, null);
  assert.equal(parseArgs(["show", "--project=/q"]).project, "/q");
  assert.ok(parseArgs(["lint", "--markdown"]).markdown);
  assert.ok(parseArgs(["restore", "--claude-json", "--list"]).claudeJson);
  assert.ok(parseArgs(["--help"]).help && parseArgs(["-v"]).version);
});

test("usage errors are named, and a command refuses the options it does not take", () => {
  assert.match(bad([]), /no command/);
  assert.match(bad(["bogus"]), /unknown command "bogus"/);
  assert.match(bad(["show", "--frobnicate"]), /unknown option --frobnicate/);
  assert.match(bad(["show", "--timeout", "5"]), /show does not take --timeout/);
  assert.match(bad(["lint", "--send-headers"]), /lint does not take --send-headers/);
  assert.match(bad(["toggle", "x", "--on", "--mcp-config", "f"]), /toggle does not take --mcp-config/);
  assert.match(bad(["show", "extra"]), /takes no name/);
  assert.match(bad(["check", "a", "b"]), /one name/);
  assert.match(bad(["why"]), /needs the name of a server/);
  assert.match(bad(["toggle", "x"]), /--on or --off/);
  assert.match(bad(["toggle", "x", "--on", "--off"]), /--on or --off/);
  assert.match(bad(["check", "--timeout"]), /needs a value/);
  assert.match(bad(["check", "--timeout", "soon"]), /milliseconds/);
  assert.match(bad(["check", "--timeout", "0"]), /milliseconds/);
  assert.match(bad(["check", "--mcp-config"]), /needs a value/);
  assert.match(bad(["check", "--json=1"]), /unknown option/);
});

test("--help and --version print and exit 0; a usage error exits 2, as JSON with --json", async () => {
  const w = world("cli1");
  const h = await run(["--help"], w);
  assert.equal(h.code, 0);
  assert.equal(h.out, HELP);
  assert.match((await run(["-v"], w)).out, new RegExp(`^claude-mcp-check ${VERSION.replace(/\./g, "\\.")}\n$`));
  const e = await run(["nope"], w);
  assert.equal(e.code, 2);
  assert.match(e.err, /unknown command "nope"/);
  const j = await run(["nope", "--json"], w);
  assert.equal(j.code, 2);
  assert.deepEqual(j.json(), { ok: false, error: 'unknown command "nope"' });
});

test("the help names every command and every option, and the exit codes", () => {
  for (const cmd of ["show", "lint", "check", "why", "toggle", "restore"]) assert.match(HELP, new RegExp(`^  ${cmd} `, "m"), cmd);
  for (const opt of ["--project", "--mcp-config", "--json", "--markdown", "--timeout", "--send-headers", "--include-unapproved", "--on", "--off", "--dry-run", "--claude-json", "--list", "--help", "--version"]) assert.ok(HELP.includes(opt), opt);
  assert.match(HELP, /Exit codes: 0 ok; 1 findings, a failed server or a refusal; 2 a usage error/);
  assert.ok(!/\p{Extended_Pictographic}/u.test(HELP));
});

test("the real entry point runs in a child process, in a throwaway world, and exits with the code", () => {
  const w = world("cli2");
  w.claudeJson({ mcpServers: { a: fake("ok") } });
  const show = runCli(["show", "--json", "--project", w.work], { cwd: w.work, env: w.env });
  assert.equal(show.code, 0, show.err);
  assert.deepEqual(JSON.parse(show.out).servers.map((s) => s.name), ["a"]);
  w.claudeJson({ mcpServers: { a: fake("ok"), gone: { command: "definitely-not-a-command-xyz" } } });
  const lint = runCli(["lint", "--project", w.work], { cwd: w.work, env: w.env });
  assert.equal(lint.code, 1);
  assert.match(lint.out, /command-not-found/);
  assert.equal(runCli(["bogus"], { cwd: w.work, env: w.env }).code, 2);
  assert.throws(() => runCli(["show"], { cwd: w.work, env: { ...w.env, CLAUDE_CONFIG_DIR: ROOT } }), /must be temporary/, "the helper refuses a config folder outside the temp folder");
  assert.ok(CLI.endsWith("claude-mcp-check.mjs"));
});

test("show --json: the servers, where each came from, and the sources", async () => {
  const w = world("cli3");
  w.claudeJson({ mcpServers: { u: fake("ok"), web: { type: "http", url: "https://example.invalid/mcp?api_key=SECRETVALUE", headers: { Authorization: "Bearer SECRETHEADER" } } } }, { mcpServers: { l: fake("ok", { env: { API_TOKEN: "SECRETENV" } }) } });
  w.mcpJson({ mcpServers: { p: fake("ok") } });
  const doc = (await run(["show", "--json"], w)).json();
  assert.deepEqual(doc.servers.map((s) => [s.name, s.state, s.scope]), [["l", "active", "local"], ["p", "pending", "project"], ["u", "active", "user"], ["web", "active", "user"]]);
  assert.deepEqual(doc.sources.map((s) => s.kind), ["local", "project", "user"]);
  assert.equal(doc.projectKey, w.key);
  assert.equal(doc.trusted, true);
  const l = doc.servers[0];
  assert.deepEqual(l.envNames, ["API_TOKEN"]);
  assert.equal(l.keyPath, `projects["${w.key}"].mcpServers.l`);
  assert.deepEqual(doc.servers[3].headerNames, ["Authorization"]);
  const text = JSON.stringify(doc) + (await run(["show"], w)).out;
  for (const secret of ["SECRETVALUE", "SECRETHEADER", "SECRETENV"]) assert.ok(!text.includes(secret), `${secret} is nowhere in the output`);
});

test("show: the text lists the places, then each server with its state and where it comes from", async () => {
  const w = world("cli4");
  w.claudeJson({ mcpServers: { u: fake("ok") } });
  w.mcpJson({ mcpServers: { p: fake("ok"), u: fake("ok", { args: ["project"] }) } });
  const out = (await run(["show"], w)).out;
  assert.match(out, /^claude-mcp-check [\d.]+ {2}the MCP servers Claude Code would load$/m);
  assert.match(out, /Where servers come from, highest precedence first/);
  assert.match(out, /Servers \(2; 1 active\)/);
  assert.match(out, /^ {2}p\s+project\s+stdio\s+pending approval\s/m);
  assert.match(out, /not approved: a session asks first; claude -p loads it without asking/);
  assert.match(out, /also defined in project \(\.mcp\.json:\d+\): not approved, so a session uses user; claude -p loads that one instead/);
  assert.match(out, /Claude\.ai connectors are fetched by Claude Code at start and are not listed here\./);
});

test("show with nothing configured says so", async () => {
  const w = world("cli5");
  const out = (await run(["show"], w)).out;
  assert.match(out, /Servers \(0; 0 active\)/);
  assert.match(out, /none: Claude Code has no MCP server to start for this project/);
});

test("--project names the folder, and a relative one is taken from the folder you are in", async () => {
  const w = world("cli6");
  w.mcpJson({ mcpServers: { p: fake("ok") } });
  const path = await import("node:path");
  const here = (await run(["show", "--json"], w)).json();
  const there = (await run(["show", "--json", "--project", path.basename(w.work)], w, { cwd: path.dirname(w.work) })).json();
  assert.deepEqual(there.servers.map((s) => s.name), here.servers.map((s) => s.name));
  assert.equal(there.project, w.work);
});

test("a .claude.json that is not valid JSON is a problem in show and lint, and not a crash", async () => {
  const w = world("cli7");
  w.write(w.claudeJsonFile, "{ not json");
  const doc = (await run(["show", "--json"], w)).json();
  assert.equal(doc.claudeJson.error.length > 0, true);
  assert.ok(doc.problems.some((p) => p.id === "invalid-json"));
  const lint = (await run(["lint", "--json"], w)).json();
  assert.ok(lint.findings.some((f) => f.id === "invalid-json"));
});
