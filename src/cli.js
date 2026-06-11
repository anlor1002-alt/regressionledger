// Command-line surface + hook entry point.
//   rl init [--warn] [--print]   wire hooks into .claude/settings.json
//   rl show [file]               show attempt history (the shareable artifact)
//   rl list [--json]             flat list of attempts
//   rl stats                     summary counts
//   rl config [key value]        view / change settings
//   rl clear --force             wipe the ledger
//   rl hook <pretooluse|posttooluse>   (invoked BY Claude Code, reads stdin)

import { readFileSync, writeFileSync } from 'node:fs';
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
  unblockAttempts,
  importAttempts,
  DEFAULT_CONFIG,
} from './ledger.js';
import { handlePreToolUse, handlePostToolUse, handleSessionStart } from './hooks.js';
import { init, buildHookConfig } from './install.js';
import { runDoctor } from './doctor.js';
import { buildReportData, renderMarkdown, renderHtml, groupByError } from './report.js';
import { explainOutcome } from './outcome.js';

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
  rl doctor --explain "<out>"  Show how a test/build output gets classified (and by which pattern)
  rl why <file>                Plain-language summary: what was tried here and how it went
  rl show [file] [--by-error]  Attempt history; --by-error clusters failures by error signature
  rl report [--html [file]]    Shareable report: markdown to stdout, or a self-contained HTML file
  rl list [--json]             Flat list of every recorded attempt
  rl stats [--card]            Summary counts; --card prints a shareable screenshot card
  rl config [key value]        View or change settings (mode, threshold, minFailures, crossSymbol, maxLedger)
  rl unblock <file> [hash]     Retire recorded failures for a file (the context truly changed)
  rl export [file]             Export settled attempts to share (herd immunity)
  rl import <file>             Merge a teammate's export — their dead ends block here too
  rl clear --force             Erase the ledger
  rl hook <event>              Internal: invoked by Claude Code (reads JSON on stdin)

${color.bold('Modes')}
  block (default)  Hard-deny re-applying a fix that previously failed.
  warn             Allow it, but inject a warning to the agent.

