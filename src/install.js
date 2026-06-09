// `rl init`: wire the hooks into the project's .claude/settings.json, create the
// local ledger, and keep the raw history out of git. Idempotent — re-running
// refreshes the RegressionLedger entries without disturbing other hooks.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { atomicWrite } from './util.js';
import { resolveRoot, getPaths, loadConfig, saveConfig, loadLedger, saveLedger } from './ledger.js';

const MARKER = 'regressionledger';

/** Absolute, forward-slashed path to the installed CLI entry. */
export function binPath() {
  const here = dirname(fileURLToPath(import.meta.url)); // .../src
  return resolve(here, '..', 'bin', 'regressionledger.js').split('\\').join('/');
}

function commands() {
  const bin = binPath();
  return {
    pre: `node "${bin}" hook pretooluse`,
    post: `node "${bin}" hook posttooluse`,
  };
}

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

/** Strip any previously-installed RegressionLedger entries from an event array. */
function stripOurEntries(eventArr) {
  if (!Array.isArray(eventArr)) return [];
  const cleaned = [];
  for (const group of eventArr) {
    if (!group || !Array.isArray(group.hooks)) {
      cleaned.push(group);
      continue;
    }
    const hooks = group.hooks.filter(
      (h) => !(h && typeof h.command === 'string' && h.command.includes(MARKER))
    );
    if (hooks.length) cleaned.push({ ...group, hooks });
  }
  return cleaned;
}

export function buildHookConfig() {
  const { pre, post } = commands();
  return {
    PreToolUse: [
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: pre }] },
    ],
    PostToolUse: [
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: post }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: post }] },
    ],
  };
}

function ensureGitignore(cwd) {
  const giPath = join(cwd, '.gitignore');
  const block = [
    '',
    '# RegressionLedger — local attempt history (config.json is safe to commit)',
    '.regressionledger/ledger.json',
    '.regressionledger/*.tmp-*',
    '',
  ].join('\n');
  let current = '';
  if (existsSync(giPath)) current = readFileSync(giPath, 'utf8');
  if (current.includes('.regressionledger/ledger.json')) return false;
  atomicWrite(giPath, current + (current.endsWith('\n') || current === '' ? '' : '\n') + block);
  return true;
}

/**
 * @param {string} cwd project root
 * @param {{mode?:string}} opts
 * @returns {{settingsPath:string, root:string, gitignoreUpdated:boolean}}
 */
export function init(cwd = process.cwd(), opts = {}) {
  const root = resolveRoot(cwd);
  const { configPath, ledgerPath } = getPaths(root);

  // Seed config + ledger if absent; honor a requested mode.
  const config = loadConfig(root);
  if (opts.mode) config.mode = opts.mode;
  saveConfig(root, config);
  if (!existsSync(ledgerPath)) saveLedger(root, loadLedger(root));

  // Merge hooks into .claude/settings.json.
  const settingsPath = join(cwd, '.claude', 'settings.json');
  const settings = readSettings(settingsPath);
  settings.hooks = settings.hooks || {};
  const ours = buildHookConfig();
  for (const event of Object.keys(ours)) {
    const existing = stripOurEntries(settings.hooks[event]);
    settings.hooks[event] = existing.concat(ours[event]);
  }
  atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  const gitignoreUpdated = ensureGitignore(cwd);

  return { settingsPath, root, configPath, gitignoreUpdated, config };
}
