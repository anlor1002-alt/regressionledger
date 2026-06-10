// Command-line surface + hook entry point.
//   rl init [--warn] [--print]   wire hooks into .claude/settings.json
//   rl show [file]               show attempt history (the shareable artifact)
//   rl list [--json]             flat list of attempts
//   rl stats                     summary counts
//   rl config [key value]        view / change settings
//   rl clear --force             wipe the ledger
//   rl hook <pretooluse|posttooluse>   (invoked BY Claude Code, reads stdin)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readStdin, color, debug } from './util.js';
import {
  resolveRoot,
  loadLedger,
  saveLedger,
  loadConfig,
  saveConfig,
  summarize,
  loadHits,
  DEFAULT_CONFIG,
} from './ledger.js';
import { handlePreToolUse, handlePostToolUse } from './hooks.js';
import { init, buildHookConfig } from './install.js';
import { runDoctor } from './doctor.js';

function version() {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const HELP = `${color.bold('RegressionLedger')} — stop your coding agent from resurrecting fixes that already failed.

${color.bold('Usage')}
  rl init [--warn] [--print]   Install the Claude Code hooks into ./.claude/settings.json
  rl doctor                    Verify the install: env, wiring, and live hook round-trips
  rl show [file]               Show the attempt history (great for sharing/debugging)
  rl list [--json]             Flat list of every recorded attempt
  rl stats                     Summary counts, including blocked / would-have-blocked hits
  rl config [key value]        View or change settings (mode, threshold, minFailures, crossSymbol, maxLedger)
  rl clear --force             Erase the ledger
  rl hook <event>              Internal: invoked by Claude Code (reads JSON on stdin)

${color.bold('Modes')}
  block (default)  Hard-deny re-applying a fix that previously failed.
  warn             Allow it, but inject a warning to the agent.

${color.dim('Docs: https://github.com/anlor1002-alt/regressionledger')}`;

function icon(outcome) {
  if (outcome === 'fail') return color.red('✗ FAIL');
  if (outcome === 'pass') return color.green('✓ PASS');
  return color.yellow('… pending');
}

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function cmdShow(args) {
  const root = resolveRoot();
  const filter = args.find((a) => !a.startsWith('-'));
  const ledger = loadLedger(root);
  let attempts = ledger.attempts;
  if (filter) attempts = attempts.filter((a) => a.file.includes(filter));

  console.log(`${color.bold('RegressionLedger')} ${color.dim(`· ${root}`)}\n`);
  if (!attempts.length) {
    console.log(color.dim('  No attempts recorded yet.'));
    return 0;
  }

  const byFile = new Map();
  for (const a of attempts) {
    if (!byFile.has(a.file)) byFile.set(a.file, new Map());
    const bySym = byFile.get(a.file);
    if (!bySym.has(a.symbol)) bySym.set(a.symbol, []);
    bySym.get(a.symbol).push(a);
  }

  for (const [file, bySym] of byFile) {
    console.log(color.cyan(file));
    for (const [sym, list] of bySym) {
      console.log(`  ${color.bold(sym)}`);
      list.sort((x, y) => x.ts - y.ts);
      for (const a of list) {
        const sig = a.errorSignature ? `  ${color.dim(a.errorSignature)}` : '';
        console.log(`    ${icon(a.outcome)}  ${color.gray(ago(a.ts))}${sig}`);
        if (a.preview) console.log(`        ${color.dim(a.preview)}`);
      }
    }
    console.log('');
  }

  const s = summarize(root);
  console.log(
    color.dim(
      `${s.total} attempts · ${color.red(s.fail + ' failed')} · ` +
        `${color.green(s.pass + ' passed')} · ${color.yellow(s.pending + ' pending')}`
    )
  );
  return 0;
}

function cmdList(args) {
  const root = resolveRoot();
  const ledger = loadLedger(root);
  if (args.includes('--json')) {
    console.log(JSON.stringify(ledger.attempts, null, 2));
    return 0;
  }
  for (const a of ledger.attempts) {
    console.log(
      `${icon(a.outcome)}  ${color.cyan(a.file)} ${color.bold(a.symbol)} ` +
        `${color.gray(ago(a.ts))} ${color.dim(a.intentHash.slice(0, 8))}`
    );
  }
  return 0;
}

function cmdStats() {
  const root = resolveRoot();
  const s = summarize(root);
  const hits = loadHits(root);
  const blocked = hits.filter((h) => h.mode === 'block').length;
  const warned = hits.filter((h) => h.mode === 'warn').length;
  console.log(`${color.bold('RegressionLedger stats')}`);
  console.log(`  attempts : ${s.total}`);
  console.log(`  ${color.green('passed')}   : ${s.pass}`);
  console.log(`  ${color.red('failed')}   : ${s.fail}`);
  console.log(`  ${color.yellow('pending')}  : ${s.pending}`);
  console.log(`  files    : ${s.files}`);
  console.log(`  ${color.red('blocked repeat fixes')}        : ${blocked}`);
  console.log(`  ${color.yellow('would-have-blocked (warn)')}  : ${warned}`);
  if (warned > 0) {
    console.log(color.dim(`  Review them with \`rl show\`, then enable hard-block: rl config mode block`));
  }
  return 0;
}

function cmdDoctor() {
  console.log(`${color.bold('RegressionLedger doctor')}\n`);
  const checks = runDoctor(process.cwd());
  let failed = 0;
  for (const c of checks) {
    const mark =
      c.status === 'pass' ? color.green('✓') : c.status === 'warn' ? color.yellow('!') : color.red('✗');
    if (c.status === 'fail') failed++;
    console.log(`  ${mark} ${c.name}`);
    console.log(`      ${color.dim(c.detail)}`);
  }
  console.log('');
  if (failed) {
    console.log(color.red(`${failed} check(s) failed.`));
    return 1;
  }
  console.log(color.green('All checks passed — the guardrail works end-to-end on this machine.'));
  return 0;
}

function cmdConfig(args) {
  const root = resolveRoot();
  const config = loadConfig(root);
  const [key, value] = args;
  if (!key) {
    for (const k of Object.keys(DEFAULT_CONFIG)) console.log(`  ${k} = ${config[k]}`);
    return 0;
  }
  if (!(key in DEFAULT_CONFIG)) {
    console.error(color.red(`Unknown key "${key}". Valid: ${Object.keys(DEFAULT_CONFIG).join(', ')}`));
    return 1;
  }
  if (value === undefined) {
    console.log(`${key} = ${config[key]}`);
    return 0;
  }
  let parsed = value;
  if (key === 'threshold') parsed = Number(value);
  else if (key === 'maxLedger' || key === 'minFailures') parsed = parseInt(value, 10);
  else if (key === 'crossSymbol') parsed = value === 'true';
  else if (key === 'mode' && !['block', 'warn'].includes(value)) {
    console.error(color.red('mode must be "block" or "warn"'));
    return 1;
  }
  config[key] = parsed;
  saveConfig(root, config);
  console.log(color.green(`set ${key} = ${parsed}`));
  return 0;
}

function cmdClear(args) {
  if (!args.includes('--force')) {
    console.error(color.yellow('Refusing to clear without --force. Run: rl clear --force'));
    return 1;
  }
  const root = resolveRoot();
  saveLedger(root, { version: 1, attempts: [] });
  console.log(color.green('Ledger cleared.'));
  return 0;
}

function cmdInit(args) {
  if (args.includes('--print')) {
    console.log(JSON.stringify({ hooks: buildHookConfig() }, null, 2));
    return 0;
  }
  const mode = args.includes('--warn') ? 'warn' : undefined;
  const res = init(process.cwd(), { mode });
  console.log(`${color.green('✓')} RegressionLedger installed.`);
  console.log(`  hooks   → ${res.settingsPath}`);
  console.log(`  ledger  → ${res.root}`);
  console.log(`  mode    → ${res.config.mode}`);
  if (res.gitignoreUpdated) console.log(`  ${color.dim('added .regressionledger/ledger.json to .gitignore')}`);
  console.log(`\n${color.dim('Restart Claude Code (or run /hooks) so it picks up the new hooks.')}`);
  return 0;
}

async function cmdHook(args) {
  // Invoked by Claude Code. Read the JSON event from stdin, dispatch, and print
  // ONLY the hook's JSON response to stdout. Fail open on any error.
  const event = (args[0] || '').toLowerCase();
  try {
    const raw = await readStdin();
    const input = raw ? JSON.parse(raw) : {};
    const result =
      event === 'pretooluse'
        ? handlePreToolUse(input)
        : event === 'posttooluse'
          ? handlePostToolUse(input)
          : { exit: 0 };
    if (result.json) process.stdout.write(JSON.stringify(result.json));
    return result.exit ?? 0;
  } catch (err) {
    debug('hook error (failing open):', err && err.stack ? err.stack : err);
    return 0; // never break the agent because of our own bug
  }
}

export async function main(argv) {
  const [cmd, ...args] = argv;

  if (cmd === '-v' || cmd === '--version') {
    console.log(version());
    return 0;
  }
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(HELP);
    return 0;
  }

  switch (cmd) {
    case 'hook':
      return cmdHook(args);
    case 'init':
      return cmdInit(args);
    case 'show':
      return cmdShow(args);
    case 'list':
      return cmdList(args);
    case 'stats':
      return cmdStats();
    case 'doctor':
      return cmdDoctor();
    case 'config':
      return cmdConfig(args);
    case 'clear':
      return cmdClear(args);
    default:
      console.error(color.red(`Unknown command "${cmd}".`));
      console.log(HELP);
      return 1;
  }
}
