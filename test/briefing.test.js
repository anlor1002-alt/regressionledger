import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAttempt, resolvePending, importAttempts, loadLedger, loadConfig, findSimilarFailure } from '../src/ledger.js';
import { buildBriefing, detectThrashWall } from '../src/briefing.js';
import { handleSessionStart, handlePostToolUse } from '../src/hooks.js';

delete process.env.RL_DIR;

const root = () => join(mkdtempSync(join(tmpdir(), 'rl-brief-')), '.regressionledger');

function seedFail(r, n, file, sig, preview) {
  addAttempt(r, { session: 's' + n, file, symbol: 'fn', intentHash: 'h' + n, tokens: ['t' + n, 'x', 'y'], preview, tool: 'Edit' });
  resolvePending(r, 's' + n, 'fail', sig);
}

test('briefing is null on an empty ledger (no context waste)', () => {
  assert.equal(buildBriefing(root()), null);
});

test('briefing lists dead ends and walls, and stays under the cap', () => {
  const r = root();
  seedFail(r, 1, 'src/auth.js', 'AssertionError: expected 200, got 401', 'return res.status(401)…');
  seedFail(r, 2, 'src/auth.js', 'AssertionError: expected 200, got 401', 'await refreshToken(user)…');
  seedFail(r, 3, 'src/api.js', 'TypeError: x is not a function', 'x()');
  const b = buildBriefing(r);
  assert.ok(b.includes('src/auth.js'));
  assert.match(b, /ALREADY FAILED/);
  assert.match(b, /WALLS/);
  assert.match(b, /2× AssertionError/);
  assert.ok(b.length < 10000);
});

test('handleSessionStart injects additionalContext only when there is history', () => {
  const r = root();
  const cwd = join(r, '..');
  process.env.RL_DIR = r;
  try {
    let res = handleSessionStart({ cwd, source: 'compact' });
    assert.equal(res.json, undefined, 'empty ledger: stay silent');
    seedFail(r, 1, 'src/auth.js', 'boom', 'fix…');
    res = handleSessionStart({ cwd, source: 'compact' });
    assert.equal(res.json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(res.json.hookSpecificOutput.additionalContext, /ALREADY FAILED/);
  } finally {
    delete process.env.RL_DIR;
  }
});

test('detectThrashWall fires at 3 distinct failed intents on one signature', () => {
  const r = root();
  seedFail(r, 1, 'src/a.js', 'SameError: wall', 'fix1');
  seedFail(r, 2, 'src/a.js', 'SameError: wall', 'fix2');
  assert.equal(detectThrashWall(r), null, 'two distinct attempts: not yet a wall');
  seedFail(r, 3, 'src/b.js', 'SameError: wall', 'fix3');
  const wall = detectThrashWall(r);
  assert.ok(wall);
  assert.equal(wall.distinct, 3);
  assert.equal(wall.signature, 'SameError: wall');
});

test('escalation message appears after the third distinct failure on a wall', () => {
  const r = root();
  const cwd = join(r, '..');
  process.env.RL_DIR = r;
  try {
    seedFail(r, 1, 'src/a.js', 'SameError: wall', 'fix1');
    seedFail(r, 2, 'src/a.js', 'SameError: wall', 'fix2');
    // third attempt comes through the real PostToolUse path
    addAttempt(r, { session: 'live', file: 'src/a.js', symbol: 'fn', intentHash: 'h99', tokens: ['z'], preview: 'fix3', tool: 'Edit' });
    const res = handlePostToolUse({
      tool_name: 'Bash',
      cwd,
      session_id: 'live',
      tool_input: { command: 'npm test' },
      tool_response: { text: 'Tests: 1 failed\nSameError: wall' },
    });
    assert.match(res.json.hookSpecificOutput.additionalContext, /ESCALATION/);
    assert.match(res.json.hookSpecificOutput.additionalContext, /3 distinct approaches/);
  } finally {
    delete process.env.RL_DIR;
  }
});

test('export/import: a teammate dead end blocks here too (herd immunity)', () => {
  const a = root();
  seedFail(a, 1, 'src/auth.js', 'boom', 'the bad fix');
  const exported = loadLedger(a).attempts;

  const b = root();
  const { added } = importAttempts(b, exported, 'teammate.json');
  assert.equal(added, 1);

  const hit = findSimilarFailure(
    b,
    { file: 'src/auth.js', symbol: 'fn', intentHash: 'h1', tokens: ['t1', 'x', 'y'] },
    loadConfig(b)
  );
  assert.ok(hit, 'imported failure must block in the new ledger');
  assert.equal(loadLedger(b).attempts[0].importedFrom, 'teammate.json');
});

test('import skips duplicates and pendings', () => {
  const a = root();
  seedFail(a, 1, 'src/auth.js', 'boom', 'fix');
  addAttempt(a, { session: 'p', file: 'src/x.js', symbol: 'f', intentHash: 'hp', tokens: ['p'], preview: 'pending one', tool: 'Edit' });
  const exported = loadLedger(a).attempts;

  const b = root();
  let r = importAttempts(b, exported, 'x');
  assert.equal(r.added, 1, 'pending entry must not travel');
  r = importAttempts(b, exported, 'x');
  assert.equal(r.added, 0, 'second import adds nothing');
});
