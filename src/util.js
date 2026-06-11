// Small dependency-free helpers shared across RegressionLedger.
import { createHash } from 'node:crypto';
import { writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Read all of stdin as a UTF-8 string. Resolves to '' when there is no piped
 * input (e.g. a TTY), so callers never hang waiting for an EOF that won't come.
 */
export function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Write a file atomically: write to a sibling temp file, then rename over the
 * target. A rename within the same directory is atomic on every OS we care
 * about, so a crash can never leave the ledger half-written.
 */
export function atomicWrite(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

// --- terminal colors (CLI output only; hooks never color their stdout) ---
const ESC = String.fromCharCode(27);
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const wrap = (open, close) => (s) =>
  useColor ? `${ESC}[${open}m${s}${ESC}[${close}m` : String(s);

export const color = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/** Log to stderr only when RL_DEBUG is set. Hooks must keep stdout clean. */
export function debug(...args) {
  if (process.env.RL_DEBUG) console.error('[regressionledger]', ...args);
}

/** Collapse whitespace and truncate a string to a maximum length. */
export function truncate(str, max = 200) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Neutralize text that flows from external sources (test output, imported
 * ledgers, agent-written code) into the agent's context: strip control
 * characters, collapse all whitespace to single spaces (no smuggled
 * newline-structured "instructions"), and cap length. Structural
 * neutralization only — content is data and is labeled as such at render time.
 */
export function sanitizeForContext(str, max = 200) {
  if (!str) return '';
  let out = '';
  for (const ch of String(str)) {
    const c = ch.charCodeAt(0);
    out += c < 32 || (c >= 127 && c <= 159) ? ' ' : ch;
  }
  const t = out.replace(/  +/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + String.fromCharCode(8230) : t;
}

/** Synchronous sleep without busy-spinning the CPU. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable; fall back to a short busy wait.
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true; // signal 0 delivered: process exists
  } catch (err) {
    return err.code === 'EPERM'; // exists but not ours; anything else = dead
  }
}

/**
 * Run `fn` while holding an exclusive lock on `dir`, so concurrent hook
 * processes can't lose each other's writes during a read-modify-write of the
 * ledger.
 *
 * Safety properties (hardened after a community gate review):
 *  - The lock records {pid, token}. A lock is only "stale" when its HOLDER
 *    PROCESS IS DEAD — never merely old, so a live-but-slow holder (big ledger,
 *    long shingling) cannot have its lock stolen mid-write.
 *  - Release deletes the lock only if it still carries OUR token, so even in a
 *    pathological race we can never unlink someone else's lock.
 *  - A waiter facing a LIVE holder waits up to `maxWaitMs` (15s) and only then
 *    proceeds unlocked as the documented last resort — hooks must never hang
 *    the agent indefinitely, and a >15s ledger write by a live process is the
 *    truly rare case, not parallel tool calls.
 */
export function withLock(dir, fn, { maxWaitMs = 15000 } = {}) {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, '.lock');
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();
  let held = false;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      closeSync(fd);
      held = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') break; // unexpected fs error; proceed unlocked
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {
        /* unreadable/vanished — re-check liveness as unknown below */
      }
      if (holder && !pidAlive(holder.pid)) {
        try {
          unlinkSync(lockPath); // holder is dead: safe to steal
        } catch {}
        continue;
      }
      if (!holder) {
        // Unreadable lock (mid-write or corrupt): brief grace, then treat a
        // still-unreadable lock as abandoned.
        if (Date.now() - start > 1000) {
          try {
            unlinkSync(lockPath);
          } catch {}
          continue;
        }
      }
      if (Date.now() - start > maxWaitMs) break; // live holder, out of patience
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        const cur = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (cur && cur.token === token) unlinkSync(lockPath);
      } catch {
        /* lock already gone or not ours — leave it alone */
      }
    }
  }
}