${color.dim('Docs: https://github.com/anlor1002-alt/regressionledger')}`;

function icon(outcome) {
  if (outcome === 'fail') return color.red('✗ FAIL');
  if (outcome === 'pass') return color.green('✓ PASS');
  if (outcome === 'retired') return color.gray('∅ retired');
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

function cmdShowByError(root) {
  const groups = groupByError(root);
  console.log(`${color.bold('RegressionLedger')} ${color.dim('· failures clustered by error signature')}\n`);
  if (!groups.length) {
    console.log(color.dim('  No failed attempts recorded yet.'));
    return 0;
  }
  for (const g of groups) {
    console.log(`${color.red(color.bold(`${g.count}×`))}  ${color.bold(g.signature)}`);
    console.log(`    ${color.dim(`across ${g.files.length} file(s):`)} ${g.files.map((f) => color.cyan(f)).join(', ')}`);
    for (const a of g.attempts) {
      console.log(`      ${color.gray(ago(a.ts))} ${color.cyan(a.file)} ${color.bold(a.symbol)}`);
      if (a.preview) console.log(`        ${color.dim(a.preview)}`);
    }
    console.log('');
  }
  console.log(color.dim('Same signature across multiple attempts = you keep hitting the same wall. Step back and question the diagnosis, not the patch.'));
  return 0;
}

function cmdShow(args) {
  const root = resolveRoot();
  if (args.includes('--by-error')) return cmdShowByError(root);
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

function cmdStatsCard(s, blocked, warned) {
  const W = 46;
  const top = '╭' + '─'.repeat(W) + '╮';
  const bot = '╰' + '─'.repeat(W) + '╯';
  const row = (text) => {
    // pad by VISIBLE length: strip ANSI codes, count wide emoji as 2 columns
    const plain = String(text).replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
    const wide = (plain.match(/[⛔⚠]/g) || []).length;
    const len = [...plain].length + wide;
    return '│ ' + text + ' '.repeat(Math.max(0, W - 2 - len)) + ' │';
  };
  const lines = [
    top,
    row(color.bold('RegressionLedger')),
    row(''),
    row(`${color.red('⛔ ' + blocked)} repeat fix${blocked === 1 ? '' : 'es'} blocked`),
    row(`${color.yellow('⚠ ' + warned)} would-have-blocked (warn mode)`),
    row(`${color.dim(`${s.total} attempts · ${s.fail} failed · ${s.pass} passed`)}`),
    row(''),
    row(color.dim('every block = a failing test cycle')),
    row(color.dim('that never had to run')),
    bot,
    color.dim('  github.com/anlor1002-alt/regressionledger'),
  ];
  console.log(lines.join('\n'));
  return 0;
}

function cmdStats(args = []) {
  const root = resolveRoot();
  const s = summarize(root);
  const hits = loadHits(root);
  const blocked = hits.filter((h) => h.mode === 'block').length;
  const warned = hits.filter((h) => h.mode === 'warn').length;
  if (args.includes('--card')) return cmdStatsCard(s, blocked, warned);
  console.log(`${color.bold('RegressionLedger stats')}`);
  console.log(`  attempts : ${s.total}`);
  console.log(`  ${color.green('passed')}   : ${s.pass}`);
  console.log(`  ${color.red('failed')}   : ${s.fail}`);
  console.log(`  ${color.yellow('pending')}  : ${s.pending}`);
  console.log(`  files    : ${s.files}`);
  const noted = hits.filter((h) => h.mode === 'note').length;
  console.log(`  ${color.red('blocked repeat fixes')}        : ${blocked}`);
  console.log(`  ${color.yellow('would-have-blocked (warn)')}  : ${warned}`);
  console.log(`  ${color.cyan('paraphrase notes')}           : ${noted}`);
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

function cmdReport(args) {
  const root = resolveRoot();
  const data = buildReportData(root);
  const htmlIdx = args.indexOf('--html');
  if (htmlIdx === -1) {
    console.log(renderMarkdown(data));
    return 0;
  }
  const out = args[htmlIdx + 1] && !args[htmlIdx + 1].startsWith('-')
    ? args[htmlIdx + 1]
    : 'regressionledger-report.html';
  writeFileSync(out, renderHtml(data));
  console.log(`${color.green('✓')} Report written to ${color.bold(out)}`);
  return 0;
}

function cmdWhy(args) {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) {
    console.error(color.red('Usage: rl why <file>'));
    return 1;
  }
  const root = resolveRoot();
  const attempts = loadLedger(root).attempts.filter((a) => a.file.includes(file));
  console.log(`${color.bold('What have we tried in')} ${color.cyan(file)}${color.bold('?')}\n`);
  if (!attempts.length) {
    console.log(color.dim('  Nothing recorded yet — no edits to this file have been seen.'));
    return 0;
  }

  const fails = attempts.filter((a) => a.outcome === 'fail');
  const passes = attempts.filter((a) => a.outcome === 'pass');
  const retired = attempts.filter((a) => a.outcome === 'retired');
  const pending = attempts.filter((a) => a.outcome === 'pending');

  if (fails.length) {
    console.log(color.red(color.bold(`  ${fails.length} approach(es) failed and still block:`)));
    for (const a of fails) {
      console.log(`    ✗ ${ago(a.ts)} in ${color.bold(a.symbol)} — ${color.dim(a.preview || '(no preview)')}`);
      if (a.errorSignature) console.log(`      ${color.red('because:')} ${a.errorSignature}`);
    }
    // walls: same signature more than once
    const bySig = new Map();
    for (const a of fails) {
      const s = a.errorSignature || '(no signature)';
      bySig.set(s, (bySig.get(s) || 0) + 1);
    }
    const walls = [...bySig.entries()].filter(([, n]) => n > 1);
    if (walls.length) {
      console.log('');
      for (const [sig, n] of walls) {
        console.log(`  ${color.yellow('⚠ wall:')} ${n} different attempts all died on ${color.bold(sig)}`);
      }
      console.log(color.dim('    Multiple approaches, same error — question the diagnosis, not the patch.'));
    }
    console.log('');
  }
  if (retired.length) {
    console.log(color.gray(`  ${retired.length} old failure(s) retired:`));
    for (const a of retired) {
      const by = a.retiredBy === 'human' ? 'a human override (rl unblock)' : 'a later passing run';
      console.log(`    ∅ ${color.dim(`${a.preview || a.intentHash.slice(0, 8)} — retired by ${by}`)}`);
    }
    console.log('');
  }
  if (passes.length) {
    console.log(color.green(`  ${passes.length} attempt(s) passed verification:`));
    for (const a of passes) console.log(`    ✓ ${ago(a.ts)} in ${color.bold(a.symbol)} — ${color.dim(a.preview || '')}`);
    console.log('');
  }
  if (pending.length) {
    console.log(color.yellow(`  ${pending.length} attempt(s) still awaiting a test/build verdict.`));
    console.log('');
  }
  console.log(color.dim(`  Full history: rl show ${file} · clusters: rl show --by-error`));
  return 0;
}

async function cmdDoctorExplain(args) {
  const idx = args.indexOf('--explain');
  let text = args.slice(idx + 1).join(' ');
  if (!text) text = await readStdin();
  if (!text) {
    console.error(color.red('Usage: rl doctor --explain "<test output>"  (or pipe the output via stdin)'));
    return 1;
  }
  const r = explainOutcome(text);
  console.log(`${color.bold('Classification:')} ${r.outcome === 'fail' ? color.red('FAIL') : r.outcome === 'pass' ? color.green('PASS') : color.yellow('ambiguous (left pending)')}`);
  if (r.errorSignature) console.log(`${color.bold('Error signature:')} ${r.errorSignature}`);
  if (r.matches.length) {
    console.log(color.bold('Decided by:'));
    for (const m of r.matches) console.log(`  toolchain=${color.cyan(m.toolchain)} kind=${m.kind} pattern=${color.dim(m.pattern)}`);
  } else {
    console.log(color.dim('No pattern matched — RegressionLedger would leave the attempts pending rather than guess.'));
    console.log(color.dim('If this output is from a real test runner, please open an issue with it — adding runners is the canonical first PR.'));
  }
  return 0;
}

function cmdUnblock(args) {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) {
    console.error(color.red('Usage: rl unblock <file> [intentHash-prefix]'));
    return 1;
  }
  const hashPrefix = args.filter((a) => !a.startsWith('-'))[1] || '';
  const n = unblockAttempts(resolveRoot(), file, hashPrefix);
  if (!n) {
    console.log(color.yellow(`No blocking failures found for "${file}"${hashPrefix ? ` with hash ${hashPrefix}…` : ''}.`));
    return 0;
  }
  console.log(`${color.green('✓')} Retired ${n} failure record${n === 1 ? '' : 's'} for ${color.cyan(file)} — they will no longer block.`);
  console.log(color.dim('They remain visible in `rl show` as ∅ retired, with the receipt that a human made the call.'));
  return 0;
}

function cmdExport(args) {
  const root = resolveRoot();
  const out = args.find((a) => !a.startsWith('-')) || 'regressionledger-export.json';
  const attempts = loadLedger(root).attempts.filter((a) => a.outcome !== 'pending');
  writeFileSync(
    out,
    JSON.stringify({ version: 1, tool: 'regressionledger', attempts }, null, 2) + '\n'
  );
  console.log(`${color.green('✓')} Exported ${attempts.length} settled attempt(s) to ${color.bold(out)}`);
  console.log(color.dim('Share it with a teammate: rl import ' + out + ' — their agent inherits your dead ends.'));
  return 0;
}

function cmdImport(args) {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) {
    console.error(color.red('Usage: rl import <export-file.json>'));
    return 1;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    console.error(color.red(`Cannot read ${file}: ${err.message}`));
    return 1;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.attempts)) {
    console.error(color.red(`${file} is not a RegressionLedger export (missing "attempts" array).`));
    return 1;
  }
  const { added, skipped } = importAttempts(resolveRoot(), data.attempts, file);
  console.log(`${color.green('✓')} Imported ${added} attempt(s) (${skipped} duplicate/invalid skipped).`);
  if (added) console.log(color.dim('Failures from this import now block here too — herd immunity.'));
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
  let res;
  try {
    res = init(process.cwd(), { mode });
  } catch (err) {
    if (err && err.code === 'RL_SETTINGS_UNPARSEABLE') {
      console.error(color.red('✗ ' + err.message));
      return 1;
    }
    throw err;
  }
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
          : event === 'sessionstart'
            ? handleSessionStart(input)
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
      return cmdStats(args);
    case 'doctor':
      return args.includes('--explain') ? cmdDoctorExplain(args) : cmdDoctor();
    case 'why':
      return cmdWhy(args);
    case 'report':
      return cmdReport(args);
    case 'unblock':
      return cmdUnblock(args);
    case 'export':
      return cmdExport(args);
    case 'import':
      return cmdImport(args);
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
