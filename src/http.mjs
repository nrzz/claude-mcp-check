// Probes a remote MCP server (HTTP, with the answer as JSON or as an event stream; SSE; WebSocket is not probed) at the URL
// the user configured, and says whether it answers and whether it wants a login, from the status code. This is the one place
// that opens a connection. It reads no token: it sends no Authorization header of its own and never reads Claude Code's stored
// credentials; the headers of the configuration are sent only when the caller asks (`check --send-headers`), and no header
// or URL secret is ever put in a result.
import http from "node:http";
import https from "node:https";
import { redactUrl } from "./redact.mjs";
import { PROTOCOL_VERSION, initializeParams } from "./protocol.mjs";
import { VERSION } from "./version.mjs";

const MAX_BODY = 4 * 1024 * 1024;

function errorOutcome(e) {
  const code = e && e.code ? String(e.code) : "";
  if (code === "ECONNREFUSED") return { outcome: "unreachable", detail: "the connection was refused (nothing listens at that address and port)" };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { outcome: "unreachable", detail: "the host name does not resolve" };
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return { outcome: "unreachable", detail: `the host cannot be reached (${code})` };
  if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") return { outcome: "unreachable", detail: "the connection was closed by the server or something in between" };
  if (/CERT|SSL|TLS|ERR_TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /certificate|self.signed|TLS|SSL/i.test(String(e && e.message))) return { outcome: "tls", detail: `the TLS handshake failed (${code || "certificate"})` };
  return { outcome: "unreachable", detail: `the request failed (${code || String(e && e.message).slice(0, 80)})` };
}

/** One request. Resolves { status, headers, body } or { error } or { timeout }; never rejects. For an event stream, `until(text)` may end the read early. */
function request(url, { method, headers, body, timeoutMs, until }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const lib = url.protocol === "https:" ? https : http;
    let req;
    const timer = setTimeout(() => { try { req && req.destroy(); } catch { /* gone */ } finish({ timeout: true }); }, timeoutMs);
    try {
      req = lib.request(url, { method, headers, agent: false }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > MAX_BODY) { res.destroy(); finish({ status: res.statusCode, headers: res.headers, body: text.slice(0, MAX_BODY), truncated: true }); return; }
          if (until && until(text)) { res.destroy(); finish({ status: res.statusCode, headers: res.headers, body: text }); }
        });
        res.on("end", () => finish({ status: res.statusCode, headers: res.headers, body: text }));
        res.on("error", (e) => finish(settled ? undefined : { status: res.statusCode, headers: res.headers, body: text, error: e }));
        res.on("close", () => finish({ status: res.statusCode, headers: res.headers, body: text }));
      });
      req.on("error", (e) => finish({ error: e }));
      if (body !== undefined) req.write(body);
      req.end();
    } catch (e) { finish({ error: e }); }
  });
}

/** The JSON-RPC message with this id in a response body (a JSON document or an event stream), or null. */
function messageIn(body, contentType, id) {
  const text = String(body || "");
  const candidates = [];
  if (/text\/event-stream/i.test(contentType || "")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (data) candidates.push(data);
    }
  } else candidates.push(text);
  for (const c of candidates) {
    try {
      const m = JSON.parse(c);
      const items = Array.isArray(m) ? m : [m];
      const hit = items.find((x) => x && typeof x === "object" && x.id === id && (x.result !== undefined || x.error !== undefined));
      if (hit) return hit;
    } catch { /* not JSON */ }
  }
  return null;
}

const statusOutcome = (status, headers) => {
  if (status === 401 || status === 403) return { outcome: "needs-login", detail: `HTTP ${status}: the server wants credentials${headers && headers["www-authenticate"] ? " (it sent a WWW-Authenticate header)" : ""}` };
  if (status === 404) return { outcome: "not-found", detail: "HTTP 404: no MCP endpoint at that path" };
  if (status === 400 || status === 405 || status === 406 || status === 415) return { outcome: "wrong-transport", detail: `HTTP ${status}: the endpoint does not take the MCP request the way this transport sends it (check the type: http or sse)` };
  if (status >= 500) return { outcome: "server-error", detail: `HTTP ${status}: the server failed` };
  if (status >= 300 && status < 400) return { outcome: "redirect", detail: `HTTP ${status}: the server redirects${headers && headers.location ? ` to ${redactUrl(String(headers.location)).replace(/\?.*$/, "")}` : ""}` };
  return { outcome: "not-mcp", detail: `HTTP ${status}: not an MCP answer` };
};

