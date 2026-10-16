// Probing a remote server at the URL that was configured: the handshake over HTTP (JSON and event-stream answers), the
// status codes, the headers that are sent only on request, and nothing secret in a result.
import "./helpers.mjs";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { probeHttp } from "../src/http.mjs";

const TOOLS = [{ name: "ping", description: "Ping.", inputSchema: { type: "object", properties: {} } }, { name: "pong", description: "Pong.", inputSchema: { type: "object" } }];

/** A server on 127.0.0.1 that records what it gets. Routes decide the answer. */
async function serve(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let m = null;
      try { m = JSON.parse(body); } catch { /* none */ }
      seen.push({ method: req.method, url: req.url, headers: req.headers, rpc: m });
      handler(req, res, m);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const json = (res, code, obj, h = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(obj)); };
const result = (m) => (m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "http-fake", version: "9" }, instructions: "Be nice." } : m.method === "tools/list" ? { tools: m.params && m.params.cursor ? TOOLS.slice(1) : TOOLS.slice(0, 1), ...(m.params && m.params.cursor ? {} : { nextCursor: "c2" }) } : m.method === "prompts/list" ? { prompts: [{ name: "p" }] } : {});
const view = (url, headers = {}, type = "http") => ({ type, url, headers, refs: { missing: [], empty: [], defaulted: [], readAsEmpty: [] } });

