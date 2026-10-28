// What a server's tools cost in the model's context, measured the way the request of Claude Code carries them: each tool is
// { name: "mcp__<server>__<tool>", description, input_schema }, and a description longer than 4,096 characters is cut to its first
// 4,096 characters plus "… [truncated]" (Claude Code 2.1.296 and newer; 2,048 before). The tokens are the characters divided by
// four: an estimate, not a count by Claude's tokenizer. Claude Code defers these schemas behind its tool search (the default, see
// toolsearch.mjs): then the request carries only the names, one to a line, and a schema is added when the model loads the tool,
// and a description over the limit is not cut. With the schemas up front they are cut at the limit. `chars` is the size up front,
// `loadedChars` the size when the model loads the tool, `nameChars` what the list of names costs (each name and a line feed).
import { MAX_TOOL_NAME, toolNameFor } from "./names.mjs";

/**
 * A server that offers resources makes Claude Code send three tools of its own as well (put to Claude Code 2.1.299: they were in the
 * first request with a server that offered resources, and not with one that offered tools only). 628 + 875 + 577 characters there,
 * and the same on 2.1.303 and 2.1.310. With tool search they are three more names in the list and their schemas are loaded on demand.
 */
const RESOURCE_TOOL_NAMES = ["ListMcpResourcesTool", "ReadMcpResourceDirTool", "ReadMcpResourceTool"];
export const RESOURCE_TOOLS = { names: RESOURCE_TOOL_NAMES, chars: 2080, nameChars: RESOURCE_TOOL_NAMES.reduce((n, x) => n + x.length + 1, 0), measuredOn: "2.1.299" };

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
 * Returns { count, sent, leftOut, chars, tokens, cut, loadedChars, loadedTokens, nameChars, nameTokens,
 * tools: [{ name, chars, tokens, cut, loadedChars }] } where leftOut are the tools whose full name is over 128 characters (Claude Code
 * does not send them, nor list them) and the sizes cover the ones that are sent.
 */
export function measureTools(server, tools, { limit = DESCRIPTION_LIMIT } = {}) {
  const rows = [];
  const leftOut = [];
  for (const tool of tools || []) {
    if (!tool || typeof tool.name !== "string") continue;
    const sent = sentTool(server, tool, limit);
    if (sent.name.length > MAX_TOOL_NAME) { leftOut.push({ name: tool.name, sentName: sent.name, length: sent.name.length }); continue; }
    const chars = JSON.stringify({ name: sent.name, description: sent.description, input_schema: sent.input_schema }).length;
    // loaded through tool search the description is whole (put to 2.1.295 to 2.1.312: 6,000 characters in, 6,000 out)
    const whole = sentTool(server, tool, Infinity);
    const loadedChars = JSON.stringify({ name: whole.name, description: whole.description, input_schema: whole.input_schema }).length;
    rows.push({ name: sent.name, tool: tool.name, chars, tokens: tokensOf(chars), cut: sent.cut, loadedChars });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chars = rows.reduce((n, r) => n + r.chars, 0);
  const loadedChars = rows.reduce((n, r) => n + r.loadedChars, 0);
  const nameChars = rows.reduce((n, r) => n + r.name.length + 1, 0);
  return { count: (tools || []).length, sent: rows.length, leftOut, chars, tokens: tokensOf(chars), cut: rows.filter((r) => r.cut).length, loadedChars, loadedTokens: tokensOf(loadedChars), nameChars, nameTokens: tokensOf(nameChars), tools: rows };
}

/** The server's instructions as the system prompt carries them (cut at the same limit). */
export function measureInstructions(text, { limit = DESCRIPTION_LIMIT } = {}) {
  if (typeof text !== "string" || text === "") return { chars: 0, tokens: 0, cut: false };
  const cut = text.length > limit;
  const chars = cut ? limit + TRUNCATION.length : text.length;
  return { chars, tokens: tokensOf(chars), cut };
}
