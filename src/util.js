// Small dependency-free helpers shared across RegressionLedger.
import { createHash } from 'node:crypto';
import { writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
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

/**
 * Run `fn` while holding an exclusive lock on `dir`, so concurrent hook
 * processes can't lose each other's writes during a read-modify-write of the
 * ledger. Lock acquisition is best-effort: a stale lock (>10s) is stolen, and
 * after `maxWaitMs` we proceed unlocked rather than ever hanging the agent — a
 * rare lost update is far better than a stuck tool call.
 */
export function withLock(dir, fn, { maxWaitMs = 4000 } = {}) {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, '.lock');
  const start = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') break; // unexpected; proceed unlocked
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10000) {
          unlinkSync(lockPath); // steal a stale lock
          continue;
        }
      } catch {
        /* lock vanished between calls; retry */
      }
      if (Date.now() - start > maxWaitMs) break; // give up waiting, proceed
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}
