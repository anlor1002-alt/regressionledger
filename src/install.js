// `rl init`: wire the hooks into the project's .claude/settings.json, create the
// local ledger, and keep the raw history out of git. Idempotent — re-running
// refreshes the RegressionLedger entries without disturbing other hooks.

import { existsSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
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
    session: `node "${bin}" hook sessionstart`,
  };
}

// Sentinel thrown when settings.json exists but cannot be parsed. Swallowing
// the error and returning {} would clobber the user's real settings (hooks,
// permissions, env) on the next write — the README promises "merging, not
// clobbering", so an unparseable file must STOP init, not overwrite it.
export class SettingsParseError extends Error {}

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SettingsParseError('settings.json is not a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new SettingsParseError(err.message);
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
  const { pre, post, session } = commands();
  return {
    PreToolUse: [
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: pre }] },
    ],
    PostToolUse: [
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: post }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: post }] },
    ],
    SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: session }] }],
  };
}

function ensureGitignore(cwd) {
  const giPath = join(cwd, '.gitignore');
  const block = [
    '',
    '# RegressionLedger — local attempt history (config.json is safe to commit)',
    '.regressionledger/ledger.json',
    '.regressionledger/hits.json',
    '.regressionledger/*.tmp-*',
    '.regressionledger/.lock',
    '',
  ].join('\n');
  let current = '';
  if (existsSync(giPath)) current = readFileSync(giPath, 'utf8');
  if (current.includes('.regressionledger/ledger.json')) return false;
  atomicWrite(giPath, current + (current.endsWith('\n') || current === '' ? '' : '\n') + block);
  return true;
}

/** Count RegressionLedger hook entries inside one event's group array. */
function countOurEntries(eventArr) {
  if (!Array.isArray(eventArr)) return 0;
  let n = 0;
  for (const group of eventArr) {
    if (!group || !Array.isArray(group.hooks)) continue;
    n += group.hooks.filter(
      (h) => h && typeof h.command === 'string' && h.command.includes(MARKER)
    ).length;
  }
  return n;
}

/**
 * `rl uninstall`: the symmetric exit. Removes exactly the RegressionLedger hook
 * entries from .claude/settings.json (never touching anything else), and with
 * `purge` also deletes the local .regressionledger/ data directory.
 *
 * @param {string} cwd project root
 * @param {{purge?:boolean}} opts
 * @returns {{settingsPath:string, settingsExisted:boolean, removedHooks:number, purged:boolean, purgedDir:string|null}}
 */
export function uninstall(cwd = process.cwd(), opts = {}) {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  const result = {
    settingsPath,
    settingsExisted: existsSync(settingsPath),
    removedHooks: 0,
    purged: false,
    purgedDir: null,
  };

  if (result.settingsExisted) {
    // Same rule as init: an unparseable settings.json is never overwritten.
    let settings;
    try {
      settings = readSettings(settingsPath);
    } catch (err) {
      if (err instanceof SettingsParseError) {
        const e = new Error(
          `Refusing to touch ${settingsPath}: it isn't valid JSON (${err.message}). ` +
            `Fix the JSON and re-run \`rl uninstall\`, or remove the entries whose ` +
            `command mentions "${MARKER}" by hand.`
        );
        e.code = 'RL_SETTINGS_UNPARSEABLE';
        throw e;
      }
      throw err;
    }

    if (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) {
      for (const event of Object.keys(settings.hooks)) {
        const ours = countOurEntries(settings.hooks[event]);
        if (!ours) continue;
        result.removedHooks += ours;
        const cleaned = stripOurEntries(settings.hooks[event]);
        if (cleaned.length) settings.hooks[event] = cleaned;
        else delete settings.hooks[event];
      }
      if (result.removedHooks) {
        if (!Object.keys(settings.hooks).length) delete settings.hooks;
        atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      }
    }
  }

  if (opts.purge) {
    const dir = resolveRoot(cwd);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      result.purged = true;
      result.purgedDir = dir;
    }
  }

  return result;
}

/**
 * @param {string} cwd project root
 * @param {{mode?:string}} opts
 * @returns {{settingsPath:string, root:string, gitignoreUpdated:boolean}}
 */
export function init(cwd = process.cwd(), opts = {}) {
  const root = resolveRoot(cwd);
  const { configPath, ledgerPath } = getPaths(root);
  const settingsPath = join(cwd, '.claude', 'settings.json');

  // Parse the existing settings BEFORE writing anything. If it exists but is
  // unparseable, back it up and refuse — never clobber a file we couldn't read.
  let settings;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    if (err instanceof SettingsParseError) {
      const backup = `${settingsPath}.broken-${Date.now()}.bak`;
      try {
        copyFileSync(settingsPath, backup);
      } catch {}
      const e = new Error(
        `Refusing to overwrite ${settingsPath}: it isn't valid JSON (${err.message}). ` +
          `A copy was saved to ${backup}. Fix the JSON and re-run \`rl init\`, ` +
          `or use \`rl init --print\` to add the hooks block by hand.`
      );
      e.code = 'RL_SETTINGS_UNPARSEABLE';
      throw e;
    }
    throw err;
  }

  // Only after we know settings is safe: seed config + ledger.
  const config = loadConfig(root);
  if (opts.mode) config.mode = opts.mode;
  saveConfig(root, config);
  if (!existsSync(ledgerPath)) saveLedger(root, loadLedger(root));

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
