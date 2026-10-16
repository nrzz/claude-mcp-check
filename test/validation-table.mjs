// The server entries that Claude Code skips and the ones it lists, with the words `claude mcp list` prints for a skipped one
// (Claude Code 2.1.299, the same table in .mcp.json and in .claude.json). test/validate.test.mjs holds src/validate.mjs to it and
// test/e2e-claude.test.mjs holds the real binary to it. `node --test` also runs this file; it only exports.
import { SERVER } from "./helpers.mjs";

const ok = { command: process.execPath, args: [SERVER, "serve", "ok"] };

// [name, entry, null when Claude Code lists it, else the text after "Skipped — "]
export const ROWS = [
  ["ok", ok, null],
  ["noCommand", { args: ["a"] }, 'invalid MCP server config for "noCommand": command: expected string, received undefined'],
  ["commandNumber", { command: 5 }, 'invalid MCP server config for "commandNumber": command: expected string, received number'],
  ["commandEmpty", { command: "" }, 'invalid MCP server config for "commandEmpty": command: Command cannot be empty'],
  ["commandNull", { command: null }, 'invalid MCP server config for "commandNull": command: expected string, received null'],
  ["argsString", { command: "node", args: "a b" }, 'invalid MCP server config for "argsString": args: expected array, received string'],
  ["argsNumberItems", { command: "node", args: ["x", 5] }, 'invalid MCP server config for "argsNumberItems": args.1: expected string, received number'],
  ["argsNull", { command: "node", args: null }, 'invalid MCP server config for "argsNull": args: expected array, received null'],
  ["envNumber", { ...ok, env: { A: 1 } }, 'invalid MCP server config for "envNumber": env.A: expected string, received number'],
  ["envNull", { ...ok, env: { A: null } }, 'invalid MCP server config for "envNull": env.A: expected string, received null'],
  ["envArray", { ...ok, env: ["A=1"] }, 'invalid MCP server config for "envArray": env: expected record, received array'],
  ["envString", { ...ok, env: "A=1" }, 'invalid MCP server config for "envString": env: expected record, received string'],
  ["typeStdio", { type: "stdio", ...ok }, null],
  ["typeLocal", { type: "local", ...ok }, 'unknown MCP server type "local" for server "typeLocal"'],
  ["typeUpper", { type: "STDIO", ...ok }, 'unknown MCP server type "STDIO" for server "typeUpper"'],
  ["typeNumber", { type: 5, ...ok }, 'invalid MCP server config for "typeNumber": type: expected "stdio"'],
  ["typeHttpNoUrl", { type: "http" }, 'invalid MCP server config for "typeHttpNoUrl": url: expected string, received undefined'],
  ["typeHttpUrl", { type: "http", url: "https://example.invalid/mcp" }, null],
  ["typeHttpUrlNumber", { type: "http", url: 5 }, 'invalid MCP server config for "typeHttpUrlNumber": url: expected string, received number'],
  ["typeHttpUrlBad", { type: "http", url: "not a url" }, null],
  ["typeHttpEmpty", { type: "http", url: "" }, null],
  ["typeSse", { type: "sse", url: "https://example.invalid/sse" }, null],
  ["typeWs", { type: "ws", url: "wss://example.invalid/ws" }, null],
  ["typeStreamable", { type: "streamable-http", url: "https://example.invalid/mcp" }, null],
  ["typeHttpWithCommand", { type: "http", url: "https://example.invalid/mcp", command: "node" }, null],
  ["typeStdioWithUrl", { type: "stdio", ...ok, url: "https://example.invalid/mcp" }, null],
  ["urlNoType", { url: "https://example.invalid/mcp" }, 'MCP server "urlNoType" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry'],
  ["headersNumber", { type: "http", url: "https://example.invalid/mcp", headers: { A: 1 } }, 'invalid MCP server config for "headersNumber": headers.A: expected string, received number'],
  ["headersArray", { type: "http", url: "https://example.invalid/mcp", headers: ["A: b"] }, 'invalid MCP server config for "headersArray": headers: expected record, received array'],
  ["headersHelperNumber", { type: "http", url: "https://example.invalid/mcp", headersHelper: 5 }, 'invalid MCP server config for "headersHelperNumber": headersHelper: expected string, received number'],
  ["oauthString", { type: "http", url: "https://example.invalid/mcp", oauth: "x" }, 'invalid MCP server config for "oauthString": oauth: expected object, received string'],
  ["timeoutString", { ...ok, timeout: "5" }, 'invalid MCP server config for "timeoutString": timeout: expected number, received string'],
  ["alwaysLoadString", { ...ok, alwaysLoad: "yes" }, 'invalid MCP server config for "alwaysLoadString": alwaysLoad: expected boolean, received string'],
  ["extraKey", { ...ok, banana: 1 }, null],
  ["entryString", "node server.js", 'invalid MCP server config for "entryString": (root): expected object, received string'],
  ["entryNull", null, 'invalid MCP server config for "entryNull": (root): expected object, received null'],
  ["entryArray", [ok], 'invalid MCP server config for "entryArray": (root): expected object, received array'],
  ["entryEmptyObject", {}, 'invalid MCP server config for "entryEmptyObject": command: expected string, received undefined'],
  ["twoProblems", { command: "node", args: "x", env: { A: 1, B: true } }, 'invalid MCP server config for "twoProblems": args: expected array, received string; env.A: expected string, received number; env.B: expected string, received boolean'],
];
