// The durable attempt ledger. A plain JSON file under `.regressionledger/`
// keyed to the project, so it survives session restarts AND context
// compaction — the whole point of the tool. No database server, no native
// addon, no schema migration headaches.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, debug, withLock, sanitizeForContext } from './util.js';

/**
 * Evict by VALUE, not by position: an old `fail` is still load-bearing (it
 * blocks), so when the ledger exceeds the cap we drop oldest pass/retired/
 * pending entries first, and only touch fails when nothing else is left.
 * (P3 from a community gate review: positional slice() silently dropped
 * active failure records under churn.)
 */
function evictOverCap(ledger, max) {
  if (ledger.attempts.length <= max) return;
  const evictable = [];
  for (let i = 0; i < ledger.attempts.length && evictable.length < ledger.attempts.length - max; i++) {
    if (ledger.attempts[i].outcome !== 'fail') evictable.push(i);
  }
  let over = ledger.attempts.length - max - evictable.length;
  const drop = new Set(evictable);
  for (let i = 0; over > 0 && i < ledger.attempts.length; i++) {
    if (!drop.has(i)) {
      drop.add(i);
      over--;
    }
  }
  ledger.attempts = ledger.attempts.filter((_, i) => !drop.has(i));
}
import { tokenSimilarity } from './similarity.js';

export const DEFAULT_CONFIG = {
  mode: 'block', // "block" => hard-deny a repeat failed fix; "warn" => advise only
  threshold: 0.9, // similarity at/above which two edits are "the same fix"
  minFailures: 1, // a fix must have failed at least this many times before it blocks
  maxLedger: 5000, // cap stored attempts; oldest are dropped past this
  // Match a failed patch anywhere in the same file. The intent hash already
  // pins the exact normalized code, so this stays robust even when the file's
  // surrounding state differs between the failed attempt and the retry. Set to
  // false to additionally require the same enclosing symbol (stricter, but can
  // miss when the symbol can't be re-resolved at check time).
  crossSymbol: true,
};

/** Resolve the `.regressionledger` directory for a given working dir. */
export function resolveRoot(cwd = process.cwd()) {
  if (process.env.RL_DIR) return process.env.RL_DIR;
  return join(cwd, '.regressionledger');
}

export function getPaths(root) {
  return {
    dir: root,
    configPath: join(root, 'config.json'),
    ledgerPath: join(root, 'ledger.json'),
  };
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    debug('failed to read', path, err.message);
    return fallback;
  }
}

export function loadConfig(root) {
  const { configPath } = getPaths(root);
  const raw = readJson(configPath, {});
  return { ...DEFAULT_CONFIG, ...raw };
}

export function saveConfig(root, config) {
  const { configPath } = getPaths(root);
  atomicWrite(configPath, JSON.stringify({ ...DEFAULT_CONFIG, ...config }, null, 2) + '\n');
}

export function loadLedger(root) {
  const { ledgerPath } = getPaths(root);
  const data = readJson(ledgerPath, null);
  if (!data || !Array.isArray(data.attempts)) return { version: 1, attempts: [] };
  return data;
}

