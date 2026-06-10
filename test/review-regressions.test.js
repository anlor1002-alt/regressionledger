// Regression tests for the adversarial-review findings (v0.8.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAttempt, resolvePending, importAttempts, loadLedger, loadConfig, saveConfig } from '../src/ledger.js';
import { detectThrashWall, buildBriefing } from '../src/briefing.js';
import { handlePreToolUse, handlePostToolUse, handleSessionStart } from '../src/hooks.js';
import { detectOutcome, isVerificationCommand } from '../src/outcome.js';

delete process.env.RL_DIR;
const root = () => join(mkdtempSync(join(tmpdir(), 'rl-rr-')), '.regressionledger');

function seedFail(r, n, file, sig) {
  addAttempt(r, { session: 's' + n, file, symbol: 'fn', intentHash: 'h' + n, tokens: ['t' + n, 'x'], preview: 'fix' + n, tool: 'Edit' });
  resolvePending(r, 's' + n, 'fail', sig);
}

test('REVIEW-1: a fresh wall escalates even when an older, larger wall exists', () => {
  const r = root();
  for (let i = 1; i <= 4; i++) seedFail(r, i, 'src/old.js', 'OldError: big wall');
  for (let i = 5; i <= 7; i++) seedFail(r, i, 'src/new.js', 'NewError: fresh wall');
  const wall = detectThrashWall(r, 'NewError: fresh wall');
  assert.ok(wall, 'the fresh wall must be detected by its own signature');
  assert.equal(wall.distinct, 3);
  assert.equal(wall.signature, 'NewError: fresh wall');
});

test('REVIEW-2: import respects maxLedger and truncates hostile fields', () => {
  const r = root();
  saveConfig(r, { maxLedger: 50 });
  const big = Array.from({ length: 200 }, (_, i) => ({
    id: 'imp' + i,
    file: 'src/x.js',
    intentHash: 'hash' + i,
    outcome: 'fail',
    tokens: ['a'],
    preview: 'P'.repeat(10000),
    errorSignature: 'S'.repeat(10000),
  }));
  importAttempts(r, big, 'hostile.json');
  const attempts = loadLedger(r).attempts;
  assert.ok(attempts.length <= 50, `cap enforced (got ${attempts.length})`);
  assert.ok(attempts[0].preview.length <= 120, 'preview truncated');
  assert.ok(attempts[0].errorSignature.length <= 200, 'signature truncated');
});

test('REVIEW-3: malformed tokens from an import cannot disable the guardrail', () => {
  const r = root();
  // bypass import validation by writing directly (simulates a hand-edited ledger)
  addAttempt(r, { session: 'x', file: 'src/a.js', symbol: 'f', intentHash: 'hOK', tokens: 'evil-string', preview: 'p', tool: 'Edit' });
  resolvePending(r, 'x', 'fail', 'boom');
  seedFail(r, 9, 'src/a.js', 'boom'); // a GOOD failed record for the same file

  const cwd = join(r, '..');
  process.env.RL_DIR = r;
  try {
    // Re-applying the GOOD record's fix must still be denied despite the bad sibling entry.
    const res = handlePreToolUse({
      tool_name: 'Edit',
      cwd,
      session_id: 's2',
      tool_input: { file_path: join(cwd, 'src/a.js'), old_string: 'q', new_string: 't9 x' },
    });
    assert.ok(res.json, 'hook must still respond');
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    delete process.env.RL_DIR;
  }
});

test('REVIEW-4: briefing survives entries with missing preview and non-string intentHash', () => {
  const r = root();
  addAttempt(r, { session: 'x', file: 'src/a.js', symbol: 'f', intentHash: 12345, tokens: ['a'], preview: '', tool: 'Edit' });
  resolvePending(r, 'x', 'fail', 'boom');
  const b = buildBriefing(r);
  assert.ok(b && b.includes('src/a.js'), 'briefing renders despite the malformed entry');
});

test('REVIEW-5: passing run that logs "error:" prose is NOT a failure', () => {
  const out = 'PASS src/foo.test.js\n  console.error\n    error: connection retry (expected in this test)\nTests: 5 passed, 5 total';
  assert.equal(detectOutcome(out).outcome, 'pass');
});

test('REVIEW-6: non-test maven/gradle goals are not verification commands', () => {
  assert.equal(isVerificationCommand('mvn dependency:tree'), false);
  assert.equal(isVerificationCommand('gradle --version'), false);
  assert.equal(isVerificationCommand('mvn test'), true);
  assert.equal(isVerificationCommand('./gradlew build'), true);
});

test('REVIEW-minor: prose "ok"/"OK" and "0 passed" are not pass evidence', () => {
  assert.equal(detectOutcome('ok starting server on :3000').outcome, null);
  assert.equal(detectOutcome('GET /health 200 OK').outcome, null);
  assert.equal(detectOutcome('Tests: 0 passed, 0 total\nNo tests found').outcome, null);
  assert.equal(detectOutcome('ok  \texample.com/pkg\t0.012s').outcome, 'pass', 'real go output still passes');
});

test('REVIEW-minor: rspec, phpunit, and node --test are recognized again', () => {
  assert.equal(isVerificationCommand('rspec spec/'), true);
  assert.equal(isVerificationCommand('phpunit tests/'), true);
  assert.equal(isVerificationCommand('node --test'), true);
  assert.equal(detectOutcome('8 examples, 0 failures').outcome, 'pass');
  assert.equal(detectOutcome('Failures:\n  1) Auth login\n     Failure/Error: expect(code).to eq(200)\n2 examples, 1 failure').outcome, 'fail');
  assert.equal(detectOutcome('# tests 75\n# pass 75\n# fail 0').outcome, 'pass');
  assert.equal(detectOutcome('# tests 75\n# pass 74\n# fail 1').outcome, 'fail');
});

test('REVIEW-minor: guard-clause idioms do not trigger paraphrase notes', () => {
  const r = root();
  const cwd = join(r, '..');
  process.env.RL_DIR = r;
  try {
    // short failed guard clause
    addAttempt(r, { session: 'a', file: 'src/g.js', symbol: 'f', intentHash: 'hg', tokens: ['if', '(', '!', 'user', ')', '{', 'return', 'null', ';', '}'], preview: 'guard', tool: 'Edit' });
    resolvePending(r, 'a', 'fail', 'boom');
    const res = handlePreToolUse({
      tool_name: 'Edit',
      cwd,
      session_id: 'b',
      tool_input: { file_path: join(cwd, 'src/g.js'), old_string: 'q', new_string: 'if (!cfg) { return null; }' },
    });
    assert.equal(res.json, undefined, 'ubiquitous short shapes must not produce notes');
  } finally {
    delete process.env.RL_DIR;
  }
});
