// lint: the table of configurations (test/lint-table.mjs) and the shape of a finding. The table is also put to the real binary
// in test/e2e-claude.test.mjs.
import { fake, run, world } from "./helpers.mjs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ROWS } from "./lint-table.mjs";
import { countFindings } from "../src/lint.mjs";

const adapt = (w) => ({
  claudeJson: w.claudeJson, mcpJson: w.mcpJson, user: w.user, project: w.project, local: w.local, managedSettings: w.managedSettings, write: w.write,
  mcpJsonFile: w.mcpJsonFile, localFile: w.localFile, base: w.base, work: w.work, mcpJsonAbove: (v) => w.write(path.join(path.dirname(w.work), ".mcp.json"), v),
});
const lint = async (w, extra = []) => (await run(["lint", "--json", ...extra], w, { env: { LINT_ROW_BIN_UNSET: undefined } })).json();

test("every row of the table: the findings that lint reports, with their severities and words", async () => {
  for (const row of ROWS) {
    const w = world("lint");
    row.setup(adapt(w));
    const doc = await lint(w);
    const ids = doc.findings.map((f) => f.id).sort();
    assert.deepEqual(ids, [...row.expect].sort(), `${row.name}: ${JSON.stringify(doc.findings.map((f) => `${f.id}: ${f.message}`))}`);
    for (const [id, severity] of Object.entries(row.severity || {})) assert.equal(doc.findings.find((f) => f.id === id).severity, severity, `${row.name}: ${id}`);
    for (const [id, re] of Object.entries(row.message || {})) assert.match(doc.findings.find((f) => f.id === id).message, re, `${row.name}: ${id}`);
  }
  assert.ok(ROWS.length >= 30);
});

test("a finding has an id, a severity, the file, the line where there is one, what Claude Code does and a fix", async () => {
  const w = world("lint2");
  w.mcpJson('{\n  "mcpServers": {\n    "p": { "command": "definitely-not-a-command-xyz" }\n  }\n}\n');
  const doc = await lint(w);
  const f = doc.findings.find((x) => x.id === "command-not-found");
  assert.equal(f.severity, "warning");
  assert.equal(f.server, "p");
  assert.equal(f.display, ".mcp.json");
  assert.equal(f.line, 3);
  assert.ok(f.does && f.fix && f.message);
  assert.deepEqual(doc.counts, { error: 0, warning: 2, note: 0 });
});

test("the exit code: 1 for an error or a warning, 0 for notes alone, and 0 for --markdown whatever it finds", async () => {
  const w = world("lint3");
  w.claudeJson({ mcpServers: { a: fake("ok") } }, { disabledMcpServers: ["a"] });
  const notes = await run(["lint"], w);
  assert.equal(notes.code, 0, "a note alone is not a problem");
  assert.match(notes.out, /1 note/);
  w.mcpJson({ mcpServers: { p: fake("ok") } });
  const warn = await run(["lint"], w);
  assert.equal(warn.code, 1);
  const md = await run(["lint", "--markdown"], w);
  assert.equal(md.code, 0, "Claude Code drops a skill whose command fails");
});

test("the markdown report is short: at most 12 findings, 300 characters each, and a line that says how many more", async () => {
  const w = world("lint4");
  const servers = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`server${i}`, { command: `no-such-command-with-a-long-name-${"x".repeat(200)}-${i}` }]));
  w.claudeJson({ mcpServers: servers });
  const md = (await run(["lint", "--markdown"], w)).out;
  const lines = md.trimEnd().split("\n");
  assert.match(lines[0], /^## mcp-check lint: /);
  assert.match(lines[1], /30 servers found, 30 active; 0 errors, 30 warnings, 0 notes\./);
  assert.equal(lines.filter((l) => l.startsWith("- WARNING")).length, 12);
  assert.ok(lines.every((l) => l.length <= 300), `the longest line is ${Math.max(...lines.map((l) => l.length))}`);
  assert.match(lines.at(-1), /^- \.\.\. and 18 more \(run `claude-mcp-check lint`\)$/);
  assert.ok(lines.length <= 16);
});

test("the markdown report of a clean project says so", async () => {
  const w = world("lint5");
  w.claudeJson({ mcpServers: { a: fake("ok") } });
  const md = (await run(["lint", "--markdown"], w)).out;
  assert.match(md, /No findings\./);
  assert.equal(md.trimEnd().split("\n").length, 3);
});