/**
 * Probes a remote server.
 *   view          the expanded definition (launch.expandedView): type, url, headers
 *   sendHeaders   send the headers of the configuration too (never headersHelper, which would run a program)
 * Returns { type, url, headerNames, sentHeaders, status, outcome, detail, ms, initialize, tools, resources, prompts, note }.
 */
export async function probeHttp(view, { timeoutMs = 30000, sendHeaders = false } = {}) {
  const t0 = Date.now();
  const res = { type: view.type, url: view.url === undefined ? null : redactUrl(view.url), headerNames: Object.keys(view.headers || {}), sentHeaders: false, status: null, outcome: null, detail: "", ms: 0, initialize: null, tools: null, resources: null, prompts: null, note: null };
  const done = () => { res.ms = Date.now() - t0; return res; };
  if (view.type === "ws") { res.outcome = "unsupported"; res.detail = "WebSocket servers are not probed"; return done(); }
  if (!view.url) { res.outcome = "empty-url"; res.detail = "the server has no url: Claude Code does not try to connect"; return done(); }
  if (view.refs && view.refs.missing.some((m) => m.field === "url")) { res.outcome = "invalid-url"; res.detail = `the url still holds \${${view.refs.missing.find((m) => m.field === "url").name}}, which is not set`; return done(); }
  let url;
  try { url = new URL(view.url); } catch { res.outcome = "invalid-url"; res.detail = "the url cannot be parsed"; return done(); }
  if (url.protocol !== "http:" && url.protocol !== "https:") { res.outcome = "invalid-url"; res.detail = `the url starts with ${url.protocol} and not http: or https:`; return done(); }

  const base = { "User-Agent": `claude-mcp-check/${VERSION}` };
  const extra = {};
  if (sendHeaders) { for (const [k, v] of Object.entries(view.headers || {})) extra[k] = v; res.sentHeaders = res.headerNames.length > 0; }
  else if (res.headerNames.length) res.note = `the configuration sets ${res.headerNames.length === 1 ? "a header" : "headers"} (${res.headerNames.join(", ")}) that this probe did not send; use --send-headers to send them`;

  if (view.type === "sse") {
    const r = await request(url, { method: "GET", headers: { ...base, ...extra, Accept: "text/event-stream" }, timeoutMs, until: (t) => /(^|\n)event: ?endpoint/.test(t) });
    if (r.timeout) { res.outcome = "timeout"; res.detail = `no answer within ${timeoutMs} ms`; return done(); }
    if (r.error && r.status === undefined) { Object.assign(res, errorOutcome(r.error)); return done(); }
    res.status = r.status;
    const ct = String(r.headers["content-type"] || "");
    if (r.status === 200 && /text\/event-stream/i.test(ct)) {
      res.outcome = "ok";
      res.detail = /(^|\n)event: ?endpoint/.test(r.body || "") ? "HTTP 200: an event stream that announced its endpoint (the SSE handshake was not completed)" : "HTTP 200: an event stream (the SSE handshake was not completed)";
      return done();
    }
    if (r.status === 200) { res.outcome = "not-mcp"; res.detail = `HTTP 200, but the content type is ${ct || "missing"} and not text/event-stream`; return done(); }
    Object.assign(res, statusOutcome(r.status, r.headers));
    return done();
  }

  // Streamable HTTP
  let session;
  let protocol = PROTOCOL_VERSION;
  const post = (message, ms, expectId) => request(url, {
    method: "POST", timeoutMs: ms,
    headers: { ...base, ...extra, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}), ...(message.method !== "initialize" ? { "MCP-Protocol-Version": protocol } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    until: expectId === undefined ? undefined : (text) => messageIn(text, "text/event-stream", expectId) !== null,
  });
  const first = await post({ id: 0, method: "initialize", params: initializeParams() }, timeoutMs, 0);
  if (first.timeout) { res.outcome = "timeout"; res.detail = `no answer within ${timeoutMs} ms`; return done(); }
  if (first.error && first.status === undefined) { Object.assign(res, errorOutcome(first.error)); return done(); }
  res.status = first.status;
  if (first.status !== 200) { Object.assign(res, statusOutcome(first.status, first.headers)); return done(); }
  const msg = messageIn(first.body, first.headers["content-type"], 0);
  if (!msg) { res.outcome = "not-mcp"; res.detail = "HTTP 200, but the body is not a JSON-RPC answer to initialize"; return done(); }
  if (msg.error) { res.outcome = "handshake-error"; res.detail = `the server answered initialize with an error (${msg.error.code}: ${String(msg.error.message || "").slice(0, 120)})`; res.initialize = { ok: false, ms: Date.now() - t0, error: { code: msg.error.code, message: String(msg.error.message || "").slice(0, 200) } }; return done(); }
  const r = msg.result && typeof msg.result === "object" ? msg.result : {};
  const caps = r.capabilities && typeof r.capabilities === "object" ? r.capabilities : {};
  protocol = typeof r.protocolVersion === "string" ? r.protocolVersion : protocol;
  session = first.headers["mcp-session-id"] ? String(first.headers["mcp-session-id"]) : undefined;
  res.initialize = { ok: true, ms: Date.now() - t0, protocolVersion: typeof r.protocolVersion === "string" ? r.protocolVersion : null, serverInfo: r.serverInfo && typeof r.serverInfo === "object" ? { name: String(r.serverInfo.name || ""), version: String(r.serverInfo.version || "") } : null, capabilities: Object.keys(caps), instructions: typeof r.instructions === "string" ? r.instructions : "" };
  res.outcome = "ok";
  res.detail = "HTTP 200: answered initialize";
  await post({ method: "notifications/initialized" }, Math.min(timeoutMs, 10000));
  const list = async (method, key) => {
    const items = [];
    let cursor;
    const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const id = 10 + page;
      const a = await post({ id, method, ...(cursor === undefined ? {} : { params: { cursor } }) }, Math.min(timeoutMs, 10000), id);
      if (a.timeout) return { ok: false, timeout: true, items };
      if (a.error && a.status === undefined) return { ok: false, error: { message: errorOutcome(a.error).detail }, items };
      if (a.status !== 200) return { ok: false, error: { message: `HTTP ${a.status}` }, items };
      const m = messageIn(a.body, a.headers["content-type"], id);
      if (!m) return { ok: false, error: { message: "no JSON-RPC answer" }, items };
      if (m.error) return { ok: false, error: { code: m.error.code, message: String(m.error.message || "").slice(0, 200) }, items };
      items.push(...(m.result && Array.isArray(m.result[key]) ? m.result[key] : []));
      cursor = m.result && typeof m.result.nextCursor === "string" && m.result.nextCursor ? m.result.nextCursor : undefined;
      if (cursor === undefined || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return { ok: true, items };
  };
  const wants = (key) => (r.capabilities === undefined ? key === "tools" : caps[key] !== undefined && caps[key] !== null);
  const [tools, resources, prompts] = await Promise.all([wants("tools") ? list("tools/list", "tools") : null, wants("resources") ? list("resources/list", "resources") : null, wants("prompts") ? list("prompts/list", "prompts") : null]);
  res.tools = tools;
  res.resources = resources;
  res.prompts = prompts;
  if (session) await request(url, { method: "DELETE", headers: { ...base, ...extra, "Mcp-Session-Id": session, "MCP-Protocol-Version": protocol }, timeoutMs: 2000 });
  return done();
}
