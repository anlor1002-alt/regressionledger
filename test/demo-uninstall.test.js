import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, uninstall } from '../src/install.js';

delete process.env.RL_DIR; // ensure root derives from cwd, isolating each project

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'regressionledger.js');

function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'rl-uninst-'));
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  return cwd;
}

const FOREIGN_HOOK = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo my-own-hook' }] };

test('rl demo runs end-to-end, blocks the repeat fix, and exits 0', () => {
  const out = execFileSync(process.execPath, [BIN, 'demo'], { encoding: 'utf8' });
  assert.match(out, /BLOCKED/);
  assert.match(out, /already tried this exact fix/);
  assert.match(out, /rl uninstall/); // the escape hatch is advertised
});

test('uninstall removes exactly our hooks and preserves everything else', () => {
  const cwd = project();
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [FOREIGN_HOOK] }, permissions: { allow: ['Bash(ls:*)'] } }, null, 2)
  );
  init(cwd);
  const installed = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.ok(JSON.stringify(installed).includes('regressionledger'), 'init should have added our hooks');

  const res = uninstall(cwd);
  assert.ok(res.removedHooks >= 3, `expected >=3 removed entries, got ${res.removedHooks}`);

  const after = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!JSON.stringify(after).includes('regressionledger'), 'no trace of our hooks may remain');
  assert.deepEqual(after.hooks.PreToolUse, [FOREIGN_HOOK], 'foreign hooks must survive untouched');
  assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] }, 'non-hook settings must survive');
  assert.equal(after.hooks.SessionStart, undefined, 'events that only held our hooks are dropped');
});

test('uninstall --purge deletes the data directory; plain uninstall keeps it', () => {
  const cwd = project();
  init(cwd);
  assert.ok(existsSync(join(cwd, '.regressionledger')));

  const kept = uninstall(cwd);
  assert.equal(kept.purged, false);
  assert.ok(existsSync(join(cwd, '.regressionledger')), 'without --purge the ledger stays');

  const purged = uninstall(cwd, { purge: true });
  assert.equal(purged.purged, true);
  assert.ok(!existsSync(join(cwd, '.regressionledger')), '--purge removes the data directory');
});

test('uninstall refuses to touch an unparseable settings.json', () => {
  const cwd = project();
  const settingsPath = join(cwd, '.claude', 'settings.json');
  writeFileSync(settingsPath, '{ this is not json');
  assert.throws(() => uninstall(cwd), (err) => err.code === 'RL_SETTINGS_UNPARSEABLE');
  assert.equal(readFileSync(settingsPath, 'utf8'), '{ this is not json', 'the broken file is untouched');
});

test('uninstall on a project that never had RegressionLedger is a safe no-op', () => {
  const cwd = project();
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [FOREIGN_HOOK] } }, null, 2)
  );
  const res = uninstall(cwd);
  assert.equal(res.removedHooks, 0);
  const after = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(after.hooks.PreToolUse, [FOREIGN_HOOK]);
});

test('init then uninstall is fully symmetric on a fresh project', () => {
  const cwd = project();
  init(cwd);
  const res = uninstall(cwd, { purge: true });
  assert.ok(res.removedHooks > 0);
  const after = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.hooks, undefined, 'an empty hooks object is removed entirely');
  assert.ok(!existsSync(join(cwd, '.regressionledger')));
});
