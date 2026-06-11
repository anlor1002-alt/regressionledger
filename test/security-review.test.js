// Tests for the independent security review (HIGH-2, MED-3, LOW-5).
// HIGH-1 (prompt-injection neutralization) is covered in gate-review.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, SettingsParseError } from '../src/install.js';
import { extractSymbol } from '../src/fingerprint.js';
import { recordHit } from '../src/ledger.js';

delete process.env.RL_DIR;

test('HIGH-2: rl init refuses to clobber an unparseable settings.json, and backs it up', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rl-sec-'));
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const settingsPath = join(cwd, '.claude', 'settings.json');
  const original = '{ "permissions": { "allow": ["Bash"] }, BROKEN json here';
  writeFileSync(settingsPath, original);

  assert.throws(
    () => init(cwd),
    (e) => e.code === 'RL_SETTINGS_UNPARSEABLE',
    'init must throw rather than overwrite'
  );

  // Original file is untouched (never clobbered)…
  assert.equal(readFileSync(settingsPath, 'utf8'), original, 'the real settings.json is preserved verbatim');
  // …and a backup exists.
  const backups = readdirSync(join(cwd, '.claude')).filter((f) => f.includes('.broken-'));
  assert.equal(backups.length, 1, 'a .broken-*.bak backup was written');
});

test('HIGH-2: valid settings.json is still merged, not clobbered', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rl-sec2-'));
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const settingsPath = join(cwd, '.claude', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(git*)'] }, env: { FOO: '1' } }));

  init(cwd);
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(after.permissions.allow, ['Bash(git*)'], 'existing permissions preserved');
  assert.equal(after.env.FOO, '1', 'existing env preserved');
  assert.ok(after.hooks.PreToolUse, 'our hooks were added');
});

test('HIGH-2: an empty or missing settings.json is fine (no false alarm)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rl-sec3-'));
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'settings.json'), '   \n');
  assert.doesNotThrow(() => init(cwd));
});

test('MED-3: enclosing-symbol regex has no catastrophic backtracking on long whitespace', () => {
  // Pre-fix this took ~tens of ms and grew super-linearly; assert it's instant.
  const evil = 'public static ' + ' '.repeat(5000) + '(';
  const start = process.hrtime.bigint();
  extractSymbol(evil + '\nx();', '(');
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 50, `symbol extraction must stay fast (took ${ms.toFixed(1)}ms)`);
});

test('LOW-5: recordHit never throws, even pointed at an impossible path', () => {
  // A path that cannot be created (a file used as a directory) must not throw.
  const f = join(mkdtempSync(join(tmpdir(), 'rl-sec4-')), 'afile');
  writeFileSync(f, 'x');
  assert.doesNotThrow(() => recordHit(join(f, 'subdir'), { mode: 'block', file: 'a', symbol: 's', similarity: 1, failCount: 1, intentHash: 'h' }));
});
