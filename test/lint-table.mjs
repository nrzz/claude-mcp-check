// The configurations that lint is held to: each row builds a world through the small interface `s` (the same for the test
// worlds of test/helpers.mjs and for the sandboxes of the real-binary checks), and says which findings lint must report.
// `binary` says what the real binary shows for the same files (test/e2e-claude.test.mjs puts it to `claude mcp list`); `since` is the
// first version of Claude Code that it holds for, as [major, minor, patch].
// `node --test` also runs this file; it only exports.
import path from "node:path";
import { SERVER, fake } from "./helpers.mjs";

const NODE = process.execPath;
const ok = (mark = "ok") => fake("ok", { args: [mark] });

// s: { claudeJson(top, projectPatch), mcpJson(value, dir?), user(v), project(v), local(v), managedSettings(v), write(file, v), base, work, mcpJsonAbove(v) }
export const ROWS = [
  { name: "a clean configuration", setup: (s) => s.claudeJson({ mcpServers: { a: ok() } }), expect: [] },
  {
    name: "a name in two scopes with different commands",
    setup: (s) => s.claudeJson({ mcpServers: { dup: ok("user") } }, { mcpServers: { dup: ok("local") } }),
    expect: ["duplicate-name"], severity: { "duplicate-name": "warning" }, binary: { listHas: /Conflicting scopes/ },
  },
  {
    name: "a name in two scopes with the same command",
    setup: (s) => s.claudeJson({ mcpServers: { dup: ok("same") } }, { mcpServers: { dup: ok("same") } }),
    expect: ["duplicate-name"], severity: { "duplicate-name": "note" }, binary: { listLacks: /Conflicting scopes/ },
  },
  { name: "a command that is not on the PATH", setup: (s) => s.claudeJson({ mcpServers: { missing: { command: "definitely-not-a-command-xyz", args: ["a"] } } }), expect: ["command-not-found"], binary: { status: { missing: "failed" } } },
  {
    name: "a ${VAR} set nowhere",
    setup: (s) => s.claudeJson({ mcpServers: { v: { command: NODE, args: [SERVER, "serve", "ok", "--key=${LINT_ROW_UNSET}"] } } }),
    expect: ["variable-unset"], message: { "variable-unset": /LINT_ROW_UNSET/ }, binary: { listHas: /Missing environment variables: LINT_ROW_UNSET/ },
  },
  {
    name: "a ${VAR} that has a default, or is set, is fine",
    setup: (s) => s.claudeJson({ mcpServers: { v: { command: NODE, args: [SERVER, "serve", "ok", "--a=${LINT_ROW_UNSET:-x}", "--b=${HOME}"] } } }),
    expect: [], binary: { listLacks: /Missing environment variables/ },
  },
  {
    name: "a ${VAR} that only a project settings file sets",
    setup: (s) => { s.claudeJson({ mcpServers: { v: { command: NODE, args: [SERVER, "serve", "ok", "--key=${LINT_ROW_PROJ}"] } } }); s.project({ env: { LINT_ROW_PROJ: "x" } }); },
    expect: ["variable-unset"], message: { "variable-unset": /set in the env of a project or local settings file/ }, binary: { listHas: /Missing environment variables: LINT_ROW_PROJ/ },
  },
  {
    name: "a ${VAR} that the user settings file sets",
    setup: (s) => { s.claudeJson({ mcpServers: { v: { command: NODE, args: [SERVER, "serve", "ok", "--key=${LINT_ROW_USER}"] } } }); s.user({ env: { LINT_ROW_USER: "x" } }); },
    expect: [], binary: { listLacks: /Missing environment variables/ },
  },
  {
    name: "CLAUDE_PROJECT_DIR outside a plugin",
    setup: (s) => s.claudeJson({ mcpServers: { v: { command: NODE, args: [SERVER, "serve", "ok", "${CLAUDE_PROJECT_DIR}"] } } }),
    expect: ["variable-unset"], message: { "variable-unset": /CLAUDE_PROJECT_DIR:-\./ }, binary: { listHas: /Missing environment variables: CLAUDE_PROJECT_DIR/ },
  },
  {
    name: "a credential name in the headers of a remote server",
    setup: (s) => s.claudeJson({ mcpServers: { r: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${NPM_TOKEN}" } } } }),
    expect: ["credential-read-as-empty"],
  },
  { name: "a .mcp.json server nobody approved", setup: (s) => s.mcpJson({ mcpServers: { p: ok() } }), expect: ["unapproved"], binary: { status: { p: "pending" } } },
  {
    name: "an approved .mcp.json server",
    setup: (s) => { s.mcpJson({ mcpServers: { p: ok() } }); s.local({ enabledMcpjsonServers: ["p"] }); },
    expect: [], binary: { status: { p: "connected" } },
  },
  {
    name: "a server both enabled and disabled",
    setup: (s) => { s.mcpJson({ mcpServers: { p: ok() } }); s.local({ enabledMcpjsonServers: ["p"], disabledMcpjsonServers: ["p"] }); },
    expect: ["enabled-and-disabled", "rejected"], binary: { absent: ["p"] },
  },
  {
    name: "a plain string where enabledMcpjsonServers belongs",
    setup: (s) => { s.mcpJson({ mcpServers: { p: ok() } }); s.local({ enabledMcpjsonServers: "p" }); },
    expect: ["list-is-string"],
  },
  { name: "an object where disabledMcpjsonServers belongs", setup: (s) => { s.mcpJson({ mcpServers: { p: ok() } }); s.local({ disabledMcpjsonServers: { p: true } }); }, expect: ["list-is-not-a-list", "unapproved"] },
  {
    name: "a plain-http URL",
    setup: (s) => s.claudeJson({ mcpServers: { r: { type: "http", url: "http://mcp.example.com/mcp" } } }),
    expect: ["plain-http"],
  },
  { name: "a plain-http URL on this machine", setup: (s) => s.claudeJson({ mcpServers: { r: { type: "http", url: "http://127.0.0.1:3000/mcp" } } }), expect: [] },
  { name: "an https URL", setup: (s) => s.claudeJson({ mcpServers: { r: { type: "http", url: "https://mcp.example.com/mcp" } } }), expect: [] },
  { name: "an empty url", setup: (s) => s.claudeJson({ mcpServers: { r: { type: "http", url: "" } } }), expect: ["empty-url"], binary: { listHas: /Not configured/ } },
  { name: "a url that is not a URL", setup: (s) => s.claudeJson({ mcpServers: { r: { type: "http", url: "not a url" } } }), expect: ["invalid-url"], binary: { status: { r: "failed" } } },
  {
    name: "a .mcp.json with a comment",
    setup: (s) => s.write(s.mcpJsonFile, '{\n  // note\n  "mcpServers": {}\n}\n'),
    expect: ["invalid-json"], binary: { listHas: /not a valid JSON/ },
  },
  { name: "a .mcp.json with servers for mcpServers", setup: (s) => s.mcpJson({ servers: { a: ok() } }), expect: ["wrong-top-key"], binary: { listHas: /found "servers" instead/ } },
  { name: "a .mcp.json with a list of servers", setup: (s) => s.mcpJson({ mcpServers: [ok()] }), expect: ["servers-not-object"], binary: { listHas: /expected record, received array/ } },
  { name: "an empty .mcp.json", setup: (s) => s.write(s.mcpJsonFile, ""), expect: [], binary: { since: [2, 1, 299], listLacks: /Failed to parse/ } }, // 2.1.295 says "Failed to parse" for a file of zero bytes
  {
    name: "a .mcp.json that is an empty object",
    setup: (s) => s.write(s.mcpJsonFile, "{}\n"),
    expect: ["no-mcpservers"], severity: { "no-mcpservers": "note" }, binary: { listHas: /mcpServers: Invalid input: expected record, received undefined/ },
  },
  {
    name: "a .mcp.json with other keys and no mcpServers",
    setup: (s) => s.write(s.mcpJsonFile, '{ "foo": 1 }\n'),
    expect: ["no-mcpservers"], severity: { "no-mcpservers": "warning" }, message: { "no-mcpservers": /"foo"/ }, binary: { listHas: /mcpServers: Invalid input: expected record, received undefined/ },
  },
  { name: "a .mcp.json that holds a list", setup: (s) => s.write(s.mcpJsonFile, "[]\n"), expect: ["not-object"], binary: { listHas: /Invalid input: expected object, received array/ } },
  {
    name: "an entry Claude Code skips",
    setup: (s) => s.claudeJson({ mcpServers: { bad: { args: ["a"] }, good: ok() } }),
    expect: ["skipped-server"], binary: { listHas: /Skipped — invalid MCP server config for "bad"/, absent: ["bad"] },
  },
  {
    name: "two names that share a tool prefix",
    setup: (s) => s.claudeJson({ mcpServers: { "my.server": ok("dot"), my_server: ok("underscore") } }),
    expect: ["name-collision"],
  },
  {
    name: "a server kept out by deniedMcpServers",
    setup: (s) => { s.claudeJson({ mcpServers: { a: ok(), b: ok("b") } }); s.user({ deniedMcpServers: [{ serverName: "b" }] }); },
    expect: ["blocked-by-policy"], binary: { absent: ["b"] },
  },
  { name: "entries of the wrong shape in deniedMcpServers", setup: (s) => { s.claudeJson({ mcpServers: { a: ok() } }); s.user({ deniedMcpServers: ["a"] }); }, expect: ["policy-entry"], binary: { status: { a: "connected" } } },
  { name: "a server the project switched off", setup: (s) => s.claudeJson({ mcpServers: { a: ok() } }, { disabledMcpServers: ["a"] }), expect: ["disabled-for-project"], binary: { status: { a: "disabled" } } },
  { name: "a rejected server", setup: (s) => { s.mcpJson({ mcpServers: { p: ok() } }); s.local({ disabledMcpjsonServers: ["p"] }); }, expect: ["rejected"], binary: { absent: ["p"] } },
  {
    name: "an approval for a server that is not there",
    setup: (s) => { s.mcpJson({ mcpServers: { p: ok() } }); s.local({ enabledMcpjsonServers: ["p", "typo"] }); },
    expect: ["unknown-server-name"], message: { "unknown-server-name": /"typo"/ },
  },
  {
    name: "a settings file with a comment that holds an approval",
    setup: (s) => { s.mcpJson({ mcpServers: { p: ok() } }); s.write(s.localFile, '{\n  // note\n  "enabledMcpjsonServers": ["p"]\n}\n'); },
    expect: ["settings-ignored", "unapproved"], binary: { status: { p: "pending" } },
  },
  { name: "a list in .claude.json of the wrong shape", setup: (s) => s.claudeJson({ mcpServers: { a: ok() } }, { disabledMcpServers: "a" }), expect: ["list-is-not-a-list"], binary: { status: { a: "connected" } } },
  { name: "a .mcp.json above the project", setup: (s) => { s.mcpJsonAbove({ mcpServers: { above: ok() } }); s.local({ enableAllProjectMcpServers: true }); }, expect: ["mcp-json-above-project"], binary: { status: { above: "connected" } } },
  {
    name: "a server with a ${VAR} for the command",
    setup: (s) => s.claudeJson({ mcpServers: { c: { command: "${LINT_ROW_BIN}", args: ["x"] } } }),
    expect: ["command-not-found", "variable-unset"],
  },
];

export const worldUnder = (base) => path.join(base, "work");
