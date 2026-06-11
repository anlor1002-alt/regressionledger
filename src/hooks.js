// The hook brains. Two entry points wired to Claude Code:
//   - PreToolUse  on Edit|Write|MultiEdit  -> maybe BLOCK a repeat failed fix
//   - PostToolUse on Edit|Write|MultiEdit  -> RECORD the applied edit (pending)
//   - PostToolUse on Bash                  -> RESOLVE pending attempts pass/fail
//
// Each handler returns a plain descriptor { json?, exit } that the CLI prints.
// Handlers never throw to the caller — a guardrail that crashes the agent it is
// meant to protect would be worse than useless, so the CLI also fails open.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fingerprint, structureTokens } from './fingerprint.js';
import { tokenSimilarity } from './similarity.js';
import { buildBriefing, detectThrashWall } from './briefing.js';
import {
  resolveRoot,
  loadConfig,
  loadLedger,
  addAttempt,
  resolvePending,
  findSimilarFailure,
  recordHit,
} from './ledger.js';
import { isVerificationCommand, detectOutcome } from './outcome.js';
import { truncate, debug, sanitizeForContext } from './util.js';

// Render an attempt's error signature for injection into agent context:
// neutralized structurally, and labeled when it arrived via `rl import`
// (cross-machine ledgers are an untrusted channel — the text is data).
function renderSig(attempt) {
  const sig = sanitizeForContext(attempt.errorSignature, 200);
  if (!sig) return '';
  return attempt.importedFrom ? `${sig} [imported verdict]` : sig;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return undefined;
}

/**
 * Normalize the various tool_input shapes into a common form. Field names are
 * accepted defensively (old_string/old_text, content/file_text) so the hook
 * keeps working across Claude Code versions.
 * @returns {{filePath:string|undefined, changes:Array<{newCode:string, oldCode:string}>}}
 */
export function extractEdits(toolName, toolInput = {}) {
  const rawPath = pick(toolInput, 'file_path', 'path', 'filename');
  const filePath = typeof rawPath === 'string' ? rawPath : undefined;
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const changes = [];

  if (toolName === 'Write') {
    const content = str(pick(toolInput, 'content', 'file_text', 'contents', 'text'));
    changes.push({ newCode: content, oldCode: content });
  } else if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    for (const e of edits) {
      changes.push({
        newCode: str(pick(e, 'new_string', 'new_text', 'newText')),
        oldCode: str(pick(e, 'old_string', 'old_text', 'oldText')),
      });
    }
  } else if (toolName === 'Edit') {
    changes.push({
      newCode: str(pick(toolInput, 'new_string', 'new_text', 'newText')),
      oldCode: str(pick(toolInput, 'old_string', 'old_text', 'oldText')),
    });
  }

  return { filePath, changes: changes.filter((c) => c.newCode && c.newCode.trim()) };
}

function toRelPath(cwd, filePath) {
  if (typeof filePath !== 'string') return String(filePath || '');
  const base = cwd || process.cwd();
  const abs = isAbsolute(filePath) ? filePath : resolve(base, filePath);
  let rel = relative(base, abs);
  if (!rel || rel.startsWith('..')) rel = filePath; // file outside project; keep as-is
  return rel.split('\\').join('/');
}

function safeRead(filePath) {
  try {
    if (filePath && existsSync(filePath)) return readFileSync(filePath, 'utf8');
  } catch (err) {
    debug('read failed', err.message);
  }
  return '';
}