export function saveLedger(root, ledger) {
  const { ledgerPath } = getPaths(root);
  atomicWrite(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
}

function makeId(attempt) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${attempt.ts.toString(36)}-${rand}`;
}

/**
 * Record a new edit attempt as "pending". It becomes pass/fail once the next
 * test/build run in the same session resolves it.
 */
export function addAttempt(root, attempt) {
  const entry = {
    id: '',
    ts: Date.now(),
    outcome: 'pending',
    errorSignature: null,
    resolvedTs: null,
    ...attempt,
  };
  entry.id = entry.id || makeId(entry);
  // Lock the whole read-modify-write so parallel hook processes don't clobber
  // each other's appends.
  withLock(root, () => {
    const ledger = loadLedger(root);
    const config = loadConfig(root);
    ledger.attempts.push(entry);
    evictOverCap(ledger, config.maxLedger);
    saveLedger(root, ledger);
  });
  return entry;
}

/**
 * Resolve every still-pending attempt of a session to `outcome`.
 *  - On 'fail': stamp the captured error signature so future blocks can explain
 *    *why* it failed.
 *  - On 'pass': also retire any older FAILED attempts with the same
 *    file+intentHash — the approach works now, so it must stop blocking.
 * Returns the number of attempts resolved.
 */
export function resolvePending(root, session, outcome, errorSignature = null) {
  return withLock(root, () => {
    const ledger = loadLedger(root);
    const now = Date.now();
    const justResolved = [];
    for (const a of ledger.attempts) {
      if (a.session === session && a.outcome === 'pending') {
        a.outcome = outcome;
        a.resolvedTs = now;
        if (outcome === 'fail') a.errorSignature = errorSignature;
        justResolved.push(a);
      }
    }
    // Honest attribution: when several edits are settled by ONE run, each
    // verdict is approximate (one bad edit can sink the batch). Record the
    // batch size so block messages can disclose it.
    if (outcome === 'fail' && justResolved.length > 1) {
      for (const a of justResolved) a.batchSize = justResolved.length;
    }
    if (outcome === 'pass' && justResolved.length) {
      // Retire (don't delete) stale failures that this pass supersedes — the
      // retirement keeps a receipt. Keyed on the RAW channel when available:
      // the literal-variant that passed (timeout=30000) must NOT acquit the
      // variant that failed (timeout=5000) — that one is still a true failure
      // worth blocking if re-applied verbatim. Legacy entries without a
      // rawHash retire on the collapsed key (the only identity they have).
      const passedRaw = new Map();
      const passedIntent = new Map();
      for (const a of justResolved) {
        if (a.rawHash) passedRaw.set(`${a.file}::${a.rawHash}`, a.id);
        passedIntent.set(`${a.file}::${a.intentHash}`, a.id);
      }
      for (const a of ledger.attempts) {
        if (a.outcome !== 'fail' || justResolved.includes(a)) continue;
        const supersededBy = a.rawHash
          ? passedRaw.get(`${a.file}::${a.rawHash}`)
          : passedIntent.get(`${a.file}::${a.intentHash}`);
        if (supersededBy) {
          a.outcome = 'retired';
          a.retiredTs = now;
          a.retiredBy = 'pass';
          a.supersededBy = supersededBy;
        }
      }
    }
    if (justResolved.length) saveLedger(root, ledger);
    return justResolved.length;
  });
}

/**
 * Find the closest prior FAILED attempt to a proposed change.
 *
 * Two channels:
 *  - rawExact: an attempt with the SAME rawHash failed — the retry is the same
 *    code, constants included. This is the only evidence strong enough to
 *    hard-block (changing a constant is often the legitimate next experiment).
 *  - collapsed similarity: same shape with literals abstracted — ambiguous
 *    ("disguise, or parameter change?"); callers should warn, not deny.
 *
 * @returns {{attempt:object, similarity:number, failCount:number, rawExact:boolean}|null}
 */
export function findSimilarFailure(root, target, config = loadConfig(root)) {
  const ledger = loadLedger(root);

  // ACQUITTAL CHECK first: if this exact code (raw channel) has a recorded
  // PASS in this file, it is proven-good — no block is possible (retire-on-
  // pass already cleared same-raw fails) and no shape-note may second-guess
  // it. Without this, a fix that already passed kept getting "expect the same
  // failure" notes every time it was touched, because old sibling-variant
  // failures still collapsed-matched it. (P0 from a community gate review.)
  if (target.rawHash) {
    const provenGood = ledger.attempts.some(
      (a) => a.file === target.file && a.outcome === 'pass' && a.rawHash === target.rawHash
    );
    if (provenGood) return null;
  }

  let bestRaw = null;
  let rawFailCount = 0; // failures of THIS exact code only — gates the hard block
  let best = null;
  let collapsedCount = 0; // same-shape failures (display/context only)
  for (const a of ledger.attempts) {
    if (a.outcome !== 'fail') continue;
    if (a.file !== target.file) continue;
    if (!config.crossSymbol && a.symbol !== target.symbol) continue;

    if (a.rawHash && target.rawHash && a.rawHash === target.rawHash) {
      rawFailCount++;
      if (!bestRaw) bestRaw = a;
      continue;
    }

    let sim;
    if (a.intentHash === target.intentHash) {
      sim = 1;
    } else {
      const aTokens = Array.isArray(a.tokens) ? a.tokens : [];
      const tTokens = Array.isArray(target.tokens) ? target.tokens : [];
      sim = tokenSimilarity(aTokens, tTokens);
    }
    if (sim >= config.threshold) {
      collapsedCount++;
      if (!best || sim > best.similarity) best = { attempt: a, similarity: sim };
    }
  }
  // failCount for a raw hit counts ONLY raw-channel failures: minFailures is a
  // promise about THIS code having failed N times — a sibling variant's
  // failure must not be able to arm someone else's hard block. (P1 from the
  // same review: 5000 fails once + 7000 fails once must not read as "5000
  // failed twice".)
  if (bestRaw) return { attempt: bestRaw, similarity: 1, failCount: rawFailCount, rawExact: true };
  return best ? { ...best, failCount: collapsedCount, rawExact: false } : null;
}

/**
 * Human override: retire failed attempts for a file (optionally narrowed by an
 * intentHash prefix) so they stop blocking. Use when the context genuinely
 * changed (new DB, new dependency version…) and a recorded failure no longer
 * applies. Deliberately explicit — the "it's different this time" claim costs
 * one human decision instead of agent confidence.
 * @returns the number of attempts retired.
 */
export function unblockAttempts(root, file, hashPrefix = '') {
  return withLock(root, () => {
    const ledger = loadLedger(root);
    const now = Date.now();
    let n = 0;
    for (const a of ledger.attempts) {
      if (a.outcome !== 'fail') continue;
      if (a.file !== file) continue;
      if (hashPrefix && !String(a.intentHash || '').startsWith(hashPrefix)) continue;
      a.outcome = 'retired';
      a.retiredTs = now;
      a.retiredBy = 'human';
      n++;
    }
    if (n) saveLedger(root, ledger);
    return n;
  });
}

/**
 * Herd immunity: merge attempts exported from another machine/teammate into
 * this ledger. Entries are deduped by id; imported ones are stamped with
 * `importedFrom` so `rl show` can tell whose scar tissue it is. Pending
 * entries are skipped (only settled verdicts travel).
 * @returns {{added:number, skipped:number}}
 */
const VALID_OUTCOMES = new Set(['fail', 'pass', 'retired']);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

export function importAttempts(root, attempts, from = 'import') {
  return withLock(root, () => {
    const ledger = loadLedger(root);
    const config = loadConfig(root);
    const have = new Set(ledger.attempts.map((a) => a.id));
    let added = 0;
    let skipped = 0;
    for (const a of Array.isArray(attempts) ? attempts : []) {
      // Strict validation: imports are an untrusted, cross-machine channel.
      const ok =
        a &&
        typeof a === 'object' &&
        typeof a.id === 'string' &&
        typeof a.file === 'string' &&
        typeof a.intentHash === 'string' &&
        VALID_OUTCOMES.has(a.outcome) &&
        !have.has(a.id);
      if (!ok) {
        skipped++;
        continue;
      }
      ledger.attempts.push({
        id: a.id.slice(0, 64),
        ts: Number(a.ts) || Date.now(),
        session: str(a.session, 64) || 'imported',
        file: a.file.slice(0, 500),
        symbol: str(a.symbol, 200) || '(file scope)',
        intentHash: a.intentHash.slice(0, 64),
        rawHash: str(a.rawHash, 64) || undefined,
        tokens: Array.isArray(a.tokens) ? a.tokens.filter((t) => typeof t === 'string').slice(0, 5000) : [],
        // Imported text is UNTRUSTED and flows into agent context (briefings,
        // block messages): neutralize control chars / newline structure here,
        // and renderers additionally label it as imported data.
        preview: sanitizeForContext(str(a.preview, 240), 120),
        tool: str(a.tool, 32) || 'Edit',
        outcome: a.outcome,
        errorSignature: sanitizeForContext(str(a.errorSignature, 400), 200) || null,
        resolvedTs: Number(a.resolvedTs) || null,
        retiredTs: Number(a.retiredTs) || undefined,
        retiredBy: str(a.retiredBy, 16) || undefined,
        supersededBy: str(a.supersededBy, 64) || undefined,
        importedFrom: str(a.importedFrom, 200) || from,
      });
      have.add(a.id);
      added++;
    }
    // Imports respect the same cap as organic recording.
    evictOverCap(ledger, config.maxLedger);
    if (added) saveLedger(root, ledger);
    return { added, skipped };
  });
}

// ---- hit log: every block (or would-have-blocked warn) is recorded so users
// can audit precision before/after trusting hard-block mode. ----

const MAX_HITS = 500;

export function recordHit(root, hit) {
  const path = join(root, 'hits.json');
  withLock(root, () => {
    let hits = [];
    try {
      if (existsSync(path)) hits = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      hits = [];
    }
    hits.push({ ts: Date.now(), ...hit });
    if (hits.length > MAX_HITS) hits = hits.slice(hits.length - MAX_HITS);
    atomicWrite(path, JSON.stringify(hits, null, 2) + '\n');
  });
}

export function loadHits(root) {
  try {
    const path = join(root, 'hits.json');
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/** Summary counts for the `stats` command. */
export function summarize(root) {
  const ledger = loadLedger(root);
  const counts = { total: ledger.attempts.length, pending: 0, pass: 0, fail: 0 };
  const files = new Set();
  for (const a of ledger.attempts) {
    counts[a.outcome] = (counts[a.outcome] || 0) + 1;
    files.add(a.file);
  }
  counts.files = files.size;
  return counts;
}
