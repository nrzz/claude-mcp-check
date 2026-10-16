// Reading a JSON file the way Claude Code does: strict JSON (a comment or a trailing comma makes it invalid), a byte-order
// mark is fine, an empty file is nothing. Nothing here writes.
import fs from "node:fs";

/** The 1-based line and column of an offset in a text. */
export function positionAt(text, offset) {
  let line = 1;
  let last = -1;
  const end = Math.min(Math.max(offset, 0), text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) { line++; last = i; }
  return { line, column: end - last };
}

/** The offset that a JSON.parse error names, or null (Node 18: "at position 12"; Node 20 and newer add the line and column). */
function errorOffset(message, text) {
  const m = /position (\d+)/.exec(message);
  if (m) return Number(m[1]);
  if (/end of JSON input/i.test(message)) return text.length;
  return null;
}

/** Parses text; returns { data } or { error: { message, line, column } }. */
export function parseJson(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return { data: JSON.parse(body) };
  } catch (e) {
    const message = String(e && e.message ? e.message : e).replace(/\s+/g, " ").slice(0, 160);
    const off = errorOffset(message, body);
    const pos = off === null ? { line: 1, column: 1 } : positionAt(body, off);
    return { error: { message, line: pos.line, column: pos.column } };
  }
}

/**
 * Reads a file. Returns { path, exists, text, empty, data, error }:
 *   exists  false when there is no such file
 *   empty   true for a file of nothing but white space (Claude Code reads it as no configuration)
 *   data    the parsed value, when the text is valid JSON
 *   error   a string for a file that cannot be read, or { message, line, column } for text that is not valid JSON
 */
export function readJsonFile(file) {
  const out = { path: file, exists: false, text: undefined, empty: false, data: undefined, error: null };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return out;
    out.exists = true;
    out.error = `cannot be read (${e.code || e.message})`;
    return out;
  }
  out.exists = true;
  out.text = text;
  if (text.replace(/^﻿/, "").trim() === "") { out.empty = true; return out; }
  const parsed = parseJson(text);
  if (parsed.error) out.error = parsed.error; else out.data = parsed.data;
  return out;
}

export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const describeType = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "undefined" ? "undefined" : typeof v);