function relativeTime(ts) {
  if (!Number.isFinite(ts)) return 'previously';
  const ms = Date.now() - ts;
  const min = Math.round(ms / 60000);
  if (min < 1) return 'moments ago';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

function buildBlockMessage(hit, file, symbol) {
  const where = symbol === '(file scope)' ? file : `${symbol}() in ${file}`;
  const ago = relativeTime(hit.attempt.ts);
  const times = hit.failCount > 1 ? ` It has failed ${hit.failCount} times.` : '';
  const sig = renderSig(hit.attempt);
  const why = sig ? ` It failed with: ${sig}` : ' It failed verification.';
  const batch =
    hit.attempt.batchSize > 1
      ? ` (Note: it failed alongside ${hit.attempt.batchSize - 1} other edit(s) in one run — attribution is approximate; \`rl unblock ${file}\` if it was collateral.)`
      : '';
  return (
    `RegressionLedger: you already tried this exact fix to ${where} ${ago}.${why}${times} ` +
    `Re-applying it verbatim will reproduce the same failure. Change strategy instead — ` +
    `address a different root cause or layer, or read why the earlier attempt failed.${batch} ` +
    `Run \`rl show ${file}\` to see the full attempt history.`
  );
}

function buildLiteralNote(hit, file) {
  const sig = renderSig(hit.attempt);
  const why = sig ? ` (it failed with: ${sig})` : '';
  return (
    `RegressionLedger note (not a block): this edit is the same code SHAPE as a fix that previously failed in ${file}, ` +
    `differing only in constant/string values${why}. If changing that value IS your hypothesis ` +
    `(timeout, limit, key name…), proceed — this variant gets its own verdict. ` +
    `But if the approach is unchanged and only the wording moved, expect the same failure. ` +
    `Run \`rl why ${file}\` for the history.`
  );
}

// Structural threshold is deliberately stricter than the semantic one: a
// "same shape, different words" note should only fire on a near-exact skeleton.
const STRUCT_THRESHOLD = 0.95;

/**
 * Find a recorded FAILED attempt whose structural skeleton matches the
 * proposed edit even though its semantic fingerprint did not.
 */
function findParaphrasedFailure(root, file, fp) {
  const target = structureTokens(Array.isArray(fp.tokens) ? fp.tokens : []);
  // Too short = ubiquitous idiom shapes (guard clauses) — meaningless matches.
  // Too long = whole-file Writes — the semantic channel already covers those,
  // and shingling huge streams against every attempt is real synchronous latency.
  if (target.length < 15 || target.length > 3000) return null;
  const ledger = loadLedger(root);
  // Acquittal applies here too: proven-good code (a recorded PASS with this
  // exact rawHash) must get total silence — no channel may second-guess it.
  if (fp.rawHash) {
    const provenGood = ledger.attempts.some(
      (a) => a.file === file && a.outcome === 'pass' && a.rawHash === fp.rawHash
    );
    if (provenGood) return null;
  }
  let best = null;
  for (const a of ledger.attempts) {
    if (a.outcome !== 'fail') continue;
    if (a.file !== file) continue;
    const aTokens = Array.isArray(a.tokens) ? a.tokens : [];
    if (aTokens.length === 0 || aTokens.length > 3000) continue;
    const sim = tokenSimilarity(structureTokens(aTokens), target);
    if (sim >= STRUCT_THRESHOLD && (!best || sim > best.similarity)) {
      best = { attempt: a, similarity: Math.round(sim * 100) / 100 };
      if (sim === 1) break;
    }
  }
  return best;
}

const allow = () => ({ exit: 0 });
const deny = (reason) => ({
  exit: 0,
  json: {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  },
});
const preContext = (text) => ({
  exit: 0,
  json: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } },
});
const postContext = (text) => ({
  exit: 0,
  json: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } },
});

/** PreToolUse: block (or warn about) re-applying a previously-failed fix. */
export function handlePreToolUse(input) {
  const toolName = input.tool_name;
  if (!EDIT_TOOLS.has(toolName)) return allow();

  const cwd = input.cwd || process.cwd();
  const root = resolveRoot(cwd);
  const config = loadConfig(root);
  const { filePath, changes } = extractEdits(toolName, input.tool_input);
  if (!filePath || !changes.length) return allow();

  const rel = toRelPath(cwd, filePath);
  const fileContent = safeRead(filePath); // pre-edit content (edit not applied yet)

  for (const ch of changes) {
    const fp = fingerprint({
      filePath: rel,
      changedCode: ch.newCode,
      fileContent,
      anchor: ch.oldCode || ch.newCode,
    });
    const hit = findSimilarFailure(
      root,
      { file: rel, symbol: fp.symbol, intentHash: fp.intentHash, rawHash: fp.rawHash, tokens: fp.tokens },
      config
    );
    // HARD BLOCK only on the RAW channel: same code, constants included. A
    // collapsed-only match (same shape, different literals) is frequently a
    // LEGITIMATE retry — timeout 5000→30000 — and must never be denied; it
    // gets a note and one hearing instead. (Found by community stress-testing:
    // the old behavior actively pushed agents away from correct fixes.)
    if (hit && hit.rawExact && hit.failCount >= (config.minFailures || 1)) {
      const msg = buildBlockMessage(hit, rel, fp.symbol);
      debug(config.mode === 'block' ? 'BLOCK' : 'WARN', rel, fp.symbol, hit.similarity);
      recordHit(root, {
        mode: config.mode === 'warn' ? 'warn' : 'block',
        file: rel,
        symbol: fp.symbol,
        similarity: 1,
        failCount: hit.failCount,
        intentHash: fp.intentHash,
      });
      return config.mode === 'warn' ? preContext(`⚠ ${msg}`) : deny(msg);
    }
    if (hit && !hit.rawExact) {
      debug('LITERAL-VARIANT NOTE', rel, fp.symbol, hit.similarity);
      recordHit(root, {
        mode: 'note',
        file: rel,
        symbol: fp.symbol,
        similarity: Math.round(hit.similarity * 100) / 100,
        failCount: hit.failCount,
        intentHash: fp.intentHash,
      });
      return preContext(buildLiteralNote(hit, rel));
    }

    // Second channel: structural shape. Only consulted when the semantic
    // channel found NO match at all (a semantic hit below minFailures is the
    // user's explicit choice to allow — don't second-guess it). When the SHAPE
    // of this edit is near-identical to a recorded failure (classic sign of a
    // renamed/paraphrased re-application), never block — annotate. False
    // positives here cost nothing; silence would cost a cycle.
    if (hit) continue;
    const para = findParaphrasedFailure(root, rel, fp);
    if (para) {
      const pct = Math.round(para.similarity * 100);
      debug('PARAPHRASE NOTE', rel, fp.symbol, para.similarity);
      recordHit(root, {
        mode: 'note',
        file: rel,
        symbol: fp.symbol,
        similarity: para.similarity,
        failCount: 1,
        intentHash: fp.intentHash,
      });
      return preContext(
        `RegressionLedger note (not a block): this edit is ${pct}% structurally identical to a fix that previously FAILED in ${rel}` +
          (para.attempt.errorSignature ? ` (${para.attempt.errorSignature})` : '') +
          `, though the identifiers differ — it may be the same fix, renamed. If the underlying approach is the same, change strategy instead. Run \`rl show ${rel}\` for the history.`
      );
    }
  }
  return allow();
}

