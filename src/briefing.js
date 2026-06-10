// The session briefing: when a session starts (including right after context
// compaction wipes the agent's memory), inject a compact "what already failed
// here" brief. The agent wakes up knowing its dead ends — failures get blocked
// before they're even re-conceived, not just at edit time.

import { loadLedger } from './ledger.js';
import { groupByError } from './report.js';

const MAX_CHARS = 8500; // stay safely under the 10K hook-output cap

/**
 * Build the briefing text for a project, or null when there is nothing worth
 * saying (no recorded failures — don't waste context on an empty ledger).
 */
export function buildBriefing(root) {
  const ledger = loadLedger(root);
  const fails = ledger.attempts.filter((a) => a.outcome === 'fail');
  if (!fails.length) return null;

  const lines = [];
  lines.push('RegressionLedger briefing — fixes that ALREADY FAILED in this project (do not re-attempt them):');
  lines.push('');

  // Dead ends, grouped by file, newest first, capped.
  const byFile = new Map();
  for (const a of fails) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file).push(a);
  }
  let fileCount = 0;
  for (const [file, attempts] of byFile) {
    if (fileCount++ >= 10) {
      lines.push(`…and failures in ${byFile.size - 10} more file(s). Run \`rl show\` for the full ledger.`);
      break;
    }
    attempts.sort((x, y) => y.ts - x.ts);
    lines.push(`${file}:`);
    for (const a of attempts.slice(0, 4)) {
      const sig = a.errorSignature ? ` → ${a.errorSignature}` : '';
      lines.push(`  ✗ ${a.symbol !== '(file scope)' ? a.symbol + '(): ' : ''}${a.preview || a.intentHash.slice(0, 10)}${sig}`);
    }
    if (attempts.length > 4) lines.push(`  …and ${attempts.length - 4} more failed attempt(s) here.`);
  }

  // Walls: the same error signature across multiple distinct attempts.
  const walls = groupByError(root).filter((g) => g.count > 1);
  if (walls.length) {
    lines.push('');
    lines.push('WALLS (multiple different attempts, same error — the diagnosis is wrong, not the patch):');
    for (const w of walls.slice(0, 5)) {
      lines.push(`  ${w.count}× ${w.signature} — across ${w.files.join(', ')}`);
    }
  }

  lines.push('');
  lines.push(
    'These edits will be denied if re-applied. Before fixing in these areas, run `rl why <file>` ' +
      'to see what was tried and why it failed. New approaches are welcome; resurrections are not.'
  );

  let text = lines.join('\n');
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS - 60) + '\n…(briefing truncated; run `rl show` for everything)';
  return text;
}

/**
 * Detect a "thrash wall" for escalation: >= minDistinct DISTINCT failed
 * intents sharing one error signature. Returns the worst wall or null.
 */
export function detectThrashWall(root, minDistinct = 3) {
  const walls = groupByError(root);
  let worst = null;
  for (const w of walls) {
    const distinct = new Set(w.attempts.map((a) => a.intentHash)).size;
    if (distinct >= minDistinct && (!worst || distinct > worst.distinct)) {
      worst = { signature: w.signature, distinct, files: w.files };
    }
  }
  return worst;
}
