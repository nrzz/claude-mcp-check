// Which server entries Claude Code skips, and what it says about them. Every rule here was put to the real binary with the
// same table in .mcp.json and in .claude.json (README, "What was verified"): the decisions are the binary's, the messages
// follow the wording of `claude mcp list`.
import { describeType, isObject } from "./jsonfile.mjs";

export const TYPES = ["stdio", "http", "sse", "ws"];

const fieldProblem = (path, expected, value) => `${path}: expected ${expected}, received ${describeType(value)}`;

function checkRecord(problems, path, value) {
  if (value === undefined) return;
  if (!isObject(value)) { problems.push(fieldProblem(path, "record", value)); return; }
  for (const [k, v] of Object.entries(value)) if (typeof v !== "string") problems.push(fieldProblem(`${path}.${k}`, "string", v));
}

/**
 * Validates the entry of a server called `name`.
 * Returns { ok, type, problems, message, skipped }: type is stdio, http, sse or ws (http also for "streamable-http");
 * when Claude Code skips the entry, ok is false and message is what `claude mcp list` prints after "Skipped —".
 */
export function validateEntry(name, entry) {
  if (!isObject(entry)) {
    const p = [fieldProblem("(root)", "object", entry)];
    return { ok: false, type: null, problems: p, message: `invalid MCP server config for "${name}": ${p.join("; ")}` };
  }
  let type;
  const t = entry.type;
  if (t === undefined) {
    if (entry.url !== undefined && entry.command === undefined) {
      const message = `MCP server "${name}" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry`;
      return { ok: false, type: null, problems: [message], message };
    }
    type = "stdio";
  } else if (typeof t === "string") {
    if (t === "stdio") type = "stdio";
    else if (t === "http" || t === "streamable-http") type = "http";
    else if (t === "sse" || t === "ws") type = t;
    else {
      const message = `unknown MCP server type "${t}" for server "${name}"`;
      return { ok: false, type: null, problems: [message], message };
    }
  } else {
    const p = ['type: expected "stdio"'];
    return { ok: false, type: null, problems: p, message: `invalid MCP server config for "${name}": ${p.join("; ")}` };
  }

  const problems = [];
  if (type === "stdio") {
    if (typeof entry.command !== "string") problems.push(fieldProblem("command", "string", entry.command));
    else if (entry.command === "") problems.push("command: Command cannot be empty");
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args)) problems.push(fieldProblem("args", "array", entry.args));
      else entry.args.forEach((a, i) => { if (typeof a !== "string") problems.push(fieldProblem(`args.${i}`, "string", a)); });
    }
    checkRecord(problems, "env", entry.env);
  } else {
    if (typeof entry.url !== "string") problems.push(fieldProblem("url", "string", entry.url));
    checkRecord(problems, "headers", entry.headers);
    if (entry.headersHelper !== undefined && typeof entry.headersHelper !== "string") problems.push(fieldProblem("headersHelper", "string", entry.headersHelper));
    if (entry.oauth !== undefined && !isObject(entry.oauth)) problems.push(fieldProblem("oauth", "object", entry.oauth));
  }
  if (entry.timeout !== undefined && typeof entry.timeout !== "number") problems.push(fieldProblem("timeout", "number", entry.timeout));
  if (entry.alwaysLoad !== undefined && typeof entry.alwaysLoad !== "boolean") problems.push(fieldProblem("alwaysLoad", "boolean", entry.alwaysLoad));
  if (problems.length) return { ok: false, type, problems, message: `invalid MCP server config for "${name}": ${problems.join("; ")}` };
  return { ok: true, type, problems: [], message: "" };
}
