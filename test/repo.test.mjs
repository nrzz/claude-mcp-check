// The package itself: what it says it is, what it imports, which Node it needs, that only the two places that must start a
// program or open a connection do, that only one file writes, that the plugin's skill calls the tool with options the tool
// has, that the icon is a real PNG of the right size, that no file has a carriage return, that the workflows and the README have
// what they promise, and that the version is the same everywhere.
import { ROOT, fake, run, world } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { HELP, parseArgs } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";

// a checkout on Windows may turn line feeds into CRLF
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const json = (rel) => JSON.parse(read(rel));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const files = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));
const posix = (f) => f.split(path.sep).join("/");

const pkg = json("package.json");
const plugin = json(".claude-plugin/plugin.json");
const SOURCES = [...files("src", ".mjs"), ...files("bin", ".mjs")];

test("package.json: name, version, bin, engines, no dependencies, tests run with node --test, the files that are shipped", () => {
  assert.equal(pkg.name, "claude-mcp-check");
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.bin, { "claude-mcp-check": "bin/claude-mcp-check.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) assert.equal(pkg[k], undefined, k);
  assert.equal(pkg.scripts.test, "node --test");
  assert.deepEqual(pkg.files, ["bin", "src", ".claude-plugin", "skills", "README.md", "LICENSE"]);
  for (const f of pkg.files) assert.ok(exists(f), `${f} is listed and exists`);
  assert.match(pkg.description, /^Every MCP server Claude Code would load/);
  assert.match(pkg.description, /Zero tokens\.$/);
  assert.equal(pkg.repository, "github:nrzz/claude-mcp-check");
  assert.equal(pkg.homepage, "https://nrzz.github.io/claude-code-toolkit/");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-mcp-check/issues");
  assert.equal(pkg.author, "Naresh Prabu");
  for (const k of ["claude", "claude-code", "mcp", "model-context-protocol", "mcp-servers", "diagnostics", "configuration", "context-window"]) assert.ok(pkg.keywords.includes(k), k);
});

test("no lock file, no vendored node_modules, and no .gitattributes (the plugin directory cannot validate a repository that has one)", () => {
  assert.ok(!exists("package-lock.json"));
  assert.ok(!exists("npm-shrinkwrap.json"));
  assert.ok(!exists("yarn.lock"));
  assert.ok(!exists("node_modules") || fs.readdirSync(path.join(ROOT, "node_modules")).length === 0);
  assert.ok(!exists(".gitattributes"));
  assert.match(read(".gitignore"), /^node_modules\/$/m);
});

test("no tracked text file has a carriage return: every file is written with LF (the index is read, a checkout on Windows may differ)", { skip: !exists(".git") && "not a git checkout" }, () => {
  const ls = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer", windowsHide: true });
  assert.equal(ls.status, 0, String(ls.stderr));
  const tracked = ls.stdout.toString("utf8").split("\0").filter(Boolean);
  assert.ok(tracked.length > 20, `${tracked.length} tracked files`);
  const withCr = [];
  for (const f of tracked) {
    if (/\.(png|ico|jpg|gif|woff2?)$/i.test(f)) continue;
    const blob = spawnSync("git", ["show", `:${f}`], { cwd: ROOT, encoding: "buffer", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (blob.status === 0 && blob.stdout.includes(13)) withCr.push(f);
  }
  assert.deepEqual(withCr, [], "files that hold a carriage return in the index");
});

test("the plugin manifest matches the package, with the six links the plugin directory reads", () => {
  assert.equal(plugin.name, "mcp-check");
  assert.equal(plugin.displayName, "MCP Check");
  assert.equal(plugin.version, VERSION);
  assert.equal(plugin.license, "MIT");
  assert.deepEqual(plugin.author, { name: "Naresh Prabu" });
  assert.equal(plugin.homepage, "https://github.com/nrzz/claude-mcp-check");
  assert.equal(plugin.repository, "https://github.com/nrzz/claude-mcp-check");
  assert.equal(plugin.documentationUrl, "https://github.com/nrzz/claude-mcp-check#readme");
  assert.equal(plugin.supportUrl, "https://github.com/nrzz/claude-mcp-check/issues");
  assert.equal(plugin.privacyPolicyUrl, "https://github.com/nrzz/claude-mcp-check#privacy");
  assert.equal(plugin.termsOfServiceUrl, "https://github.com/nrzz/claude-mcp-check/blob/main/LICENSE");
  assert.deepEqual(plugin.keywords, ["mcp", "model-context-protocol", "servers", "configuration", "diagnostics", "context"]);
  assert.match(plugin.description, /\/mcp-check:check/);
  assert.equal(plugin.hooks, undefined, "no hooks: the plugin is one skill");
  assert.equal(plugin.mcpServers, undefined, "a tool that lists MCP servers brings none of its own");
  assert.ok(!exists(".mcp.json") && !exists("hooks") && !exists("agents") && !exists("commands"));
});

test("the icon is a real PNG, 1024 by 1024, as the other plugins' are", () => {
  const png = fs.readFileSync(path.join(ROOT, ".claude-plugin", "icon.png"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "the PNG signature");
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 1024, "width");
  assert.equal(png.readUInt32BE(20), 1024, "height");
  assert.ok(png.length > 2000 && png.length < 500000, `${png.length} bytes`);
  assert.equal(png.toString("ascii", png.length - 8, png.length - 4), "IEND");
});

test("one skill, /mcp-check:check: user-only, a description of three words, allowed to run this tool and nothing wider", () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "skills")), ["check"]);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "skills", "check")), ["SKILL.md"]);
  const text = read("skills/check/SKILL.md");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(front, "has frontmatter");
  assert.match(front[1], /^name: check$/m);
  assert.match(front[1], /^disable-model-invocation: true$/m);
  const desc = /^description: (.+)$/m.exec(front[1])[1];
  assert.equal(desc, "Check MCP servers.", "the hub's plugins share an always-on limit of 200 tokens");
  assert.ok(desc.length <= 30, `${desc.length} characters`);
  const allowed = /^allowed-tools: (.+)$/m.exec(front[1])[1];
  const rules = allowed.split(/\s(?=(?:Bash|PowerShell)\()/);
  assert.equal(rules.length, 4);
  for (const rule of rules) assert.match(rule, /^(Bash|PowerShell)\(node "?\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-mcp-check\.mjs"? \*\)$/, rule);
  assert.ok(rules.some((r) => r.startsWith("Bash(")) && rules.some((r) => r.startsWith("PowerShell(")), "for whichever shell tool Claude Code has");
  assert.doesNotMatch(allowed, /Bash\(\*\)|Edit|Write|WebFetch/, "nothing wider than the one command");
});

