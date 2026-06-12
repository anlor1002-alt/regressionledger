// Live findings confirmed against HEAD by a multi-agent fuzz/review pass.
// (The pass's HIGH findings #1-#4,#7,#8 were already fixed in v0.10.0/v0.10.1
// and are covered by gate-review.test.js + security-review.test.js — they ran
// against v0.9.0. These are the ones that still reproduced on HEAD.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHits, summarize } from '../src/ledger.js';
import { detectOutcome } from '../src/outcome.js';
import { renderMarkdown } from '../src/report.js';

delete process.env.RL_DIR;

test('#10: a corrupt-but-valid-JSON hits.json never crashes loadHits/stats', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'rl-fuzz-')), '.regressionledger');
  mkdirSync(root, { recursive: true });
  for (const junk of ['{}', '42', '"str"', 'null', '{"a":1}']) {
    writeFileSync(join(root, 'hits.json'), junk);
    assert.deepEqual(loadHits(root), [], `hits.json=${junk} -> []`);
    assert.doesNotThrow(() => summarize(root));
  }
});

test('#5/#6: command-scoped classification kills cross-toolchain fail bleed', () => {
  // A passing pytest run whose log contains a jest-style "FAIL " banner.
  assert.equal(
    detectOutcome('FAIL legacy/old.py was skipped\n===== 5 passed in 0.1s =====', 'pytest -q').outcome,
    'pass'
  );
  // "Retrying 1 failed attempt" prose on a passing pytest run.
  assert.equal(
    detectOutcome('Retrying 1 failed attempt...\n===== 5 passed in 0.10s =====', 'pytest').outcome,
    'pass'
  );
  // A real pytest failure is still a failure.
  assert.equal(detectOutcome('===== 1 failed, 7 passed in 0.42s =====', 'pytest').outcome, 'fail');
});

test('#14: a recognized runner is not fooled by "AssertionError" in passing prose', () => {
  // jest pass output mentioning AssertionError in a test title — scoped to
  // jest, the GENERIC AssertionError substring can never fire.
  assert.equal(
    detectOutcome('PASS src/a.test.js\n  ✓ rejects on AssertionError path\nTests: 3 passed, 3 total', 'npm test').outcome,
    'pass'
  );
});

test('#15: markdown report neutralizes structural injection from ledger text', () => {
  const data = {
    generatedAt: 't',
    summary: { total: 1, fail: 1, pass: 0, pending: 0, files: 1, blocked: 0, warned: 0 },
    errorClusters: [
      { count: 2, signature: 'Boom\n## FAKE HEADING\n```js', files: ['a.js'], attempts: [] },
    ],
    files: [
      {
        file: 'a.js',
        attempts: [
          { ts: Date.now(), outcome: 'fail', symbol: 'f', preview: 'x```js\n## INJECTED\n- fake item', errorSignature: 'e\n# H1' },
        ],
      },
    ],
    hits: [],
  };
  const md = renderMarkdown(data);
  const lines = md.split('\n');
  assert.ok(!lines.some((l) => /^#{1,6}\s+(INJECTED|FAKE|H1)/.test(l)), 'no injected heading at line start');
  assert.ok(!md.includes('```js'), 'no code-fence breakout');
});
