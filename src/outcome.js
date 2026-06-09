// Decides whether a Bash command was a verification run (tests / build / type
// check / lint) and, if so, whether it passed or failed — plus a short error
// signature so a future block can explain *why* the earlier fix failed.
//
// This is heuristic text parsing across many toolchains. When the signal is
// ambiguous we return outcome=null and leave attempts pending rather than guess.

import { truncate } from './util.js';

const VERIFY_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|tsc|vitest|jest)\b/i,
  /\bnpx?\s+(?:tsc|jest|vitest|mocha|ava|eslint|playwright|cypress)\b/i,
  /\b(?:jest|vitest|mocha|ava|pytest|tox|nox|rspec|phpunit)\b/i,
  /\bpython\d?\s+-m\s+(?:pytest|unittest)\b/i,
  /\bgo\s+(?:test|build|vet)\b/i,
  /\bcargo\s+(?:test|build|check|clippy)\b/i,
  /\b(?:tsc|eslint|ruff|mypy|flake8|pylint)\b/i,
  /\bdotnet\s+(?:test|build)\b/i,
  /\b(?:gradle|mvn|\.\/gradlew|\.\/mvnw)\b.*\b(?:test|build|verify)\b/i,
  /\bmake\s+(?:test|check|build|verify|lint)\b/i,
];

export function isVerificationCommand(command = '') {
  return VERIFY_PATTERNS.some((re) => re.test(command));
}

// Counted failures — only a FAILURE when the captured number is > 0. These are
// deliberately tied to real summary phrasing ("N failed", "N failing",
// "(N errors)") so that prose like "fixed 2 errors automatically" can't trip a
// false fail and block a correct fix on the next run.
const NUMBERED_FAIL = [
  /(\d+)\s+(?:tests?\s+)?fail(?:ed|ing)\b/i,
  /(\d+)\s+failing\b/i,
  /\bTests?:.*?(\d+)\s+failed/i,
  /\(\s*(\d+)\s+errors?\b/i, // eslint: "✖ 3 problems (3 errors, 0 warnings)"
];

// Unambiguous failure markers. Note: bare ✗/✖/× glyphs are intentionally NOT
// here — clean runs (e.g. "✖ 0 problems") print them, so they caused false
// fails. Real failures from those runners are caught by NUMBERED_FAIL.
const HARD_FAIL = [
  /(^|\n)FAIL\s/, // jest "FAIL path/to/test"
  /(^|\n)-+\s*FAIL\b/i, // go "--- FAIL: TestX"
  /\berror\s+TS\d+\b/i,
  /Traceback \(most recent call last\)/,
  /\bAssertionError\b/,
  /test result:\s*FAILED/i,
  /(^|\n)\s*panic:/,
  /BUILD\s+(?:FAILED|FAILURE)/i,
  /Compilation (?:failed|error)/i,
  /\bexit code:?\s*[1-9]\d*\b/i,
];

const PASS_MARKERS = [
  /(^|\n)PASS\s/, // jest
  /\b\d+\s+passing\b/i, // mocha/jest
  /\b\d+\s+passed\b/i, // pytest, vitest ("N passed")
  /=+\s*\d+\s+passed/i, // pytest summary line "===== 3 passed in 0.1s ====="
  /(^|\n)ok\s/, // go "ok  pkg  0.01s"
  /\bTests?:.*?\b0 failed/i,
  /test result:\s*ok\b/i,
  /BUILD\s+SUCCESS(?:FUL)?/i,
  /Build succeeded/i,
  /\b0 problems\b/i,
  /\bexit code:?\s*0\b/i,
];

const SIGNATURE_PATTERNS = [
  /^.*\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|ValueError|KeyError|AttributeError|NullPointerException)\b.*$/m,
  /^.*\berror TS\d+:.*$/m,
  /^.*\bpanic:.*$/m,
  /^.*\bExpected\b.*$/m,
  /^.*\bFAIL\b.*$/m,
  /^.*\berror(?:\[E\d+\])?:.*$/m,
];

function numberedFail(text) {
  for (const re of NUMBERED_FAIL) {
    const m = re.exec(text);
    if (m && parseInt(m[1], 10) > 0) return true;
  }
  return false;
}

function extractSignature(text) {
  for (const re of SIGNATURE_PATTERNS) {
    const m = re.exec(text);
    if (m) return truncate(m[0], 200);
  }
  return 'verification failed';
}

/**
 * @returns {{outcome: 'pass'|'fail'|null, errorSignature: string|null}}
 */
export function detectOutcome(text = '') {
  if (!text) return { outcome: null, errorSignature: null };

  const failed = numberedFail(text) || HARD_FAIL.some((re) => re.test(text));
  if (failed) return { outcome: 'fail', errorSignature: extractSignature(text) };

  const passed = PASS_MARKERS.some((re) => re.test(text));
  if (passed) return { outcome: 'pass', errorSignature: null };

  return { outcome: null, errorSignature: null };
}