test("the skill runs lint --markdown for the project, once, and asks for at most 10 lines and no edit before the user agrees", () => {
  const text = read("skills/check/SKILL.md");
  const body = text.slice(/^---\n[\s\S]*?\n---\n/.exec(text)[0].length);
  const commands = [...body.matchAll(/^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-mcp-check\.mjs" (.+)`$/gm)].map((m) => m[1]);
  assert.equal(commands.length, 1, "one command line, which Claude Code runs or hands to the model");
  const parsed = parseArgs(commands[0].replace(/"\$\{CLAUDE_PROJECT_DIR\}"/g, "dir").split(/\s+/));
  assert.equal(parsed.command, "lint");
  assert.equal(parsed.markdown, true);
  assert.equal(parsed.project, "dir");
  assert.match(body, /At most 10 lines: each problem with its file and line, and the fix\./);
  assert.match(body, /If there are no findings, say so in one line\./);
  assert.match(body, /Edit nothing until the user agrees\./);
  assert.ok(!/\$\{CLAUDE_SKILL_DIR\}|\$ARGUMENTS/.test(body));
  assert.ok(body.length < 600, `the instructions are ${body.length} characters; each use pays for them`);
});

test("every source file is .mjs and imports only node built-ins and the package itself", () => {
  assert.ok(SOURCES.length >= 25);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "src")).filter((n) => !n.endsWith(".mjs")), []);
  const allowed = new Set(["node:child_process", "node:crypto", "node:fs", "node:http", "node:https", "node:os", "node:path"]);
  for (const f of SOURCES) {
    const text = read(f);
    for (const m of text.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)) {
      const spec = m[1];
      assert.ok(spec.startsWith("./") || spec.startsWith("../") || allowed.has(spec), `${f} imports ${spec}`);
    }
    assert.doesNotMatch(text, /\brequire\(|\bimport\(/, `${f} has no dynamic loading`);
  }
});