/**
 * SessionStart: the agent wakes up (new session, /clear, resume, or right
 * after compaction wiped its memory) — inject the failure briefing so dead
 * ends are known before they're re-conceived.
 */
export function handleSessionStart(input) {
  const cwd = input.cwd || process.cwd();
  const root = resolveRoot(cwd);
  const briefing = buildBriefing(root);
  if (!briefing) return allow();
  debug('session briefing injected', input.source || '');
  return {
    exit: 0,
    json: {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: briefing },
    },
  };
}

function extractResultText(input) {
  const r = input.tool_response ?? input.tool_result ?? input.result;
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.text === 'string') return r.text;
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    return `${r.stdout || ''}\n${r.stderr || ''}`;
  }
  if (typeof r.output === 'string') return r.output;
  try {
    return JSON.stringify(r);
  } catch {
    return '';
  }
}

/** PostToolUse: record applied edits, and resolve them when tests/builds run. */
export function handlePostToolUse(input) {
  const toolName = input.tool_name;
  const cwd = input.cwd || process.cwd();
  const root = resolveRoot(cwd);
  const session = input.session_id || 'unknown';

  if (EDIT_TOOLS.has(toolName)) {
    const { filePath, changes } = extractEdits(toolName, input.tool_input);
    if (!filePath || !changes.length) return allow();
    const rel = toRelPath(cwd, filePath);
    const fileContent = safeRead(filePath); // post-edit content (edit applied)
    for (const ch of changes) {
      const fp = fingerprint({
        filePath: rel,
        changedCode: ch.newCode,
        fileContent,
        anchor: ch.newCode, // locate the just-written code to find its symbol
      });
      addAttempt(root, {
        session,
        file: rel,
        symbol: fp.symbol,
        intentHash: fp.intentHash,
        rawHash: fp.rawHash,
        tokens: fp.tokens,
        preview: truncate(ch.newCode, 120),
        tool: toolName,
      });
    }
    return allow();
  }

  if (toolName === 'Bash') {
    const command = (input.tool_input && input.tool_input.command) || '';
    if (!isVerificationCommand(command)) return allow();
    const { outcome, errorSignature } = detectOutcome(extractResultText(input));
    if (!outcome) return allow();
    const count = resolvePending(root, session, outcome, errorSignature);
    debug('resolved', count, 'attempts as', outcome);
    if (outcome === 'fail' && count > 0) {
      let msg =
        `RegressionLedger logged ${count} edit(s) from this run as FAILED. ` +
        `Don't re-apply those same patches — try a different approach.`;
      // Thrash escalation: many DIFFERENT approaches dying on one wall is the
      // doom loop blocking alone can't catch. Force a strategy checkpoint.
      // Evaluate the wall for THE signature just hit (an old, larger wall must
      // never shadow a fresh one).
      const wall = errorSignature ? detectThrashWall(root, errorSignature) : null;
      if (wall) {
        msg =
          `RegressionLedger ESCALATION: ${wall.distinct} distinct approaches have now failed with the same error — ` +
          `"${sanitizeForContext(wall.signature, 200)}" (${wall.files.join(', ')}). The patches differ; the error doesn't. That means the ` +
          `DIAGNOSIS is wrong, not the patches. STOP editing. Before the next change: (1) re-read the failing test and ` +
          `the error closely, (2) state 2-3 hypotheses for the root cause, (3) verify one with a read or a log — then fix. ` +
          `Run \`rl show --by-error\` to see the wall.`;
      }
      return postContext(msg);
    }
    return allow();
  }

  return allow();
}
