import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAttempt, resolvePending, findSimilarFailure, summarize, loadConfig } from '../src/ledger.js';

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
