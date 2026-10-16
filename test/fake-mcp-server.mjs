// A tiny MCP server over stdio for the tests (Node, no dependencies): it answers `initialize`, `ping`, `tools/list`,
// `resources/list`, `prompts/list` and `tools/call`, one JSON-RPC message per line, as the MCP specification says.
// It starts only when it is run as `node fake-mcp-server.mjs serve [mode]`; run any other way (`node --test` runs every
// file under test/ once) it does nothing and exits 0.
//
// Modes (the third argument, or FMCP_MODE):
//   ok          answers everything; three tools of a known size, two resources, one prompt, server instructions
//   paged       as ok, but tools/list comes in two pages (nextCursor)
//   tools-only  declares tools only; resources/list and prompts/list answer "method not found"
//   banner      prints a line that is not JSON to stdout, then behaves as ok
//   garbage     prints lines that are not JSON-RPC to stdout and answers nothing
//   early-exit  writes to stderr and exits with FMCP_EXIT (default 3) before the handshake
//   sleep       waits FMCP_DELAY_MS (default 60000) before it reads anything: past any timeout
//   slow        answers initialize after FMCP_DELAY_MS (default 1500), then behaves as ok
//   silent      reads stdin and never answers
//   big         as ok, plus a tool whose description is 6000 characters long
//   init-error  answers initialize with a JSON-RPC error
//   stubborn    never answers, does not leave when its stdin closes, and starts a child of its own that does not leave either
// Environment:
//   FMCP_LOG    a file: one JSON line per event (start with argv, cwd and the environment names, every message in, exit)
//   FMCP_ECHO   names of environment variables, comma separated: the tool `whoami` shows their values, the arguments
//               and the working directory in its description, so a test can see what a client expanded
//   FMCP_NAME   the name the server gives itself (default fake-mcp)
import fs from "node:fs";
import { spawn } from "node:child_process";

export const SERVER_VERSION = "1.2.3";
export const INSTRUCTIONS = "Use the fake tools for tests only.";

export const TOOLS = [
  { name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string", description: "The text to echo." } }, required: ["text"] } },
  { name: "add", description: "Add two numbers and return the sum.", inputSchema: { type: "object", properties: { a: { type: "number", description: "The first number." }, b: { type: "number", description: "The second number." } }, required: ["a", "b"] } },
  { name: "list_items", description: "List items from a collection, newest first.", inputSchema: { type: "object", properties: { collection: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 }, cursor: { type: "string" } }, required: ["collection"] } },
];
export const BIG_TOOL = { name: "big_description", description: "x".repeat(6000), inputSchema: { type: "object", properties: {} } };
// tools whose full name is 127, 128, 129 and 130 characters long when the server is called `fake` (mcp__fake__ is 11 characters)
export const LONG_TOOLS = [116, 117, 118, 119].map((n) => ({ name: "n".repeat(n), description: `a tool with a name of ${n} characters`, inputSchema: { type: "object", properties: {} } }));
export const RESOURCES = [
  { uri: "fake://readme", name: "readme", mimeType: "text/plain" },
  { uri: "fake://data", name: "data", mimeType: "application/json" },
];
export const PROMPTS = [{ name: "greet", description: "Greet someone.", arguments: [{ name: "who", required: true }] }];
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** The tools a server in this mode lists (whoami is added when FMCP_ECHO is set). */
export function toolsFor(mode, env = process.env, argv = process.argv, cwd = process.cwd()) {
  const tools = [...TOOLS];
  if (mode === "big") tools.push(BIG_TOOL);
  if (mode === "longname") tools.push(...LONG_TOOLS);
  if (env.FMCP_ECHO !== undefined) {
    const names = env.FMCP_ECHO.split(",").filter(Boolean);
    const seen = { argv: argv.slice(3), cwd, env: Object.fromEntries(names.map((n) => [n, env[n] === undefined ? null : env[n]])) };
    tools.push({ name: "whoami", description: `seen: ${JSON.stringify(seen)}`, inputSchema: { type: "object", properties: {} } });
  }
  return tools;
}

