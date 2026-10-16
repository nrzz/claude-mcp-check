// The only code that writes. A file of the user's is never changed without a backup next to it (named
// <file>.bak-mcp-check-<timestamp>; a file that is not there yet has nothing to back up), goes through a temporary file and a
// rename so that nobody sees half of it, keeps the file's mode, and follows a symlink instead of replacing the link.
// `restore` puts a backup back (and saves what it replaces, so that it can be undone too).
//
// ~/.claude.json is the file Claude Code keeps rewriting while it runs. It guards its writes with a lock directory,
// .claude.json.lock (held for tens of milliseconds, seen with Claude Code 2.1.299), writes through a temporary file and
// re-reads before it saves. withClaudeJsonLock takes the same lock, so the two writers take turns.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The file operations that matter, in one place. Tests swap them to make a rename fail.
export const ops = { rename: (from, to) => fs.renameSync(from, to) };

const two = (n) => String(n).padStart(2, "0");

/** 20261016-153012 in local time, used in backup names. */
export function stamp(d = new Date()) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

export const BACKUP_MARK = ".bak-mcp-check-";

/** <file>.bak-mcp-check-<timestamp>, or with -1, -2 ... when that name is taken. */
export function backupPath(file, now = new Date()) {
  const base = `${file}${BACKUP_MARK}${stamp(now)}`;
  if (!exists(base)) return base;
  for (let i = 1; i < 1000; i++) if (!exists(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

/** The names of the backups of a file, oldest first: by the stamp, then by the -1, -2 ... that follows it, as a number. */
export function listBackups(file) {
  const prefix = `${path.basename(file)}${BACKUP_MARK}`;
  const key = (name) => {
    const rest = name.slice(prefix.length);
    const m = /^(\d{8}-\d{6})(?:-(\d+))?$/.exec(rest);
    return m ? [m[1], Number(m[2] || 0)] : [rest, 0];
  };
  try {
    return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(prefix)).sort((a, b) => {
      const [sa, na] = key(a);
      const [sb, nb] = key(b);
      return sa < sb ? -1 : sa > sb ? 1 : na - nb;
    });
  } catch { return []; }
}

/** Where the bytes of a file really are: a symlink is followed, so the link stays a link. */
function realTarget(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

/**
 * Write text to a file through a temporary file in the same folder and a rename. The mode of an existing file is kept. When
 * the rename cannot be done (a file that is a mount point, a folder on another volume: EXDEV, EBUSY, EPERM), the text is
 * written over the file in place instead.
 */
export function writeAtomic(file, text) {
  const target = realTarget(file);
  let mode = null;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* a new file */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmp, text);
  if (mode !== null) { try { fs.chmodSync(tmp, mode); } catch { /* the file system has no modes */ } }
  try {
    ops.rename(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    if (!e || !["EXDEV", "EBUSY", "EPERM", "EACCES"].includes(e.code)) throw e;
    fs.writeFileSync(target, text);
  }
}

/** Copy a file to its backup name. Returns the backup's path. */
export function backupFile(file, now = new Date()) {
  const to = backupPath(file, now);
  fs.copyFileSync(file, to);
  return to;
}

/** Writes `text` to `file`, saving the file as it is now first when it exists. Returns { backup } (null for a new file). */
export function writeWithBackup(file, text, { now = new Date() } = {}) {
  const backup = exists(file) ? backupFile(file, now) : null;
  writeAtomic(file, text);
  return { backup };
}

/**
 * Put the newest backup of a file back. The file as it is now is backed up first, so this can be undone too.
 * Returns { restored, path, from, savedCurrent, others } or { restored: false, reason }.
 */
export function restoreBackup(file, { now = new Date(), dryRun = false } = {}) {
  const names = listBackups(file);
  if (!names.length) return { restored: false, path: file, reason: `there is no backup of it (they are named <file>${BACKUP_MARK}<timestamp>)` };
  const from = path.join(path.dirname(file), names[names.length - 1]);
  const result = { restored: !dryRun, path: file, from, savedCurrent: null, others: names.length - 1, dryRun };
  if (dryRun) return result;
  if (exists(file)) result.savedCurrent = backupFile(file, now);
  writeAtomic(file, fs.readFileSync(from));
  return result;
}

const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end) { /* wait */ } } };

/**
 * Runs `fn` while holding <file>.lock, the lock directory Claude Code takes around its own writes of .claude.json. A lock that
 * is older than `staleMs` is taken over (Claude Code does the same). Waits up to `waitMs`, then throws.
 */
export function withClaudeJsonLock(file, fn, { waitMs = 5000, staleMs = 10000 } = {}) {
  const lock = `${file}.lock`;
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > staleMs) { try { fs.rmdirSync(lock); } catch { /* another process took it */ } continue; }
      if (Date.now() > until) throw new Error(`${path.basename(file)} is locked by another program (${path.basename(lock)} exists): try again in a moment`);
      nap(40);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* gone */ } }
}
