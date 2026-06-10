import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAttempt, resolvePending, recordHit } from '../src/ledger.js';
import { groupByError, buildReportData, renderMarkdown, renderHtml } from '../src/report.js';

function seededRoot() {
  const root = join(mkdtempSync(join(tmpdir(), 'rl-report-')), '.regressionledger');
  // Two failures sharing one signature (different files), one with another, one pass.
  addAttempt(root, { session: 'a', file: 'src/auth.js', symbol: 'login', intentHash: 'h1', tokens: ['a'], preview: 'fix 1', tool: 'Edit' });
  resolvePending(root, 'a', 'fail', 'TypeError: x is not a function');
  addAttempt(root, { session: 'b', file: 'src/api.js', symbol: 'handler', intentHash: 'h2', tokens: ['b'], preview: 'fix 2', tool: 'Edit' });
  resolvePending(root, 'b', 'fail', 'TypeError: x is not a function');
  addAttempt(root, { session: 'c', file: 'src/auth.js', symbol: 'login', intentHash: 'h3', tokens: ['c'], preview: 'fix 3', tool: 'Edit' });
  resolvePending(root, 'c', 'fail', 'AssertionError: expected 200');
  addAttempt(root, { session: 'd', file: 'src/auth.js', symbol: 'login', intentHash: 'h4', tokens: ['d'], preview: 'fix 4', tool: 'Edit' });
  resolvePending(root, 'd', 'pass');
  recordHit(root, { mode: 'block', file: 'src/auth.js', symbol: 'login', similarity: 1, failCount: 1, intentHash: 'h1' });
  recordHit(root, { mode: 'warn', file: 'src/api.js', symbol: 'handler', similarity: 0.95, failCount: 1, intentHash: 'h2' });
  return root;
}

test('groupByError clusters failures by signature across files', () => {
  const root = seededRoot();
  const groups = groupByError(root);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].signature, 'TypeError: x is not a function', 'biggest cluster first');
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].files.sort(), ['src/api.js', 'src/auth.js']);
  assert.equal(groups[1].count, 1);
});

test('passing attempts never appear in error clusters', () => {
  const root = seededRoot();
  const all = groupByError(root).flatMap((g) => g.attempts);
  assert.ok(all.every((a) => a.outcome === 'fail'));
});

test('buildReportData counts hits and files', () => {
  const root = seededRoot();
  const d = buildReportData(root);
  assert.equal(d.summary.blocked, 1);
  assert.equal(d.summary.warned, 1);
  assert.equal(d.summary.fail, 3);
  assert.equal(d.summary.pass, 1);
  assert.equal(d.files.length, 2);
});

test('markdown report contains the headline numbers', () => {
  const d = buildReportData(seededRoot());
  const md = renderMarkdown(d);
  assert.match(md, /Repeat fixes blocked\D+1/);
  assert.match(md, /Walls you keep hitting/);
  assert.match(md, /TypeError: x is not a function/);
});

test('html report is self-contained and escaped', () => {
  const root = seededRoot();
  // Inject a hostile preview to verify escaping.
  addAttempt(root, { session: 'x', file: 'src/evil.js', symbol: 'e', intentHash: 'h9', tokens: ['x'], preview: '<script>alert(1)</script>', tool: 'Edit' });
  resolvePending(root, 'x', 'fail', '<img src=x onerror=alert(1)>');
  const html = renderHtml(buildReportData(root));
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'preview must be escaped');
  assert.ok(!html.includes('<img src=x'), 'signature must be escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!/src=["']https?:/.test(html), 'no external resources');
});
