import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePreToolUse, handlePostToolUse } from '../src/hooks.js';
import { resolveRoot, saveConfig, summarize, loadHits } from '../src/ledger.js';

delete process.env.RL_DIR; // ensure root derives from cwd, isolating each project

const FIX = 'return res.status(401).json({ ok: false });';

function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'rl-proj-'));
  mkdirSync(join(cwd, 'src'), { recursive: true });
  const file = join(cwd, 'src', 'auth.js');
  writeFileSync(file, `function login(req) {\n  ${FIX}\n}\n`);
  return { cwd, file };
}

function edit(cwd, file, newCode, session) {
  return {
    tool_name: 'Edit',
    cwd,
    session_id: session,
    tool_input: { file_path: file, old_string: 'return null;', new_string: newCode },
  };
}

function bash(cwd, command, text, session) {
  return {
    tool_name: 'Bash',
    cwd,
    session_id: session,
    tool_input: { command },
    tool_response: { text },
  };
}

test('blocks re-applying a fix that previously failed (across sessions)', () => {
  const { cwd, file } = project();

  // Session 1: agent applies the fix, then tests fail.
  handlePostToolUse(edit(cwd, file, FIX, 's1'));
  handlePostToolUse(bash(cwd, 'npm test', 'Tests: 1 failed, 0 passed', 's1'));
  assert.equal(summarize(resolveRoot(cwd)).fail, 1);

  // Session 2 (fresh context): agent tries the SAME fix again -> blocked.
  const res = handlePreToolUse(edit(cwd, file, FIX, 's2'));
  assert.ok(res.json, 'expected a hook response');
  assert.equal(res.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.json.hookSpecificOutput.permissionDecisionReason, /already tried/i);
});

test('allows a genuinely different fix', () => {
  const { cwd, file } = project();
  handlePostToolUse(edit(cwd, file, FIX, 's1'));
  handlePostToolUse(bash(cwd, 'npm test', '1 failed', 's1'));

  const res = handlePreToolUse(edit(cwd, file, 'return refreshToken(req).then(send);', 's2'));
  assert.equal(res.json, undefined, 'a different approach should not be blocked');
});

test('does not block a fix that ended up passing', () => {
  const { cwd, file } = project();
  handlePostToolUse(edit(cwd, file, FIX, 's1'));
  handlePostToolUse(bash(cwd, 'npm test', '5 passing\n0 failing', 's1'));

  const res = handlePreToolUse(edit(cwd, file, FIX, 's2'));
  assert.equal(res.json, undefined, 'a passing fix must never be blocked');
});

test('warn mode advises instead of denying', () => {
  const { cwd, file } = project();
  handlePostToolUse(edit(cwd, file, FIX, 's1'));
  handlePostToolUse(bash(cwd, 'npm test', '1 failed', 's1'));
  saveConfig(resolveRoot(cwd), { mode: 'warn' });

  const res = handlePreToolUse(edit(cwd, file, FIX, 's2'));
  assert.ok(res.json.hookSpecificOutput.additionalContext, 'should inject a warning');
  assert.equal(res.json.hookSpecificOutput.permissionDecision, undefined, 'warn must not deny');
});

test('non-edit / non-test tools are ignored', () => {
  const { cwd } = project();
  const pre = handlePreToolUse({ tool_name: 'Read', cwd, session_id: 's1', tool_input: {} });
  assert.equal(pre.json, undefined);
  const post = handlePostToolUse(bash(cwd, 'git status', 'nothing to commit', 's1'));
  assert.equal(post.json, undefined);
});

test('the first attempt is never blocked', () => {
  const { cwd, file } = project();
  const res = handlePreToolUse(edit(cwd, file, FIX, 's1'));
  assert.equal(res.json, undefined);
});

test('minFailures=2 requires two failures before blocking', () => {
  const { cwd, file } = project();
  saveConfig(resolveRoot(cwd), { minFailures: 2 });

  // First failure — not enough to block yet.
  handlePostToolUse(edit(cwd, file, FIX, 's1'));
  handlePostToolUse(bash(cwd, 'npm test', '1 failed', 's1'));
  let res = handlePreToolUse(edit(cwd, file, FIX, 's2'));
  assert.equal(res.json, undefined, 'one failure must not block when minFailures=2');

  // Second failure of the same fix — now it blocks.
  handlePostToolUse(edit(cwd, file, FIX, 's2'));
  handlePostToolUse(bash(cwd, 'npm test', '1 failed', 's2'));
  res = handlePreToolUse(edit(cwd, file, FIX, 's3'));
  assert.equal(res.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.json.hookSpecificOutput.permissionDecisionReason, /failed 2 times/i);
});

test('hits are recorded for blocks and warn-mode near-misses', () => {
  const { cwd, file } = project();
  const root = resolveRoot(cwd);

  handlePostToolUse(edit(cwd, file, FIX, 's1'));
  handlePostToolUse(bash(cwd, 'npm test', '1 failed', 's1'));

  // block-mode hit
  handlePreToolUse(edit(cwd, file, FIX, 's2'));
  // warn-mode hit
  saveConfig(root, { mode: 'warn' });
  handlePreToolUse(edit(cwd, file, FIX, 's2'));

  const hits = loadHits(root);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].mode, 'block');
  assert.equal(hits[1].mode, 'warn');
  assert.equal(hits[0].file, 'src/auth.js');
  assert.ok(hits[0].similarity >= 0.9);
});
