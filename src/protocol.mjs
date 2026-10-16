// The handshake this tool performs, from the MCP specification (modelcontextprotocol.io/specification): `initialize` with a
// protocolVersion, capabilities and clientInfo, then the `notifications/initialized` notification, then tools/list,
// resources/list and prompts/list. JSON-RPC 2.0; over stdio one message per line, over HTTP a POST of the same message.
// The tool offers no client capabilities, so a server has nothing to ask of it. Claude Code 2.1.299 sent protocolVersion
// 2025-11-25 and capabilities roots and elicitation; it also sent a server/discover request first (protocol 2026-07-28),
// which this tool does not.
import { VERSION } from "./version.mjs";

export const PROTOCOL_VERSION = "2025-11-25";

export const initializeParams = () => ({ protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "claude-mcp-check", version: VERSION } });
