// The durable attempt ledger. A plain JSON file under `.regressionledger/`
// keyed to the project, so it survives session restarts AND context
// compaction — the whole point of the tool. No database server, no native
// addon, no schema migration headaches.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, debug, withLock } from './util.js';
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
    if (ledger.attempts.length > config.maxLedger) {
      ledger.attempts = ledger.attempts.slice(ledger.attempts.length - config.maxLedger);
    }
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
    if (outcome === 'pass' && justResolved.length) {
      const passedKeys = new Set(justResolved.map((a) => `${a.file}::${a.intentHash}`));
      ledger.attempts = ledger.attempts.filter((a) => {
        const isStaleFail =
          a.outcome === 'fail' &&
          !justResolved.includes(a) &&
          passedKeys.has(`${a.file}::${a.intentHash}`);
        return !isStaleFail;
      });
    }
    if (justResolved.length) saveLedger(root, ledger);
    return justResolved.length;
  });
}

/**
 * Find the closest prior FAILED attempt to a proposed change.
 * @returns {{attempt:object, similarity:number, failCount:number}|null} best
 *          match at/above the configured threshold (with how many distinct
 *          failures matched), or null.
 */
export function findSimilarFailure(root, target, config = loadConfig(root)) {
  const ledger = loadLedger(root);
  let best = null;
  let failCount = 0;
  for (const a of ledger.attempts) {
    if (a.outcome !== 'fail') continue;
    if (a.file !== target.file) continue;
    if (!config.crossSymbol && a.symbol !== target.symbol) continue;

    let sim;
    if (a.intentHash === target.intentHash) {
      sim = 1;
    } else {
      sim = tokenSimilarity(a.tokens || [], target.tokens || []);
    }
    if (sim >= config.threshold) {
      failCount++;
      if (!best || sim > best.similarity) best = { attempt: a, similarity: sim };
    }
  }
  return best ? { ...best, failCount } : null;
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