function serve() {
  const mode = process.argv[3] || process.env.FMCP_MODE || "ok";
  const name = process.env.FMCP_NAME || "fake-mcp";
  const log = (event) => { if (process.env.FMCP_LOG) { try { fs.appendFileSync(process.env.FMCP_LOG, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...event })}\n`); } catch { /* the log is a convenience */ } } };
  log({ event: "start", mode, argv: process.argv.slice(2), cwd: process.cwd(), envNames: Object.keys(process.env).sort(), echo: process.env.FMCP_ECHO === undefined ? undefined : Object.fromEntries(process.env.FMCP_ECHO.split(",").filter(Boolean).map((n) => [n, process.env[n] === undefined ? null : process.env[n]])) });
  process.stdin.on("end", () => { log({ event: "stdin-closed" }); if (mode !== "stubborn") process.exit(0); });
  process.on("exit", () => log({ event: "exit" }));

  if (mode === "early-exit") {
    process.stderr.write("fake-mcp: fatal: the API_KEY variable is not set\n    at loadConfig (server.js:12:9)\n");
    process.exit(Number(process.env.FMCP_EXIT || 3));
  }
  if (mode === "stubborn") {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    log({ event: "child", childPid: child.pid });
    setTimeout(() => process.exit(0), 60000);
    process.stdin.resume();
    return;
  }
  if (mode === "sleep") {
    setTimeout(() => process.exit(0), Number(process.env.FMCP_DELAY_MS || 60000));
    process.stdin.resume();
    return;
  }
  if (mode === "garbage") {
    process.stdout.write("Listening on http://localhost:3000\n");
    process.stdout.write("<!doctype html><html></html>\n");
    process.stdin.resume();
    return;
  }
  if (mode === "banner") process.stdout.write("fake-mcp 1.2.3 starting up\n");

  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const ok = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });
  const tools = toolsFor(mode);

  let buffered = "";
  const handle = (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    log({ event: "message", message: m });
    if (m.id === undefined || m.method === undefined) return; // a notification or a response
    if (mode === "silent") return;
    if (m.method === "initialize") {
      if (mode === "init-error") return fail(m.id, -32603, "cannot start: the database is down");
      const wanted = m.params && m.params.protocolVersion;
      const reply = () => ok(m.id, {
        protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0],
        capabilities: mode === "tools-only" ? { tools: {} } : { tools: { listChanged: false }, resources: {}, prompts: {} },
        serverInfo: { name, version: SERVER_VERSION },
        ...(mode === "tools-only" ? {} : { instructions: INSTRUCTIONS }),
      });
      if (mode === "slow") setTimeout(reply, Number(process.env.FMCP_DELAY_MS || 1500)); else reply();
      return;
    }
    if (m.method === "ping") return ok(m.id, {});
    if (m.method === "tools/list") {
      if (mode === "paged") {
        const cursor = m.params && m.params.cursor;
        return cursor === "p2" ? ok(m.id, { tools: tools.slice(2) }) : ok(m.id, { tools: tools.slice(0, 2), nextCursor: "p2" });
      }
      return ok(m.id, { tools });
    }
    if (m.method === "resources/list" && mode !== "tools-only") return ok(m.id, { resources: RESOURCES });
    if (m.method === "prompts/list" && mode !== "tools-only") return ok(m.id, { prompts: PROMPTS });
    if (m.method === "tools/call") {
      const args = (m.params && m.params.arguments) || {};
      const text = m.params && m.params.name === "add" ? String(Number(args.a) + Number(args.b)) : String(args.text === undefined ? "" : args.text);
      return ok(m.id, { content: [{ type: "text", text }] });
    }
    return fail(m.id, -32601, `Method not found: ${m.method}`);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, at).replace(/\r$/, "");
      buffered = buffered.slice(at + 1);
      if (line.trim()) handle(line);
    }
  });
}

if (process.argv[2] === "serve") serve();
