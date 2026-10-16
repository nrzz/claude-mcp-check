// Nothing the tool prints may be a secret: the redaction of arguments, URLs and free text.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { hideDefaults, MASK, redactArgs, redactCommand, redactText, redactUrl } from "../src/redact.mjs";

test("the value of a flag that names a secret is hidden, in both spellings", () => {
  assert.deepEqual(redactArgs(["--api-key", "abc123", "--port", "8080", "--token=xyz", "--password", "hunter2"]), ["--api-key", MASK, "--port", "8080", `--token=${MASK}`, "--password", MASK]);
  assert.deepEqual(redactArgs(["-y", "@scope/server", "--region", "eu"]), ["-y", "@scope/server", "--region", "eu"]);
});

test("KEY=value pairs are hidden when the key names a secret", () => {
  assert.deepEqual(redactArgs(["API_TOKEN=abc", "REGION=eu", "db.password=x"]), [`API_TOKEN=${MASK}`, "REGION=eu", `db.password=${MASK}`]);
});

test("text of the shape of a key is hidden wherever it stands", () => {
  const shapes = ["sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123", "xoxb-1234567890-abcdefgh", "AKIAABCDEFGHIJKLMNOP", "github_pat_abcdefghijklmnopqrstuv"];
  for (const s of shapes) assert.deepEqual(redactArgs(["--whatever", s]), ["--whatever", MASK], s);
  assert.deepEqual(redactArgs(["plain-word", "sk-short"]), ["plain-word", "sk-short"]);
});

test("a ${VAR} reference is a name and stays, its default is hidden", () => {
  assert.deepEqual(redactArgs(["--api-key", "${API_KEY}", "--token=${T:-secret-default}"]), ["--api-key", "${API_KEY}", "--token=${T:-…}"]);
  assert.equal(hideDefaults("${A:-x} and ${B}"), "${A:-…} and ${B}");
});

test("a URL loses the password of its user part and the secret-looking query values", () => {
  assert.equal(redactUrl("https://user:pass@example.com/mcp"), `https://user:${MASK}@example.com/mcp`);
  assert.equal(redactUrl("https://example.com/mcp?api_key=abc&region=eu&token=${TOKEN}"), `https://example.com/mcp?api_key=${MASK}&region=eu&token=\${TOKEN}`);
  assert.equal(redactUrl("https://example.com/plain"), "https://example.com/plain");
  assert.equal(redactUrl("${BASE_URL}/mcp"), "${BASE_URL}/mcp");
});

test("a URL given as an argument is redacted like a URL", () => {
  assert.deepEqual(redactArgs(["--url", "https://example.com/mcp?key=abc"]), ["--url", `https://example.com/mcp?key=${MASK}`]);
});

test("a command line in one string is split for the redaction", () => {
  assert.equal(redactCommand("npx -y server --api-key abc"), `npx -y server --api-key ${MASK}`);
  assert.equal(redactCommand("node"), "node");
  assert.equal(redactCommand('"C:/Program Files/node.exe" s.js --token=abc'), `"C:/Program Files/node.exe" s.js --token=${MASK}`);
});

test("free text: bearer tokens, key shapes and token=value", () => {
  assert.equal(redactText("Authorization: Bearer abcdefghijklmnop"), `Authorization: Bearer ${MASK}`);
  assert.equal(redactText("token=abcdef123456 region=eu"), `token=${MASK} region=eu`);
  assert.ok(!redactText("failed with sk-ant-api03-abcdefghijklmnop at 12:00").includes("abcdefghijklmnop"));
  assert.equal(redactText("nothing secret here"), "nothing secret here");
});
