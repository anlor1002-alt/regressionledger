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
import { fingerprint } from './fingerprint.js';
import {
  resolveRoot,
  loadConfig,
  addAttempt,
  resolvePending,
  findSimilarFailure,
} from './ledger.js';
import { isVerificationCommand, detectOutcome } from './outcome.js';
import { truncate, debug } from './util.js';

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
  const pct = Math.round(hit.similarity * 100);
  const where = symbol === '(file scope)' ? file : `${symbol}() in ${file}`;
  const ago = relativeTime(hit.attempt.ts);
  const why = hit.attempt.errorSignature
    ? ` It failed with: ${hit.attempt.errorSignature}`
    : ' It failed verification.';
  const same = pct >= 100 ? 'the same fix' : `a ${pct}%-identical fix`;
  return (
    `RegressionLedger: you already tried ${same} to ${where} ${ago}.${why} ` +
    `Re-applying it will reproduce the same failure. Change strategy instead — ` +
    `address a different root cause or layer, or read why the earlier attempt failed. ` +
    `Run \`rl show ${file}\` to see the full attempt history.`
  );
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
      { file: rel, symbol: fp.symbol, intentHash: fp.intentHash, tokens: fp.tokens },
      config
    );
    if (hit) {
      const msg = buildBlockMessage(hit, rel, fp.symbol);
      debug(config.mode === 'block' ? 'BLOCK' : 'WARN', rel, fp.symbol, hit.similarity);
      return config.mode === 'warn' ? preContext(`⚠ ${msg}`) : deny(msg);
    }
  }
  return allow();
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
      return postContext(
        `RegressionLedger logged ${count} edit(s) from this run as FAILED. ` +
          `Don't re-apply those same patches — try a different approach.`
      );
    }
    return allow();
  }

  return allow();
}
