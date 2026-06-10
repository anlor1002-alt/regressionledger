// Decides whether a Bash command was a verification run (tests / build / type
// check / lint) and, if so, whether it passed or failed — plus a short error
// signature so a future block can explain *why* the earlier fix failed.
//
// The patterns live in src/signatures.js as a per-toolchain registry; adding a
// new test runner there (plus a fixture) is the canonical first contribution.
// When the signal is ambiguous we return outcome=null and leave attempts
// pending rather than guess — a wrong "fail" would block a correct fix later.

import { TOOLCHAINS, GENERIC } from './signatures.js';
import { truncate } from './util.js';

export function isVerificationCommand(command = '') {
  return TOOLCHAINS.some((t) => t.commands.some((re) => re.test(command)));
}

function countedFail(res, text) {
  for (const re of res) {
    const m = re.exec(text);
    if (m && parseInt(m[1], 10) > 0) return re;
  }
  return null;
}

function firstMatch(res, text) {
  for (const re of res) if (re.test(text)) return re;
  return null;
}

function extractSignature(toolchain, text) {
  // Try the deciding toolchain's pool first, then every other toolchain's
  // (a generic "N failed" count from one toolchain often matches output whose
  // best signature lines belong to another), then the generic pool.
  const pools = [
    toolchain ? toolchain.signatures : [],
    ...TOOLCHAINS.map((t) => t.signatures),
    GENERIC.signatures,
  ];
  for (const pool of pools) {
    for (const re of pool) {
      const m = re.exec(text);
      if (m) return truncate(m[0], 200);
    }
  }
  return 'verification failed';
}

/**
 * Classify a verification run's output, with the evidence trail.
 * @returns {{outcome:'pass'|'fail'|null, errorSignature:string|null,
 *            matches:Array<{toolchain:string, kind:string, pattern:string}>}}
 */
export function explainOutcome(text = '') {
  const matches = [];
  if (!text) return { outcome: null, errorSignature: null, matches };

  // FAIL evidence first — a "3 failed, 5 passed" run is a fail, and pass
  // markers must never override explicit failure evidence.
  for (const t of TOOLCHAINS) {
    const hard = firstMatch(t.fail, text);
    if (hard) {
      matches.push({ toolchain: t.name, kind: 'fail', pattern: String(hard) });
      return { outcome: 'fail', errorSignature: extractSignature(t, text), matches };
    }
    const counted = countedFail(t.failCounts, text);
    if (counted) {
      matches.push({ toolchain: t.name, kind: 'fail-count', pattern: String(counted) });
      return { outcome: 'fail', errorSignature: extractSignature(t, text), matches };
    }
  }
  // A toolchain's EXPLICIT pass evidence outranks GENERIC fail substrings —
  // a passing verbose run may mention "AssertionError" inside a test name, and
  // that must not convert a real pass into a recorded failure.
  for (const t of TOOLCHAINS) {
    const ok = firstMatch(t.pass, text);
    if (ok) {
      matches.push({ toolchain: t.name, kind: 'pass', pattern: String(ok) });
      return { outcome: 'pass', errorSignature: null, matches };
    }
  }

  const gHard = firstMatch(GENERIC.fail, text);
  if (gHard) {
    matches.push({ toolchain: 'generic', kind: 'fail', pattern: String(gHard) });
    return { outcome: 'fail', errorSignature: extractSignature(null, text), matches };
  }
  const gCount = countedFail(GENERIC.failCounts, text);
  if (gCount) {
    matches.push({ toolchain: 'generic', kind: 'fail-count', pattern: String(gCount) });
    return { outcome: 'fail', errorSignature: extractSignature(null, text), matches };
  }

  const gOk = firstMatch(GENERIC.pass, text);
  if (gOk) {
    matches.push({ toolchain: 'generic', kind: 'pass', pattern: String(gOk) });
    return { outcome: 'pass', errorSignature: null, matches };
  }

  return { outcome: null, errorSignature: null, matches };
}

/** @returns {{outcome:'pass'|'fail'|null, errorSignature:string|null}} */
export function detectOutcome(text = '') {
  const { outcome, errorSignature } = explainOutcome(text);
  return { outcome, errorSignature };
}
