import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVerificationCommand, detectOutcome } from '../src/outcome.js';

test('recognizes verification commands', () => {
  for (const cmd of ['npm test', 'npm run build', 'pnpm test', 'pytest -q', 'go test ./...', 'cargo test', 'npx vitest run', 'tsc --noEmit']) {
    assert.ok(isVerificationCommand(cmd), `${cmd} should be a verification command`);
  }
});

test('ignores non-verification commands', () => {
  for (const cmd of ['git status', 'ls -la', 'echo hello', 'cat package.json', 'cd src']) {
    assert.ok(!isVerificationCommand(cmd), `${cmd} should NOT be a verification command`);
  }
});

test('detects failure from jest-style output', () => {
  const r = detectOutcome('Tests: 2 failed, 5 passed, 7 total');
  assert.equal(r.outcome, 'fail');
});

test('detects failure from a tsc error and captures the signature', () => {
  const r = detectOutcome("src/a.ts(3,5): error TS2345: Argument of type 'string'...");
  assert.equal(r.outcome, 'fail');
  assert.match(r.errorSignature, /TS2345/);
});

test('"0 failing" with passing is a pass, not a fail', () => {
  const r = detectOutcome('10 passing\n0 failing');
  assert.equal(r.outcome, 'pass');
});

test('ambiguous output resolves to null (leave pending)', () => {
  const r = detectOutcome('Done. Everything looks fine.');
  assert.equal(r.outcome, null);
});

test('python traceback is a failure', () => {
  const r = detectOutcome('Traceback (most recent call last):\n  File "x.py"\nAssertionError: nope');
  assert.equal(r.outcome, 'fail');
  assert.match(r.errorSignature, /AssertionError/);
});

test('pytest and go passes are detected (not left pending)', () => {
  assert.equal(detectOutcome('===== 3 passed in 0.10s =====').outcome, 'pass');
  assert.equal(detectOutcome('ok  \texample.com/pkg\t0.012s').outcome, 'pass');
});

test('go test failure is detected', () => {
  assert.equal(detectOutcome('--- FAIL: TestLogin (0.00s)\n    auth_test.go:12').outcome, 'fail');
});

test('prose mentioning "errors" on a passing run is NOT a failure', () => {
  // The most dangerous false positive: a clean run that happens to say "errors".
  assert.equal(detectOutcome('Fixed 2 errors automatically.\n0 failing\n5 passing').outcome, 'pass');
  assert.equal(detectOutcome('✖ 0 problems (0 errors, 0 warnings)').outcome, 'pass');
});

test('eslint with real errors is a failure', () => {
  assert.equal(detectOutcome('✖ 3 problems (3 errors, 0 warnings)').outcome, 'fail');
});
