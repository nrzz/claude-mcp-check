// allowedMcpServers and deniedMcpServers: which servers the lists let Claude Code load. Put to the real binary with
// serverName, serverCommand and serverUrl entries in the user, project and local settings files (README, "What was
// verified"); the managed-only lock (allowManagedMcpServersOnly) is read from the documentation and was not tried.
//
// A server that a list blocks is not listed by `claude mcp list` and `claude mcp get`, and its tools are not sent: it
// vanishes. The list applies to the definition Claude Code picked, and then the name is gone: no other scope takes over.
import { isObject } from "./jsonfile.mjs";
import { expandString } from "./expand.mjs";

/** Entries of one list: { entries: [{ key, value, raw }], bad: [raw] }. An entry is an object with one of the three keys. */
export function parseList(list) {
  const entries = [];
  const bad = [];
  if (!Array.isArray(list)) return { entries, bad, notArray: list !== undefined };
  for (const raw of list) {
    if (isObject(raw) && typeof raw.serverName === "string" && raw.serverName !== "" && raw.serverName.trim() === raw.serverName) entries.push({ key: "serverName", value: raw.serverName, raw });
    else if (isObject(raw) && Array.isArray(raw.serverCommand) && raw.serverCommand.length > 0 && raw.serverCommand.every((s) => typeof s === "string")) entries.push({ key: "serverCommand", value: raw.serverCommand, raw });
    else if (isObject(raw) && typeof raw.serverUrl === "string" && raw.serverUrl !== "") entries.push({ key: "serverUrl", value: raw.serverUrl, raw });
    else bad.push(raw);
  }
  return { entries, bad, notArray: false };
}

function parseUrlLike(text) {
  const m = /^([^:/]*):\/\/([^/?#]*)([^]*)$/.exec(text);
  if (!m) return null;
  const [, scheme, authority, rest] = m;
  const at = authority.lastIndexOf("@");
  const hostport = at >= 0 ? authority.slice(at + 1) : authority;
  const pm = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(hostport);
  return { scheme: scheme.toLowerCase(), host: (pm[1] || "").toLowerCase().replace(/\.$/, ""), port: pm[2], rest };
}

const DEFAULT_PORT = { http: "80", https: "443", ws: "80", wss: "443" };
const wildcard = (pattern, flags = "") => new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, flags);

/** Does a serverUrl pattern match a URL? Wildcards, case-insensitive host, a path that is case sensitive; see the README. */
export function urlMatches(pattern, url) {
  const p = parseUrlLike(pattern);
  const u = parseUrlLike(url);
  if (!p || !u) return false;
  if (!wildcard(p.scheme, "i").test(u.scheme)) return false;
  if (!wildcard(p.host, "i").test(u.host)) return false;
  const uPort = u.port === undefined || u.port === "" ? DEFAULT_PORT[u.scheme] : u.port;
  if (p.port !== undefined && p.port !== "") {
    if (!wildcard(p.port).test(String(uPort))) return false;
  } else if (!p.host.includes("*")) {
    // no port written and the host written out in full: the default port of the scheme only
    const want = p.scheme === "*" ? DEFAULT_PORT[u.scheme] : DEFAULT_PORT[p.scheme];
    if (String(uPort) !== String(want)) return false;
  }
  const pRest = p.rest === "" ? "/*" : p.rest;
  return wildcard(pRest).test(u.rest === "" ? "/" : u.rest);
}

const sameCommand = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function entryMatches(entry, server, expandOpts) {
  if (entry.key === "serverName") return server.name === entry.value;
  if (entry.key === "serverCommand") {
    if (server.type !== "stdio" || !server.command) return false;
    const want = entry.value.map((s) => expandString(s, expandOpts).text);
    return sameCommand(want, [server.command, ...server.args]);
  }
  if (entry.key === "serverUrl") {
    if (server.type === "stdio" || !server.url) return false;
    return urlMatches(expandString(entry.value, expandOpts).text, server.url);
  }
  return false;
}

/**
 * Evaluates the lists for one server.
 *   lists   { allowed: [{ entry, file }], denied: [{ entry, file }], allowDefined: bool }
 *   server  { name, type, command, args, url } with the command, arguments and url already expanded
 * Returns { blocked, by } where by names the list, the entry and its file.
 */
export function evaluatePolicy(lists, server, expandOpts = {}) {
  for (const d of lists.denied) {
    if (entryMatches(d.entry, server, expandOpts)) return { blocked: true, by: { list: "deniedMcpServers", entry: d.entry.raw, file: d.file } };
  }
  if (!lists.allowDefined) return { blocked: false, by: null };
  const entries = lists.allowed.map((a) => a.entry);
  const remote = server.type !== "stdio";
  const need = remote ? "serverUrl" : "serverCommand";
  const hasNeed = entries.some((e) => e.key === need);
  for (const a of lists.allowed) {
    const e = a.entry;
    if (e.key === need && entryMatches(e, server, expandOpts)) return { blocked: false, by: { list: "allowedMcpServers", entry: e.raw, file: a.file } };
    if (e.key === "serverName" && !hasNeed && entryMatches(e, server, expandOpts)) return { blocked: false, by: { list: "allowedMcpServers", entry: e.raw, file: a.file } };
  }
  return { blocked: true, by: { list: "allowedMcpServers", entry: null, file: lists.allowed[0] ? lists.allowed[0].file : null } };
}
