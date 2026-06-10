import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/doctor.js';

delete process.env.RL_DIR;

test('doctor passes end-to-end in a wired project', { timeout: 60000 }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rl-doctor-proj-'));
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node regressionledger.js' }] }] } })
  );

  const checks = runDoctor(cwd);
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

  assert.equal(byName['Node.js >= 18'].status, 'pass');
  assert.equal(byName['Ledger directory writable'].status, 'pass');
  assert.equal(byName['Config valid'].status, 'pass');
  assert.equal(byName['Hooks wired in .claude/settings.json'].status, 'pass');
  assert.equal(byName['Live hook round-trip (allow)'].status, 'pass', byName['Live hook round-trip (allow)']?.detail);
  assert.equal(byName['Live hook round-trip (block)'].status, 'pass', byName['Live hook round-trip (block)']?.detail);
});

test('doctor warns (not fails) when hooks are not wired in the project', { timeout: 60000 }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rl-doctor-bare-'));
  const checks = runDoctor(cwd);
  const wiring = checks.find((c) => c.name === 'Hooks wired in .claude/settings.json');
  assert.equal(wiring.status, 'warn');
  assert.ok(checks.every((c) => c.status !== 'fail'), 'no hard failures in a bare dir');
});
