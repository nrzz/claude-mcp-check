// Which server entries are skipped, and the words for it: src/validate.mjs held to the table that the real binary was held to.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { validateEntry } from "../src/validate.mjs";
import { ROWS } from "./validation-table.mjs";

test("every row of the table: skipped or not, and the message", () => {
  for (const [name, entry, message] of ROWS) {
    const v = validateEntry(name, entry);
    assert.equal(v.ok, message === null, `${name}: ${JSON.stringify(v)}`);
    if (message !== null) assert.equal(v.message, message, name);
  }
  assert.ok(ROWS.length >= 35);
});

test("the type: absent means stdio, streamable-http is http, and an entry with a url and no type is skipped", () => {
  assert.equal(validateEntry("a", { command: "x" }).type, "stdio");
  assert.equal(validateEntry("a", { type: "streamable-http", url: "https://x/mcp" }).type, "http");
  assert.equal(validateEntry("a", { type: "sse", url: "https://x/sse" }).type, "sse");
  assert.equal(validateEntry("a", { type: "ws", url: "wss://x" }).type, "ws");
  assert.equal(validateEntry("a", { url: "https://x" }).ok, false);
  assert.equal(validateEntry("a", { url: "https://x", command: "node" }).ok, true, "a command wins over a url");
});

test("a message names every problem of the entry, joined by a semicolon", () => {
  const v = validateEntry("x", { command: "node", args: [1], env: { A: 2 } });
  assert.deepEqual(v.problems, ["args.0: expected string, received number", "env.A: expected string, received number"]);
});
