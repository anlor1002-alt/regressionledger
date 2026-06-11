// `rl doctor` — proves the installation actually works instead of hoping.
// Beyond static checks, it spawns the real hook entry as a child process and
// round-trips synthetic PreToolUse events through it: one that must be ALLOWED
// and one (seeded with a prior failure) that must be DENIED. If those pass,
// the wiring works end-to-end on this exact machine, node, and shell.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRoot, loadConfig, addAttempt, resolvePending, DEFAULT_CONFIG } from './ledger.js';
import { fingerprint } from './fingerprint.js';
import { binPath } from './install.js';

const SNIPPET = 'return doctorProbe(value) && verifyAll(value);';

function runHook(event, input, env) {
  return spawnSync(process.execPath, [binPath(), 'hook', event], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
  });
}

/**
 * Run all checks. Returns [{name, status: 'pass'|'warn'|'fail', detail}].
 */
export function runDoctor(cwd = process.cwd()) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // 1. Node version
  const major = parseInt(process.versions.node.split('.')[0], 10);
  add(
    'Node.js >= 18',
    major >= 18 ? 'pass' : 'fail',
    `running ${process.versions.node}`
  );

  // 2. Ledger directory writable
  const root = resolveRoot(cwd);
  try {
    mkdirSync(root, { recursive: true });
    const probe = join(root, `.doctor-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    add('Ledger directory writable', 'pass', root);
  } catch (err) {
    add('Ledger directory writable', 'fail', `${root}: ${err.message}`);
  }

  // 3. Config sanity
  try {
    const config = loadConfig(root);
    const issues = [];
    if (!['block', 'warn'].includes(config.mode)) issues.push(`mode "${config.mode}"`);
    if (!(config.threshold > 0 && config.threshold <= 1)) issues.push(`threshold ${config.threshold}`);
    if (!(config.minFailures >= 1)) issues.push(`minFailures ${config.minFailures}`);
    add(
      'Config valid',
      issues.length ? 'fail' : 'pass',
      issues.length ? `invalid: ${issues.join(', ')}` : `mode=${config.mode} threshold=${config.threshold} minFailures=${config.minFailures}`
    );
  } catch (err) {
    add('Config valid', 'fail', err.message);
  }

  // 4. Hook wiring in this project (plugin installs won't show here — that's fine)
  try {
    const settingsPath = join(cwd, '.claude', 'settings.json');
    if (existsSync(settingsPath) && readFileSync(settingsPath, 'utf8').includes('regressionledger')) {
      add('Hooks wired in .claude/settings.json', 'pass', settingsPath);
    } else {
      add(
        'Hooks wired in .claude/settings.json',
        'warn',
        'not found here — fine if installed as a Claude Code plugin; otherwise run `rl init`'
      );
    }
  } catch (err) {
    add('Hooks wired in .claude/settings.json', 'warn', err.message);
  }

  // 5 & 6. Live round-trips through the real hook process, in an isolated
  // temp ledger so the project's real history is untouched.
  const sandbox = mkdtempSync(join(tmpdir(), 'rl-doctor-'));
  const sandboxRoot = join(sandbox, '.regressionledger');
  try {
    const editInput = {
      tool_name: 'Edit',
      cwd: sandbox,
      session_id: 'doctor',
      tool_input: { file_path: join(sandbox, 'doctor-probe.js'), old_string: 'x', new_string: SNIPPET },
    };

    // 5: a first-time edit must be ALLOWED (exit 0, no deny on stdout)
    const allow = runHook('pretooluse', editInput, { RL_DIR: sandboxRoot });
    const allowOk = allow.status === 0 && !(allow.stdout || '').includes('"deny"');
    add(
      'Live hook round-trip (allow)',
      allowOk ? 'pass' : 'fail',
      allowOk ? 'first-time edit passes through' : `exit=${allow.status} stdout=${(allow.stdout || '').slice(0, 120)}`
    );

    // 6: seed a failed attempt for the same fix — it must now be DENIED
    const fp = fingerprint({ filePath: 'doctor-probe.js', changedCode: SNIPPET });
    addAttempt(sandboxRoot, {
      session: 'doctor',
      file: 'doctor-probe.js',
      symbol: fp.symbol,
      intentHash: fp.intentHash,
      rawHash: fp.rawHash,
      tokens: fp.tokens,
      preview: SNIPPET,
      tool: 'Edit',
    });
    resolvePending(sandboxRoot, 'doctor', 'fail', 'DoctorProbeError: synthetic failure');

    const denyRes = runHook('pretooluse', editInput, { RL_DIR: sandboxRoot });
    let denied = false;
    try {
      const parsed = JSON.parse(denyRes.stdout || '{}');
      denied = parsed?.hookSpecificOutput?.permissionDecision === 'deny';
    } catch {
      denied = false;
    }
    add(
      'Live hook round-trip (block)',
      denied ? 'pass' : 'fail',
      denied
        ? 'a repeat failed fix is correctly denied'
        : `exit=${denyRes.status} stdout=${(denyRes.stdout || '(empty)').slice(0, 120)}`
    );
  } catch (err) {
    add('Live hook round-trip', 'fail', err.message);
  } finally {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {}
  }

  return checks;
}

export { DEFAULT_CONFIG };