test("an HTTP server that answers with JSON: initialize, the notification, the lists with pages, and the session", async () => {
  const s = await serve((req, res, m) => {
    if (!m) return json(res, 400, {});
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    return json(res, 200, { jsonrpc: "2.0", id: m.id, result: result(m) }, { "mcp-session-id": "sess-1" });
  });
  try {
    const r = await probeHttp(view(`${s.base}/mcp`), { timeoutMs: 5000 });
    assert.equal(r.outcome, "ok");
    assert.equal(r.initialize.ok, true);
    assert.deepEqual(r.initialize.serverInfo, { name: "http-fake", version: "9" });
    assert.equal(r.initialize.instructions, "Be nice.");
    assert.deepEqual(r.tools.items.map((t) => t.name), ["ping", "pong"]);
    assert.equal(r.prompts.items.length, 1);
    assert.equal(r.resources, null);
    const posts = s.seen.filter((x) => x.method === "POST");
    assert.equal(posts[0].rpc.method, "initialize");
    assert.equal(posts[0].headers.accept, "application/json, text/event-stream");
    assert.match(posts[0].headers["user-agent"], /^claude-mcp-check\//);
    assert.equal(posts[0].headers["mcp-session-id"], undefined);
    assert.ok(posts.slice(1).every((x) => x.headers["mcp-session-id"] === "sess-1"), "the session id is sent back");
    assert.ok(posts.slice(1).every((x) => x.headers["mcp-protocol-version"] === "2025-06-18"), "and the version it negotiated");
    assert.ok(s.seen.some((x) => x.method === "DELETE"), "the session is ended");
  } finally { await s.close(); }
});

test("an answer as an event stream", async () => {
  const s = await serve((req, res, m) => {
    if (!m) return json(res, 400, {});
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: result(m) })}\n\n`);
    // the stream stays open after the answer, as some servers keep it
    setTimeout(() => res.end(), 3000);
  });
  try {
    const t0 = Date.now();
    const r = await probeHttp(view(`${s.base}/mcp`), { timeoutMs: 5000 });
    assert.equal(r.outcome, "ok");
    assert.equal(r.tools.items.length, 2);
    assert.ok(Date.now() - t0 < 2900, "it did not wait for the stream to end");
  } finally { await s.close(); }
});

test("the status codes: 401 and 403 want a login, 404 is the wrong path, 405 the wrong transport, 500 a failing server", async () => {
  const s = await serve((req, res) => {
    const code = Number(req.url.slice(1));
    res.writeHead(code, code === 401 ? { "www-authenticate": 'Bearer realm="x"' } : {});
    res.end("body that is not read");
  });
  try {
    const want = { 401: "needs-login", 403: "needs-login", 404: "not-found", 405: "wrong-transport", 406: "wrong-transport", 500: "server-error", 502: "server-error", 302: "redirect" };
    for (const [code, outcome] of Object.entries(want)) {
      const r = await probeHttp(view(`${s.base}/${code}`), { timeoutMs: 5000 });
      assert.equal(r.status, Number(code));
      assert.equal(r.outcome, outcome, code);
    }
    assert.match((await probeHttp(view(`${s.base}/401`), { timeoutMs: 5000 })).detail, /WWW-Authenticate/);
  } finally { await s.close(); }
});

test("nothing listens, the name does not resolve, the answer is not MCP, the answer takes too long", async () => {
  const refused = await probeHttp(view("http://127.0.0.1:1/mcp"), { timeoutMs: 3000 });
  assert.equal(refused.outcome, "unreachable");
  assert.match(refused.detail, /refused/);
  const nx = await probeHttp(view("http://no-such-host.invalid/mcp"), { timeoutMs: 5000 });
  assert.equal(nx.outcome, "unreachable");
  const s = await serve((req, res, m) => {
    if (req.url === "/html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html></html>"); }
    if (req.url === "/error") return json(res, 200, { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "no" } });
    return undefined; // /slow: never answers
  });
  try {
    assert.equal((await probeHttp(view(`${s.base}/html`), { timeoutMs: 3000 })).outcome, "not-mcp");
    const e = await probeHttp(view(`${s.base}/error`), { timeoutMs: 3000 });
    assert.equal(e.outcome, "handshake-error");
    assert.equal(e.initialize.error.code, -32000);
    const t0 = Date.now();
    const slow = await probeHttp(view(`${s.base}/slow`), { timeoutMs: 400 });
    assert.equal(slow.outcome, "timeout");
    assert.ok(Date.now() - t0 < 2000);
  } finally { await s.close(); }
});

test("the headers of the configuration are not sent unless asked, and their values are in no result", async () => {
  const s = await serve((req, res) => json(res, 401, {}));
  try {
    const v = view(`${s.base}/mcp?token=abc123`, { Authorization: "Bearer super-secret-value", "X-Api": "another-secret" });
    const plain = await probeHttp(v, { timeoutMs: 3000 });
    assert.equal(s.seen[0].headers.authorization, undefined);
    assert.equal(s.seen[0].headers["x-api"], undefined);
    assert.equal(plain.sentHeaders, false);
    assert.deepEqual(plain.headerNames, ["Authorization", "X-Api"]);
    assert.match(plain.note, /Authorization, X-Api/);
    const sent = await probeHttp(v, { timeoutMs: 3000, sendHeaders: true });
    assert.equal(s.seen[1].headers.authorization, "Bearer super-secret-value");
    assert.equal(sent.sentHeaders, true);
    for (const r of [plain, sent]) {
      const text = JSON.stringify(r);
      assert.ok(!text.includes("super-secret-value") && !text.includes("another-secret") && !text.includes("abc123"), "no secret in the result");
      assert.match(r.url, /token=\*\*\*/);
    }
  } finally { await s.close(); }
});

test("an SSE server: an event stream that names its endpoint; a URL that is not one", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages?session=1\n\n");
      setTimeout(() => res.end(), 3000);
      return;
    }
    if (req.url === "/json") return json(res, 200, {});
    res.writeHead(405); return res.end();
  });
  try {
    const ok = await probeHttp(view(`${s.base}/sse`, {}, "sse"), { timeoutMs: 5000 });
    assert.equal(ok.outcome, "ok");
    assert.match(ok.detail, /announced its endpoint/);
    assert.equal(ok.initialize, null, "the SSE handshake is not performed");
    assert.equal((await probeHttp(view(`${s.base}/json`, {}, "sse"), { timeoutMs: 3000 })).outcome, "not-mcp");
    assert.equal((await probeHttp(view(`${s.base}/405`, {}, "sse"), { timeoutMs: 3000 })).outcome, "wrong-transport");
  } finally { await s.close(); }
});

test("WebSocket servers, an empty url and a url that still holds a variable are not probed", async () => {
  assert.equal((await probeHttp(view("wss://x.invalid/ws", {}, "ws"))).outcome, "unsupported");
  assert.equal((await probeHttp(view(""))).outcome, "empty-url");
  const v = view("https://${HOST}/mcp");
  v.refs.missing = [{ name: "HOST", field: "url" }];
  const r = await probeHttp(v);
  assert.equal(r.outcome, "invalid-url");
  assert.match(r.detail, /HOST/);
  assert.equal((await probeHttp(view("not a url"))).outcome, "invalid-url");
  assert.equal((await probeHttp(view("ftp://x/mcp"))).outcome, "invalid-url");
});
