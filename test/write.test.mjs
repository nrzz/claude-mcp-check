// The code that writes: backups, atomic writes, restore, and the lock around ~/.claude.json.
import { tmpDir } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_MARK, backupFile, backupPath, listBackups, ops, restoreBackup, stamp, withClaudeJsonLock, writeAtomic, writeWithBackup } from "../src/write.mjs";

const NOW = new Date(2026, 9, 16, 15, 30, 12);

test("a backup is named <file>.bak-mcp-check-<local timestamp>, with -1, -2 when the name is taken", () => {
  const dir = tmpDir("cmc-wr-");
  const file = path.join(dir, "settings.local.json");
  fs.writeFileSync(file, "one");
  assert.equal(stamp(NOW), "20261016-153012");
  assert.equal(backupPath(file, NOW), `${file}${BACKUP_MARK}20261016-153012`);
  const a = backupFile(file, NOW);
  const b = backupFile(file, NOW);
  const c = backupFile(file, NOW);
  assert.deepEqual([a, b, c].map((p) => path.basename(p)), ["settings.local.json.bak-mcp-check-20261016-153012", "settings.local.json.bak-mcp-check-20261016-153012-1", "settings.local.json.bak-mcp-check-20261016-153012-2"]);
  assert.deepEqual(listBackups(file), [a, b, c].map((p) => path.basename(p)), "oldest first");
  assert.equal(fs.readFileSync(a, "utf8"), "one", "the bytes of the file");
});

test("the backups sort by time and then by their number, not as text", () => {
  const dir = tmpDir("cmc-wr2-");
  const file = path.join(dir, "f.json");
  fs.writeFileSync(file, "x");
  for (const n of ["20261016-153012", "20261016-153012-1", "20261016-153012-2", "20261016-153012-10", "20261016-153013"]) fs.writeFileSync(`${file}${BACKUP_MARK}${n}`, "x");
  assert.deepEqual(listBackups(file).map((n) => n.slice(`f.json${BACKUP_MARK}`.length)), ["20261016-153012", "20261016-153012-1", "20261016-153012-2", "20261016-153012-10", "20261016-153013"]);
});

test("writeWithBackup saves the old file first and writes the new text; a new file has nothing to save", () => {
  const dir = tmpDir("cmc-wr3-");
  const file = path.join(dir, "f.json");
  assert.deepEqual(writeWithBackup(file, "new", { now: NOW }), { backup: null });
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  const r = writeWithBackup(file, "newer", { now: NOW });
  assert.equal(fs.readFileSync(file, "utf8"), "newer");
  assert.equal(fs.readFileSync(r.backup, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")), [], "no temporary file is left");
});

test("the mode of a file is kept", { skip: process.platform === "win32" && "no file modes" }, () => {
  const dir = tmpDir("cmc-wr4-");
  const file = path.join(dir, "f.json");
  fs.writeFileSync(file, "x");
  fs.chmodSync(file, 0o600);
  writeAtomic(file, "y");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("when the rename cannot be done the text is written over the file in place", () => {
  const dir = tmpDir("cmc-wr5-");
  const file = path.join(dir, "f.json");
  fs.writeFileSync(file, "old");
  const real = ops.rename;
  ops.rename = () => { const e = new Error("cross-device"); e.code = "EXDEV"; throw e; };
  try { writeAtomic(file, "new"); } finally { ops.rename = real; }
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
  ops.rename = () => { const e = new Error("boom"); e.code = "EIO"; throw e; };
  try { assert.throws(() => writeAtomic(file, "other"), /boom/); } finally { ops.rename = real; }
  assert.equal(fs.readFileSync(file, "utf8"), "new", "a failed write leaves the file as it was");
});

test("restore: the newest backup comes back, what it replaces is saved, and a dry run changes nothing", () => {
  const dir = tmpDir("cmc-wr6-");
  const file = path.join(dir, "f.json");
  fs.writeFileSync(file, "v1");
  writeWithBackup(file, "v2", { now: new Date(2026, 9, 16, 10, 0, 0) });
  writeWithBackup(file, "v3", { now: new Date(2026, 9, 16, 11, 0, 0) });
  const dry = restoreBackup(file, { now: NOW, dryRun: true });
  assert.equal(dry.restored, false);
  assert.equal(fs.readFileSync(file, "utf8"), "v3");
  const r = restoreBackup(file, { now: NOW });
  assert.equal(r.restored, true);
  assert.equal(fs.readFileSync(file, "utf8"), "v2", "the newest backup holds v2, the file before the last change");
  assert.equal(fs.readFileSync(r.savedCurrent, "utf8"), "v3");
  assert.equal(r.others, 1);
  assert.equal(restoreBackup(path.join(dir, "none.json")).restored, false);
});

test("the lock directory is taken, released, and not left behind when the work throws", () => {
  const dir = tmpDir("cmc-lock-");
  const file = path.join(dir, ".claude.json");
  fs.writeFileSync(file, "{}");
  let held;
  const out = withClaudeJsonLock(file, () => { held = fs.existsSync(`${file}.lock`); return 42; });
  assert.equal(out, 42);
  assert.equal(held, true);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.throws(() => withClaudeJsonLock(file, () => { throw new Error("inside"); }), /inside/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("a lock that someone else holds is waited for, and given up on after the wait", () => {
  const dir = tmpDir("cmc-lock2-");
  const file = path.join(dir, ".claude.json");
  fs.writeFileSync(file, "{}");
  fs.mkdirSync(`${file}.lock`);
  const t0 = Date.now();
  assert.throws(() => withClaudeJsonLock(file, () => 1, { waitMs: 300 }), /locked by another program/);
  assert.ok(Date.now() - t0 >= 250);
  assert.equal(fs.existsSync(`${file}.lock`), true, "the other program's lock is not touched");
});

test("a stale lock is taken over", () => {
  const dir = tmpDir("cmc-lock3-");
  const file = path.join(dir, ".claude.json");
  fs.writeFileSync(file, "{}");
  fs.mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.lock`, old, old);
  assert.equal(withClaudeJsonLock(file, () => "ok", { staleMs: 10000 }), "ok");
});
