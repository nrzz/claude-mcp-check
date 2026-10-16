// Editing a JSON file by its text: nothing but the one list moves, and taking out what was put in gives back the same bytes.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { findMember, insertItem, insertMember, nodeAt, parseDoc, removeItem, removeMember, replaceNode, sameJson, styleOf, valueOf } from "../src/jsonedit.mjs";
import { editNameList } from "../src/toggle.mjs";

const STYLES = [
  ["two spaces, LF", '{\n  "model": "m",\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n'],
  ["four spaces, LF", '{\n    "model": "m",\n    "env": {\n        "A": "1"\n    }\n}\n'],
  ["tabs, LF", '{\n\t"model": "m",\n\t"hooks": {}\n}\n'],
  ["two spaces, CRLF", '{\r\n  "model": "m",\r\n  "x": [1, 2]\r\n}\r\n'],
  ["one line", '{"model":"m","env":{"A":"1"}}'],
  ["one line with spaces", '{ "model": "m", "env": { "A": "1" } }'],
  ["no trailing newline", '{\n  "model": "m"\n}'],
  ["byte-order mark", '\ufeff{\n  "model": "m"\n}\n'],
  ["empty object", "{}\n"],
];

test("adding a name to a list that is not there and taking it out gives back the same bytes", () => {
  for (const [label, text] of STYLES) {
    const added = editNameList(text, [], "disabledMcpjsonServers", "shared", "add");
    assert.ok(added.changed, label);
    assert.deepEqual(JSON.parse(added.text.replace(/^\ufeff/, "")).disabledMcpjsonServers, ["shared"], label);
    const back = editNameList(added.text, [], "disabledMcpjsonServers", "shared", "remove");
    assert.ok(back.changed, label);
    assert.equal(back.text, text, `${label}: the original bytes come back`);
  }
});

test("adding a second name and removing it gives back the same bytes, in every layout", () => {
  for (const [label, base] of STYLES) {
    const one = editNameList(base, [], "enabledMcpjsonServers", "a", "add").text;
    const two = editNameList(one, [], "enabledMcpjsonServers", "b", "add");
    assert.deepEqual(JSON.parse(two.text.replace(/^\ufeff/, "")).enabledMcpjsonServers, ["a", "b"], label);
    const back = editNameList(two.text, [], "enabledMcpjsonServers", "b", "remove");
    assert.equal(back.text, one, label);
    // an add of a name that is there, and a remove of one that is not, change nothing
    assert.equal(editNameList(two.text, [], "enabledMcpjsonServers", "a", "add").changed, false, label);
    assert.equal(editNameList(one, [], "enabledMcpjsonServers", "zzz", "remove").changed, false, label);
  }
});

test("a list one-line in the file stays one line when a name is added", () => {
  const text = '{ "enabledMcpjsonServers": ["a", "b"], "model": "m" }';
  const r = editNameList(text, [], "enabledMcpjsonServers", "c", "add");
  assert.equal(r.text, '{ "enabledMcpjsonServers": ["a", "b", "c"], "model": "m" }');
});

test("a list that holds one name as plain text becomes a list", () => {
  const text = '{\n  "disabledMcpjsonServers": "shared",\n  "model": "m"\n}\n';
  const r = editNameList(text, [], "disabledMcpjsonServers", "other", "add");
  assert.deepEqual(JSON.parse(r.text).disabledMcpjsonServers, ["shared", "other"]);
  assert.equal(JSON.parse(r.text).model, "m");
  const gone = editNameList(text, [], "disabledMcpjsonServers", "shared", "remove");
  assert.deepEqual(JSON.parse(gone.text), { model: "m" });
});

test("a nested list is made, and found again: projects[key].disabledMcpServers", () => {
  const text = '{\n  "numStartups": 3,\n  "projects": {\n    "C:/work/a": {\n      "allowedTools": []\n    }\n  }\n}\n';
  const a = editNameList(text, ["projects", "C:/work/a"], "disabledMcpServers", "x", "add");
  assert.deepEqual(JSON.parse(a.text).projects["C:/work/a"], { allowedTools: [], disabledMcpServers: ["x"] });
  const b = editNameList(text, ["projects", "C:/work/b"], "disabledMcpServers", "x", "add");
  assert.deepEqual(JSON.parse(b.text).projects["C:/work/b"], { disabledMcpServers: ["x"] });
  assert.deepEqual(JSON.parse(b.text).projects["C:/work/a"], { allowedTools: [] });
  const c = editNameList('{"numStartups": 3}', ["projects", "C:/work/b"], "disabledMcpServers", "x", "add");
  assert.deepEqual(JSON.parse(c.text), { numStartups: 3, projects: { "C:/work/b": { disabledMcpServers: ["x"] } } });
  // removing from what is not there changes nothing
  assert.equal(editNameList(text, ["projects", "C:/work/zzz"], "disabledMcpServers", "x", "remove").changed, false);
  // and taking the last name out takes the key with it
  assert.equal(editNameList(a.text, ["projects", "C:/work/a"], "disabledMcpServers", "x", "remove").text, text);
});

test("a file that is not valid JSON or not an object is refused, and a value of the wrong kind is refused", () => {
  assert.match(editNameList('{ "a": 1, }', [], "k", "x", "add").error, /not valid JSON/);
  assert.match(editNameList("[1]", [], "k", "x", "add").error, /JSON object/);
  assert.match(editNameList('{"k": 5}', [], "k", "x", "add").error, /neither a list nor a name/);
  assert.match(editNameList('{"projects": []}', ["projects", "a"], "k", "x", "add").error, /not an object/);
  assert.match(editNameList('{// comment\n"k": []}', [], "k", "x", "add").error, /not valid JSON/);
});

test("the parser gives offsets, and the other helpers read them", () => {
  const text = '{"a": {"b": [1, "two", {"c": true}]}, "d": null}';
  const doc = parseDoc(text);
  assert.ok(doc.ok);
  assert.equal(valueOf(text, nodeAt(doc.root, ["a", "b", 1])), "two");
  assert.equal(valueOf(text, nodeAt(doc.root, ["a", "b", 2, "c"])), true);
  assert.equal(nodeAt(doc.root, ["a", "zzz"]), null);
  assert.equal(findMember(doc.root, "d").index, 1);
  assert.equal(parseDoc('{"a": 1,}').ok, false);
  assert.equal(parseDoc("[1] x").ok, false);
  assert.deepEqual(styleOf("{\r\n\t\"a\": 1\r\n}"), { eol: "\r\n", unit: "\t" });
  assert.ok(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }) && !sameJson({ a: 1 }, { a: 2 }));
});

test("insertMember, insertItem, removeMember, removeItem and replaceNode, directly", () => {
  const text = '{\n  "a": [\n    1,\n    2\n  ]\n}\n';
  const doc = parseDoc(text);
  const arr = nodeAt(doc.root, ["a"]);
  assert.deepEqual(JSON.parse(insertItem(text, arr, 3)).a, [1, 2, 3]);
  assert.deepEqual(JSON.parse(removeItem(text, arr, 0)).a, [2]);
  assert.deepEqual(JSON.parse(insertMember(text, doc.root, "b", { c: 1 })), { a: [1, 2], b: { c: 1 } });
  assert.deepEqual(JSON.parse(removeMember(text, doc.root, 0)), {});
  assert.deepEqual(JSON.parse(replaceNode(text, arr, "x")).a, "x");
});
