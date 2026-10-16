// What a server's tools cost in the model's context, measured the way the request of Claude Code carries them: each tool is
// { name: "mcp__<server>__<tool>", description, input_schema }, and a description longer than 4,096 characters is cut to its first
// 4,096 characters plus "… [truncated]" (Claude Code 2.1.296 and newer; 2,048 before). The tokens are the characters divided by
// four: an estimate, not a count by Claude's tokenizer. The tool search that Claude Code uses by default on its own API host
// defers these schemas until the model asks for a tool; the figures are what is sent when they are loaded up front.
import { MAX_TOOL_NAME, toolNameFor } from "./names.mjs";

/**
 * A server that offers resources makes Claude Code send three tools of its own as well (put to Claude Code 2.1.299: they were in the
 * first request with a server that offered resources, and not with one that offered tools only). 628 + 875 + 577 characters there.
 */
export const RESOURCE_TOOLS = { names: ["ListMcpResourcesTool", "ReadMcpResourceDirTool", "ReadMcpResourceTool"], chars: 2080, measuredOn: "2.1.299" };

export const DESCRIPTION_LIMIT = 4096;
export const TRUNCATION = "… [truncated]";

/** The characters of text, and the estimate of its tokens (characters / 4, rounded). */
export const tokensOf = (chars) => Math.round(chars / 4);

/** The tool as the request carries it. */
export function sentTool(server, tool, limit = DESCRIPTION_LIMIT) {
  const description = typeof tool.description === "string" ? tool.description : "";
  const cut = description.length > limit;
  return {
    cut,
    name: toolNameFor(server, tool.name),
    description: cut ? `${description.slice(0, limit)}${TRUNCATION}` : description,
    input_schema: tool.inputSchema === undefined ? { type: "object", properties: {} } : tool.inputSchema,
  };
}

/**
 * The size of the tools of one server.
 * Returns { count, sent, leftOut, chars, tokens, cut, tools: [{ name, chars, tokens, cut }] } where leftOut are the tools whose
 * full name is over 128 characters (Claude Code does not send them) and chars/tokens cover the ones that are sent.
 */
export function measureTools(server, tools, { limit = DESCRIPTION_LIMIT } = {}) {
  const rows = [];
  const leftOut = [];
  for (const tool of tools || []) {
    if (!tool || typeof tool.name !== "string") continue;
    const sent = sentTool(server, tool, limit);
    if (sent.name.length > MAX_TOOL_NAME) { leftOut.push({ name: tool.name, sentName: sent.name, length: sent.name.length }); continue; }
    const chars = JSON.stringify({ name: sent.name, description: sent.description, input_schema: sent.input_schema }).length;
    rows.push({ name: sent.name, tool: tool.name, chars, tokens: tokensOf(chars), cut: sent.cut });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chars = rows.reduce((n, r) => n + r.chars, 0);
  return { count: (tools || []).length, sent: rows.length, leftOut, chars, tokens: tokensOf(chars), cut: rows.filter((r) => r.cut).length, tools: rows };
}

/** The server's instructions as the system prompt carries them (cut at the same limit). */
export function measureInstructions(text, { limit = DESCRIPTION_LIMIT } = {}) {
  if (typeof text !== "string" || text === "") return { chars: 0, tokens: 0, cut: false };
  const cut = text.length > limit;
  const chars = cut ? limit + TRUNCATION.length : text.length;
  return { chars, tokens: tokensOf(chars), cut };
}