test("notes are counted but not listed in the markdown report", async () => {
  const w = world("lint6");
  w.claudeJson({ mcpServers: { a: fake("ok") } }, { disabledMcpServers: ["a"] });
  const md = (await run(["lint", "--markdown"], w)).out;
  assert.match(md, /1 note\./);
  assert.match(md, /1 note not shown/);
});

test("the text report groups findings by file", async () => {
  const w = world("lint7");
  w.claudeJson({ mcpServers: { missing: { command: "definitely-not-a-command-xyz" } } });
  w.mcpJson({ mcpServers: { p: fake("ok") } });
  const out = (await run(["lint"], w)).out;
  assert.match(out, /^~\/\.claude\/\.claude\.json\n {2}warning command-not-found/m);
  assert.match(out, /^\.mcp\.json\n {2}warning unapproved/m);
  assert.match(out, /effect: /);
  assert.match(out, /fix: /);
  assert.match(out, /0 errors, 2 warnings, 0 notes; 2 servers/);
});

test("the counts", () => {
  assert.deepEqual(countFindings([{ severity: "error" }, { severity: "note" }, { severity: "note" }]), { error: 1, warning: 0, note: 2 });
});

test("a secret in an argument or a URL is never in a finding", async () => {
  const w = world("lint8");
  w.claudeJson({ mcpServers: { s: { command: "definitely-not-a-command-xyz", args: ["--api-key", "sk-ant-api03-abcdefghijklmnop"] }, r: { type: "http", url: "http://example.com/mcp?token=abc123secret" } } });
  const out = JSON.stringify(await lint(w)) + (await run(["lint"], w)).out + (await run(["lint", "--markdown"], w)).out;
  assert.ok(!out.includes("abcdefghijklmnop") && !out.includes("abc123secret"));
});

test("literal credentials in a shared .mcp.json: warnings emitted and secrets are never in the text, JSON or markdown report", async () => {
  const w = world("lint-literal-cred");
  w.mcpJson({
    mcpServers: {
      search: {
        command: "npx",
        args: ["-y", "search-mcp", "--api-key", "sk-live-0123456789abcdef"],
        env: { SEARCH_TOKEN: "0123456789abcdef0123" },
      },
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ghp_0123456789abcdefghijklmnopqrstuv" },
      },
    },
  });
  w.local({ enabledMcpjsonServers: ["search", "github"] });
  const doc = await lint(w);
  const credFindings = doc.findings.filter((f) => f.id === "literal-credential");
  assert.equal(credFindings.length, 3);
  const fields = credFindings.map((f) => f.message).join(" ");
  assert.match(fields, /args\[3\]/);
  assert.match(fields, /env\.SEARCH_TOKEN/);
  assert.match(fields, /headers\.Authorization/);

  const text = (await run(["lint"], w)).out;
  const md = (await run(["lint", "--markdown"], w)).out;
  const allOut = JSON.stringify(doc) + text + md;

  assert.ok(!allOut.includes("0123456789abcdef"));
  assert.ok(!allOut.includes("0123456789abcdef0123"));
  assert.ok(!allOut.includes("ghp_0123456789abcdefghijklmnopqrstuv"));
});

test("a command written as a whole command line: Claude Code does not split it on Linux and macOS, and lint and why say so", async () => {
  const w = world("lint7");
  w.claudeJson({ mcpServers: { s: { command: "definitely-not-installed-xyz -y some-server" } } });
  const linux = (await run(["lint", "--json"], w, { platform: "linux" })).json();
  const f = linux.findings.find((x) => x.id === "command-not-found");
  assert.ok(f, "the whole string is looked for as a program");
  assert.match(f.fix, /does not split `command` at spaces on Linux and macOS/);
  assert.match(f.does, /"ENOENT"/);
  const windows = (await run(["lint", "--json"], w, { platform: "win32" })).json();
  const g = windows.findings.find((x) => x.id === "command-not-found");
  assert.ok(g, "on Windows the first word is looked for");
  assert.match(g.does, /CONNECTION_CLOSED/);
  assert.doesNotMatch(g.fix, /split/);
  const why = (await run(["why", "s", "--json", "--timeout", "2000"], w, { platform: "linux" })).json();
  assert.equal(why.cause, "command-not-found");
  assert.match(why.fix, /does not split `command` at spaces on Linux and macOS/);
});
