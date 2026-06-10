// Table-driven classification tests over real-world runner outputs.
// To add support for a new test runner: add a toolchain to src/signatures.js,
// drop a real output sample in test/fixtures/<name>-{pass,fail}.txt, and add a
// row here. That's the whole contribution.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectOutcome, explainOutcome } from '../src/outcome.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(join(FIX, name), 'utf8');

const TABLE = [
  // fixture, expected outcome, signature must contain (for fails)
  ['jest-fail.txt', 'fail', /Expected|FAIL/],
  ['jest-pass.txt', 'pass', null],
  ['pytest-fail.txt', 'fail', /AssertionError/],
  ['pytest-pass.txt', 'pass', null],
  ['go-fail.txt', 'fail', /FAIL|auth_test/],
  ['go-pass.txt', 'pass', null],
  ['cargo-fail.txt', 'fail', /panicked|FAILED/],
  ['cargo-pass.txt', 'pass', null],
  ['tsc-fail.txt', 'fail', /TS2345/],
  ['tsc-pass.txt', 'pass', null],
  ['eslint-fail.txt', 'fail', /error/],
  ['eslint-pass.txt', 'pass', null],
  ['gradle-fail.txt', 'fail', /FAILED/],
  ['gradle-pass.txt', 'pass', null],
  ['dotnet-fail.txt', 'fail', /FAIL|Failed/],
  ['dotnet-pass.txt', 'pass', null],
  ['playwright-fail.txt', 'fail', /Error|Expected/],
  ['playwright-pass.txt', 'pass', null],
];

for (const [fixture, expected, sigPattern] of TABLE) {
  test(`fixture ${fixture} classifies as ${expected}`, () => {
    const r = detectOutcome(read(fixture));
    assert.equal(r.outcome, expected, `expected ${expected}, got ${r.outcome}`);
    if (expected === 'fail') {
      assert.ok(r.errorSignature, 'fail must capture an error signature');
      if (sigPattern) assert.match(r.errorSignature, sigPattern);
    }
  });
}

test('explainOutcome names the toolchain and pattern that decided', () => {
  const r = explainOutcome(read('pytest-fail.txt'));
  assert.equal(r.outcome, 'fail');
  assert.ok(r.matches.length >= 1);
  assert.ok(r.matches[0].toolchain.length > 0);
  assert.ok(r.matches[0].pattern.length > 0);
});
