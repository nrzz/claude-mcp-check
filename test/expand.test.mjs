// ${VAR} expansion: every rule below was seen from the real binary (test/e2e-claude.test.mjs puts the same patterns to it).
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { envLookup, expandString, expansionEnv, isBareReference, referencesIn, REMOTE_EMPTY } from "../src/expand.mjs";

const env = { V_SET: "value-set", V_EMPTY: "", HOME: "/home/me" };
const x = (text, opts = {}) => expandString(text, { env, platform: "linux", ...opts });

test("a set variable is replaced, also when its value is empty", () => {
  assert.equal(x("a=${V_SET}").text, "a=value-set");
  assert.equal(x("b=${V_EMPTY}").text, "b=");
  assert.deepEqual(x("b=${V_EMPTY}").empty, ["V_EMPTY"]);
  assert.equal(x("pre-${V_SET}-post").text, "pre-value-set-post");
});

test("an unset variable is left as it is and reported", () => {
  const r = x("c=${V_UNSET} d=${V_SET}");
  assert.equal(r.text, "c=${V_UNSET} d=value-set");
  assert.deepEqual(r.missing, ["V_UNSET"]);
  assert.deepEqual(r.refs, ["V_UNSET", "V_SET"]);
});

test("a default is used only when the variable is unset: an empty value stays empty", () => {
  assert.equal(x("${V_UNSET:-dflt}").text, "dflt");
  assert.equal(x("${V_SET:-dflt}").text, "value-set");
  assert.equal(x("${V_EMPTY:-dflt}").text, "");
  assert.equal(x("${V_UNSET:-}").text, "");
  assert.deepEqual(x("${V_UNSET:-dflt}").defaulted, ["V_UNSET"]);
  assert.deepEqual(x("${V_UNSET:-dflt}").missing, []);
});

test("what is not a reference is left alone: $VAR, %VAR%, ~, ${}, an open brace, ${VAR-text}", () => {
  for (const s of ["h=$V_SET", "s=%V_SET%", "t=~", "j=${}", "i=${V_SET", "p=${V_UNSET-dflt}"]) assert.equal(x(s).text, s, s);
  assert.deepEqual(x("p=${V_UNSET-dflt}").missing, []);
});

test("there is no escape: $${VAR} is a dollar sign and the value", () => {
  assert.equal(x("o=$${V_SET}").text, "o=$value-set");
});

test("the default ends at the first closing brace, and nothing is expanded twice", () => {
  assert.equal(x("q=${V_SET:-${V_SET}}").text, "q=value-set}");
  assert.equal(x("r=${V_UNSET:-${V_SET}}").text, "r=${V_SET}");
});

test("on Windows names are not case sensitive; elsewhere they are", () => {
  assert.equal(expandString("${v_set}", { env, platform: "win32" }).text, "value-set");
  assert.equal(expandString("${v_set}", { env, platform: "linux" }).text, "${v_set}");
  assert.equal(envLookup({ Path: "C:\\x" }, "PATH", "win32"), "C:\\x");
  assert.equal(envLookup({ Path: "C:\\x" }, "PATH", "linux"), undefined);
});

test("placeholders win over the environment (a plugin's CLAUDE_PLUGIN_ROOT)", () => {
  assert.equal(expandString("${CLAUDE_PLUGIN_ROOT}/x", { env, platform: "linux", extra: { CLAUDE_PLUGIN_ROOT: "/plug" } }).text, "/plug/x");
  assert.deepEqual(expandString("${CLAUDE_PROJECT_DIR}", { env, platform: "linux" }).missing, ["CLAUDE_PROJECT_DIR"]);
});

test("in the url and headers of a remote server some credential names read as empty, set or not", () => {
  const e = { ...env, NPM_TOKEN: "secret", ANTHROPIC_API_KEY: "sk-ant-x", GITHUB_TOKEN: "ghp", MY_KEY: "mine" };
  const r = expandString("Bearer ${NPM_TOKEN}|${ANTHROPIC_API_KEY:-fallback}|${GITHUB_TOKEN}|${MY_KEY}", { env: e, platform: "linux", remote: true });
  assert.equal(r.text, "Bearer ||ghp|mine");
  assert.deepEqual(r.readAsEmpty, ["NPM_TOKEN", "ANTHROPIC_API_KEY"]);
  // a stdio argument expands them as any other variable
  assert.equal(expandString("${NPM_TOKEN}", { env: e, platform: "linux" }).text, "secret");
  assert.ok(REMOTE_EMPTY.has("AWS_BEARER_TOKEN_BEDROCK") && !REMOTE_EMPTY.has("GITHUB_TOKEN"));
});

test("referencesIn and isBareReference", () => {
  assert.deepEqual(referencesIn("${A} and ${B:-x} and ${A}"), ["A", "B"]);
  assert.deepEqual(referencesIn(5), []);
  assert.ok(isBareReference("${TOKEN}") && isBareReference("${TOKEN:-x}"));
  assert.ok(!isBareReference("Bearer ${TOKEN}"));
});

test("the user settings env goes over the process environment, and non-strings become strings", () => {
  const e = expansionEnv({ A: "process", B: "process" }, { A: "settings", C: 5, D: null, E: true });
  assert.deepEqual(e, { A: "settings", B: "process", C: "5", D: "", E: "true" });
  assert.deepEqual(expansionEnv({ A: "1" }, undefined), { A: "1" });
});
