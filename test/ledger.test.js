import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAttempt, resolvePending, findSimilarFailure, summarize, loadConfig, unblockAttempts, loadLedger } from '../src/ledger.js';

function tmpRoot() {
  return join(mkdtempSync(join(tmpdir(), 'rl-ledger-')), '.regressionledger');
}

const sample = {
  session: 's1',
  file: 'src/auth.js',
  symbol: 'login',
  intentHash: 'hash-abc',
  tokens: ['return', 'res', '.', 'status', '(', '"NUM"', ')'],
  preview: 'return res.status(401)',
  tool: 'Edit',
};

test('records a pending attempt and resolves it to fail', () => {
  const root = tmpRoot();
  addAttempt(root, { ...sample });
  let s = summarize(root);
  assert.equal(s.pending, 1);

  const n = resolvePending(root, 's1', 'fail', 'AssertionError: 401');
  assert.equal(n, 1);
  s = summarize(root);
  assert.equal(s.fail, 1);
  assert.equal(s.pending, 0);
});

test('findSimilarFailure matches an identical later attempt', () => {
  const root = tmpRoot();
  addAttempt(root, { ...sample });
  resolvePending(root, 's1', 'fail', 'boom');

  const config = loadConfig(root);
  const hit = findSimilarFailure(
    root,
    { file: 'src/auth.js', symbol: 'login', intentHash: 'hash-abc', tokens: sample.tokens },
    config
  );
  assert.ok(hit, 'should find the prior failure');
  assert.equal(hit.similarity, 1);
  assert.equal(hit.attempt.errorSignature, 'boom');
});

test('a passing attempt retires the stale matching failure', () => {
  const root = tmpRoot();
  // session A fails
  addAttempt(root, { ...sample, session: 'A' });
  resolvePending(root, 'A', 'fail', 'boom');
  // session B applies the same fix and it passes now
  addAttempt(root, { ...sample, session: 'B' });
  resolvePending(root, 'B', 'pass');

  const hit = findSimilarFailure(
    root,
    { file: 'src/auth.js', symbol: 'login', intentHash: 'hash-abc', tokens: sample.tokens },
    loadConfig(root)
  );
  assert.equal(hit, null, 'the once-failing fix now passes, so it must not block');
});

test('retire-on-pass keeps a receipt instead of deleting', () => {
  const root = tmpRoot();
  addAttempt(root, { ...sample, session: 'A' });
  resolvePending(root, 'A', 'fail', 'boom');
  addAttempt(root, { ...sample, session: 'B' });
  resolvePending(root, 'B', 'pass');

  const attempts = loadLedger(root).attempts;
  assert.equal(attempts.length, 2, 'nothing is deleted');
  const retired = attempts.find((a) => a.outcome === 'retired');
  assert.ok(retired, 'the stale failure is retired, not removed');
  assert.equal(retired.retiredBy, 'pass');
  const passing = attempts.find((a) => a.outcome === 'pass');
  assert.equal(retired.supersededBy, passing.id, 'receipt links to the superseding attempt');
});

test('unblock retires failures for a file and they stop blocking', () => {
  const root = tmpRoot();
  addAttempt(root, { ...sample });
  resolvePending(root, 's1', 'fail', 'boom');

  // It blocks before the override…
  assert.ok(findSimilarFailure(root, { file: sample.file, symbol: sample.symbol, intentHash: sample.intentHash, tokens: sample.tokens }, loadConfig(root)));

  const n = unblockAttempts(root, 'src/auth.js');
  assert.equal(n, 1);

  // …and no longer after.
  const hit = findSimilarFailure(root, { file: sample.file, symbol: sample.symbol, intentHash: sample.intentHash, tokens: sample.tokens }, loadConfig(root));
  assert.equal(hit, null);
  const retired = loadLedger(root).attempts.find((a) => a.outcome === 'retired');
  assert.equal(retired.retiredBy, 'human', 'the receipt records that a human made the call');
});

test('unblock with a hash prefix only retires matching attempts', () => {
  const root = tmpRoot();
  addAttempt(root, { ...sample, intentHash: 'aaa111' });
  addAttempt(root, { ...sample, intentHash: 'bbb222' });
  resolvePending(root, 's1', 'fail', 'boom');

  const n = unblockAttempts(root, 'src/auth.js', 'aaa');
  assert.equal(n, 1);
  const attempts = loadLedger(root).attempts;
  assert.equal(attempts.filter((a) => a.outcome === 'fail').length, 1, 'the other failure still blocks');
});

test('does not match across different files', () => {
  const root = tmpRoot();
  addAttempt(root, { ...sample });
  resolvePending(root, 's1', 'fail', 'boom');
  const hit = findSimilarFailure(
    root,
    { file: 'src/other.js', symbol: 'login', intentHash: 'hash-abc', tokens: sample.tokens },
    loadConfig(root)
  );
  assert.equal(hit, null);
});

test('pending attempts never trigger a block', () => {
  const root = tmpRoot();
  addAttempt(root, { ...sample }); // stays pending
  const hit = findSimilarFailure(
    root,
    { file: 'src/auth.js', symbol: 'login', intentHash: 'hash-abc', tokens: sample.tokens },
    loadConfig(root)
  );
  assert.equal(hit, null);
});