test("only src/stdio.mjs starts a program, only src/http.mjs opens a connection, and nothing else can reach the network or run code", () => {
  const startsProcess = /node:child_process|(?<![.\w])(spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(/;
  const opensConnection = /node:(http|https|http2|net|tls|dns|dgram)\b|(?<![.\w])(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/;
  const runsCode = /node:(worker_threads|cluster|vm)\b|\bprocess\.binding\b|\beval\s*\(|new Function\s*\(/;
  for (const f of SOURCES) {
    const name = posix(f);
    const text = read(f);
    if (name !== "src/stdio.mjs") assert.doesNotMatch(text, startsProcess, `${name} must not start a program: only src/stdio.mjs does`);
    if (name !== "src/http.mjs") assert.doesNotMatch(text, opensConnection, `${name} must not open a connection: only src/http.mjs does`);
    assert.doesNotMatch(text, runsCode, name);
  }
  assert.match(read("src/stdio.mjs"), /node:child_process/);
  assert.match(read("src/http.mjs"), /node:http/);
  assert.doesNotMatch(read("src/stdio.mjs"), /node:(http|https|net)/);
  assert.doesNotMatch(read("src/http.mjs"), /node:child_process/);
});

test("src/write.mjs is the only code that writes: nothing else in the package calls a function that changes a file", () => {
  const writes = /\b(?:writeFile|appendFile|copyFile|rename|unlink|rmdir|rm|mkdir|truncate|symlink|link|chmod|utimes)(?:Sync)?\s*\(|\bcreateWriteStream\b|\bfs\.promises\b/;
  for (const f of SOURCES) {
    if (posix(f) === "src/write.mjs") continue;
    assert.doesNotMatch(read(f), writes, `${f} must not write: only src/write.mjs does`);
  }
  assert.match(read("src/write.mjs"), /fs\.writeFileSync/);
  assert.match(read("src/write.mjs"), /fs\.mkdirSync\(lock\)/, "and the lock around ~/.claude.json");
});

test("only APIs that exist in Node 18 are used", () => {
  const newer = [
    [/\.toSorted\(|\.toReversed\(|\.toSpliced\(|\.with\(\d/, "Array copy-methods (Node 20)"],
    [/\bObject\.groupBy\b|\bMap\.groupBy\b/, "groupBy (Node 21)"],
    [/\bArray\.fromAsync\b/, "Array.fromAsync (Node 22)"],
    [/\bPromise\.withResolvers\b/, "Promise.withResolvers (Node 22)"],
    [/import\.meta\.(dirname|filename)\b/, "import.meta.dirname/filename (Node 20.11)"],
    [/\bfs\.(glob|globSync)\b/, "fs.glob (Node 22)"],
    [/\.(isWellFormed|toWellFormed)\(/, "String well-formed methods (Node 20)"],
    [/\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, "Set methods (Node 22)"],
    [/process\.getBuiltinModule|process\.loadEnvFile|util\.styleText|\bstyleText\b/, "newer process/util APIs"],
    [/\bimport\s[^;]*\swith\s*\{/, "import attributes"],
    [/\bfs\.cpSync\b/, "fs.cpSync is experimental before Node 22"],
  ];
  for (const f of SOURCES) {
    const text = read(f);
    for (const [re, what] of newer) assert.doesNotMatch(text, re, `${f}: ${what}`);
  }
});

test("the licence, the conduct file, the changelog and the version agree", () => {
  assert.match(read("LICENSE"), /^MIT License/);
  assert.match(read("LICENSE"), /Copyright \(c\) 2026 Naresh Prabu/);
  assert.ok(exists("CODE_OF_CONDUCT.md"));
  assert.match(read("CHANGELOG.md"), new RegExp(`^## \\[${VERSION.replace(/\./g, "\\.")}\\] - 2026-10-16$`, "m"));
  assert.match(read("CHANGELOG.md"), new RegExp(`^\\[${VERSION.replace(/\./g, "\\.")}\\]: https://github\\.com/nrzz/claude-mcp-check/releases/tag/v${VERSION.replace(/\./g, "\\.")}$`, "m"));
  for (const f of ["SECURITY.md", "SUPPORT.md", "ROADMAP.md", "CONTRIBUTING.md"]) assert.ok(exists(f), f);
  assert.match(read("SECURITY.md"), /security\/advisories\/new/);
  const roadmap = read("ROADMAP.md");
  assert.ok((roadmap.match(/^- /gm) || []).length >= 3 && (roadmap.match(/^- /gm) || []).length <= 5, "three to five next steps");
  assert.match(roadmap, /good first issue: \[#1\]\(https:\/\/github\.com\/nrzz\/claude-mcp-check\/issues\/1\)/, "the roadmap names the good first issue");
});

test("the issue forms and the pull request template are there", () => {
  for (const f of ["bug_report.yml", "feature_request.yml", "config.yml"]) assert.ok(exists(`.github/ISSUE_TEMPLATE/${f}`), f);
  assert.match(read(".github/ISSUE_TEMPLATE/config.yml"), /blank_issues_enabled: false/);
  assert.match(read(".github/ISSUE_TEMPLATE/config.yml"), /nrzz\/claude-mcp-check\/discussions/);
  assert.ok(exists(".github/PULL_REQUEST_TEMPLATE.md"));
  assert.match(read(".github/dependabot.yml"), /package-ecosystem: github-actions/);
  for (const f of ["bug_report.yml", "feature_request.yml"]) assert.match(read(`.github/ISSUE_TEMPLATE/${f}`), /claude-mcp-check/);
});

test("the CI workflows: the suite on three systems and four Node versions, and the real-binary checks on two systems with the third-party server, with no action version pinned here", () => {
  const ci = read(".github/workflows/test.yml");
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(ci, /node: \[20, 22, 24\]/);
  assert.match(ci, /node: 18/);
  assert.match(ci, /run: npm test/);
  assert.match(ci, /uses: actions\/checkout@/);
  assert.match(ci, /uses: actions\/setup-node@/);
  assert.match(ci, /timeout-minutes: \d+/);
  const e2e = read(".github/workflows/e2e.yml");
  for (const part of ["name: e2e", "ubuntu-latest, macos-latest", "npm install -g @anthropic-ai/claude-code", "continue-on-error: true", "E2E_CLAUDE: claude", "test/e2e-claude.test.mjs", "node test/everything.mjs run", "schedule:", "workflow_dispatch"]) assert.ok(e2e.includes(part), part);
  assert.match(e2e, /timeout-minutes: \d+/);
  assert.ok(!e2e.includes("windows"));
  // the step that needs the network may fail without failing the job; the real-binary checks may not
  const steps = e2e.split(/\n {6}- /);
  const everything = steps.find((s) => s.includes("everything.mjs"));
  const binary = steps.find((s) => s.includes("e2e-claude.test.mjs"));
  assert.match(everything, /continue-on-error: true/);
  assert.doesNotMatch(binary, /continue-on-error/);
});

const README_SECTIONS = ["## What you get", "## What it costs in tokens", "## Install", "## Use", "## How it works", "## What was verified, and how", "## Not verified", "## Files", "## Contributing", "## Part of the Claude Code toolkit", "## License"];
const TOOLKIT = [
  "- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself",
  "- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers",
  "- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD",
  "- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits",
  "- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes",
  "- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings",
  "- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it",
  "- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command",
  "- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay",
  "- [claude-chat-ferry](https://github.com/nrzz/claude-chat-ferry): continue a Cursor or Antigravity chat in Claude Code, or hand a session to them",
  "- [claude-permission-doctor](https://github.com/nrzz/claude-permission-doctor): why a permission prompt appeared, dead rules, rules from your history",
  "- [claude-session-tidy](https://github.com/nrzz/claude-session-tidy): list, delete, keep and restore your sessions before the 30-day sweep",
  "- [claude-hook-bench](https://github.com/nrzz/claude-hook-bench): run every hook with the JSON Claude Code sends, and see what each one does",
  "- [claude-relocate](https://github.com/nrzz/claude-relocate): move Claude Code's config folder to another drive or the XDG folders, safely, with undo",
  "- [claude-settings-doctor](https://github.com/nrzz/claude-settings-doctor): a commented settings.jsonc that builds settings.json, the merged settings with their source, a lint against the schema",
  "- [claude-automode-doctor](https://github.com/nrzz/claude-automode-doctor): what auto mode and its classifier decided, from your transcripts, plus a lint of the autoMode settings",
  "- [claude-sandbox-doctor](https://github.com/nrzz/claude-sandbox-doctor): whether Claude Code's Bash sandbox works on this machine, and why a command ran inside it, outside it, or not at all",
  "- [claude-windows-doctor](https://github.com/nrzz/claude-windows-doctor): which shell the Bash tool gets on Windows and why, every claude on PATH, and the setup problems behind common Windows issues",
];

test("the README has the sections the house keeps, in order, and the Privacy heading the plugin manifest links to", () => {
  const readme = read("README.md");
  let at = -1;
  for (const h of README_SECTIONS) {
    const i = readme.indexOf(`\n${h}\n`);
    assert.ok(i > at, `${h} is there, after the one before it`);
    at = i;
  }
  assert.match(readme, /^# claude-mcp-check\n/);
  assert.ok(readme.indexOf("\n### Privacy\n") > readme.indexOf("\n## How it works\n") && readme.indexOf("\n### Privacy\n") < readme.indexOf("\n## What was verified, and how\n"), "### Privacy sits under How it works");
  assert.ok(plugin.privacyPolicyUrl.endsWith("#privacy"));
  assert.ok(exists("README.md"));
});

test("the README names every command and every option the CLI has, and the install lines", () => {
  const readme = read("README.md");
  for (const cmd of ["show", "check", "why", "lint", "toggle", "restore"]) assert.ok(readme.includes(`### \`${cmd}\``), `a heading for ${cmd}`);
  for (const flag of ["--project", "--mcp-config", "--json", "--markdown", "--timeout", "--send-headers", "--include-unapproved", "--on", "--off", "--dry-run", "--claude-json", "--list"]) assert.ok(readme.includes(`\`${flag}`), flag);
  for (const cmd of ["claude-mcp-check show", "claude-mcp-check check", "claude-mcp-check why", "claude-mcp-check lint", "claude-mcp-check toggle", "claude-mcp-check restore"]) assert.ok(readme.includes(cmd), cmd);
  assert.ok(readme.includes("npx -y github:nrzz/claude-mcp-check show --project ."));
  assert.ok(readme.includes("git clone https://github.com/nrzz/claude-mcp-check"));
  assert.ok(readme.includes("/plugin marketplace add nrzz/claude-code-toolkit"));
  assert.ok(readme.includes("/plugin install mcp-check@claude-code-toolkit"));
  assert.ok(readme.includes("/mcp-check:check"));
  for (const number of ["534 open issues", "517", "81", "61", "#10447", "55 reactions", "#11927", "31 reactions"]) assert.ok(readme.includes(number), number);
  assert.ok(!/\p{Extended_Pictographic}/u.test(readme), "no emoji");
  assert.ok(!/\b(simply|easily|blazing|seamless|powerful|amazing)\b/i.test(readme), "plain words");
});

test("the toolkit list: the lines of the other tools, the page line and the star line; this tool is not in its own list", () => {
  const readme = read("README.md");
  const section = readme.slice(readme.indexOf("\n## Part of the Claude Code toolkit\n"), readme.indexOf("\n## License\n"));
  const lines = section.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines, TOOLKIT);
  assert.ok(!section.includes("claude-mcp-check"), "not in its own list");
  assert.ok(section.includes("Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on."));
  assert.ok(section.includes("If one of them saves you tokens, a star on its repository helps other people find it, and following [@nrzz](https://github.com/nrzz) on GitHub shows you new tools and releases."));
});

test("the links in the README that point into the repository go to files that are there", () => {
  const readme = read("README.md");
  for (const m of readme.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) assert.ok(exists(m[1].split("#")[0]), `${m[1]} is linked and exists`);
});

test("no test asks the machine for its home folder: every test builds its own world in a temporary folder", () => {
  for (const f of files("test", ".mjs")) {
    if (f.endsWith("repo.test.mjs")) continue;
    assert.doesNotMatch(read(f), /os\.homedir\(\)/, `${f} reaches for the real home folder`);
  }
});

test("the process the tests run in has its home, config folder and managed folder pointed at a throwaway folder", () => {
  assert.notEqual(process.env.CLAUDE_CONFIG_DIR, "");
  assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(process.env.HOME), "the config folder is inside the throwaway home");
  assert.match(process.env.CLAUDE_MCP_CHECK_MANAGED_DIR, /no-managed-settings$/);
  assert.equal(process.env.USERPROFILE, process.env.HOME);
  assert.equal(process.env.MCP_TIMEOUT, undefined);
});

test("the usage block of the README is the help text of the CLI, and nothing is left to fill in", async () => {
  const readme = read("README.md");
  const help = (await run(["--help"], world("readme-help"))).out;
  const usage = help.slice(help.indexOf("Usage: claude-mcp-check")).trimEnd();
  assert.equal(help, HELP);
  assert.ok(readme.includes(usage), "the README's usage block is out of date: paste the output of claude-mcp-check --help from its Usage line");
  assert.ok(!readme.includes("@@"), "a placeholder is still in the README");
});

test("the numbers the README quotes are the numbers of the code: the skill's instruction and description, the cap of the report", async () => {
  const readme = read("README.md");
  const skill = read("skills/check/SKILL.md");
  const body = skill.slice(/^---\n[\s\S]*?\n---\n/.exec(skill)[0].length);
  const instruction = body.split("\n").filter((l) => l && !l.startsWith("!`")).join("\n");
  assert.ok(readme.includes(`${instruction.length}-character instruction`), `the instruction is ${instruction.length} characters`);
  const desc = /^description: (.+)$/m.exec(skill)[1];
  assert.ok(readme.includes(`\`${desc}\`: ${desc.length} characters`), `the description is ${desc.length} characters`);
  assert.ok(readme.includes("at most 12 findings"));
  // the cap: 12 findings of a worst case world
  const w = world("readme-cap");
  w.claudeJson({ mcpServers: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, { command: `no-such-command-${i}` }])) });
  const md = (await run(["lint", "--markdown"], w)).out;
  assert.equal(md.split("\n").filter((l) => l.startsWith("- WARNING")).length, 12);
});

test("the README lists every finding id that lint can emit, and no other", () => {
  const readme = read("README.md");
  const section = /The ids are ([^]*?)\. Three need a word/.exec(readme);
  assert.ok(section, "the list of ids is in the README, under lint");
  const listed = [...section[1].matchAll(/`([a-z]+(?:-[a-z]+)*)`/g)].map((m) => m[1]).sort();
  const emitted = [...new Set(files("src", ".mjs").flatMap((f) => [...read(f).matchAll(/\bid: "([a-z]+(?:-[a-z]+)*)"/g)].map((m) => m[1])))].sort();
  assert.deepEqual(listed, emitted, "the ids of the README and the ids of src/ are the same");
  assert.equal(new Set(listed).size, listed.length, "no id twice");
});

test("the JSON shapes in the README: every field at the top of a document and in its lists is named there, and every field named is in a document or marked optional", async () => {
  const readme = read("README.md");
  const start = readme.indexOf("\nshow    { project");
  assert.ok(start > 0, "the shapes are in the README");
  const block = readme.slice(start, readme.indexOf("\n```", start));
  const entries = {};
  let current = null;
  for (const line of block.split("\n")) {
    const m = /^([a-z]+)\s+\{/.exec(line);
    if (m) { current = m[1]; entries[current] = ""; }
    if (current) entries[current] += `${line}\n`;
  }
  assert.deepEqual(Object.keys(entries), ["show", "check", "why", "lint", "toggle", "restore"]);
  const w = world("shapes");
  w.claudeJson({ mcpServers: { u1: fake("ok"), web: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { A: "b" } }, bad: { args: ["x"] } } }, { mcpServers: { l1: fake("ok") }, disabledMcpServers: ["u1"] });
  w.mcpJson({ mcpServers: { p1: fake("ok"), p2: fake("ok") } });
  w.local({ enabledMcpjsonServers: ["p1"] });
  const docs = {
    show: [(await run(["show", "--json"], w)).json()],
    check: [(await run(["check", "--json", "--timeout", "10000"], w)).json()],
    why: [(await run(["why", "l1", "--json", "--timeout", "10000"], w)).json()],
    lint: [(await run(["lint", "--json"], w)).json()],
    toggle: [(await run(["toggle", "p2", "--on", "--json"], w)).json()],
  };
  docs.restore = [(await run(["restore", "--json"], w)).json(), (await run(["restore", "--list", "--json"], w)).json()];
  const everyKey = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => everyKey(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); everyKey(x, out); } return out; };
  const levels = { show: ["", "servers"], check: ["", "servers"], why: [""], lint: ["", "findings"], toggle: ["", "changes"], restore: [""] };
  for (const [command, list] of Object.entries(docs)) {
    const words = [...entries[command].matchAll(/([A-Za-z][A-Za-z0-9]*)(\?)?/g)].filter((m) => m[1] !== command && m[1] !== "list");
    const named = new Set(words.map((m) => m[1]));
    const anywhere = new Set(list.flatMap((d) => [...everyKey(d)]));
    for (const doc of list) {
      for (const path of levels[command]) {
        const objects = path ? doc[path] : [doc];
        for (const o of objects) for (const k of Object.keys(o)) assert.ok(named.has(k), `${command}${path ? `.${path}[]` : ""}: the field "${k}" is not in the README shape`);
      }
    }
    for (const [, name, optional] of words) if (!optional) assert.ok(anywhere.has(name), `${command}: the README names the field "${name}", which no document has (mark it with ? if it is optional)`);
  }
});

test("the Files table of the README names every source file, and every file it names is there", () => {
  const readme = read("README.md");
  const section = readme.slice(readme.indexOf("\n## Files\n"), readme.indexOf("\n## Contributing\n"));
  assert.ok(section.length > 100, "the section is there");
  for (const f of SOURCES) assert.ok(section.includes(`\`${posix(f)}\``), `${f} is in the Files table`);
  for (const dir of ["skills/check/", ".claude-plugin/", "test/"]) assert.ok(section.includes(`\`${dir}\``), `${dir} is in the Files table`);
  for (const m of section.matchAll(/`((?:src|bin|skills|\.claude-plugin|test)\/[^`\s]*)`/g)) assert.ok(exists(m[1].replace(/\/$/, "")), `${m[1]} is named in the Files table and exists`);
});
