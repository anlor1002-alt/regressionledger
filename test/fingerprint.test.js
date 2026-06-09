import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, extractSymbol, fingerprint } from '../src/fingerprint.js';

test('tokenize strips comments and whitespace, abstracts literals', () => {
  const tokens = tokenize('const x = "hello";  // a comment\nconst y = 42;', 'js');
  assert.ok(tokens.includes('const'));
  assert.ok(tokens.includes('"STR"'), 'string literal becomes STR');
  assert.ok(tokens.includes('"NUM"'), 'number literal becomes NUM');
  assert.ok(!tokens.includes('hello'), 'string contents are not kept');
  assert.ok(!tokens.includes('comment'), 'comment text is dropped');
});

test('# is a comment in python but not in js (private fields)', () => {
  const py = tokenize('x = 1  # trailing', 'py');
  assert.ok(!py.includes('trailing'));
  const js = tokenize('this.#count = 1', 'js');
  assert.ok(js.includes('#'), 'js keeps # so private fields are not eaten');
  assert.ok(js.includes('count'));
});

test('same fix intent with different string/number literals hashes identically', () => {
  const a = fingerprint({ filePath: 'a.js', changedCode: 'return res.status(401).json({ message: "denied" });' });
  const b = fingerprint({ filePath: 'a.js', changedCode: 'return res.status(403).json({ message: "forbidden" });' });
  assert.equal(a.intentHash, b.intentHash);
});

test('boolean literals are NOT collapsed (true vs false is a real difference)', () => {
  const a = fingerprint({ filePath: 'a.js', changedCode: 'return isValid(x) === true;' });
  const b = fingerprint({ filePath: 'a.js', changedCode: 'return isValid(x) === false;' });
  assert.notEqual(a.intentHash, b.intentHash, 'opposite behavior must not share a fingerprint');
});

test('structurally different code hashes differently', () => {
  const a = fingerprint({ filePath: 'a.js', changedCode: 'return a + b;' });
  const b = fingerprint({ filePath: 'a.js', changedCode: 'return a - b;' });
  assert.notEqual(a.intentHash, b.intentHash);
});

test('extractSymbol finds the enclosing function', () => {
  const file = [
    'export function other() { return 1; }',
    '',
    'function login(user) {',
    '  const token = makeToken(user);',
    '  return token;',
    '}',
  ].join('\n');
  assert.equal(extractSymbol(file, 'makeToken(user)'), 'login');
});

test('extractSymbol falls back to file scope', () => {
  assert.equal(extractSymbol('const a = 1;\nconst b = 2;', 'const b = 2;'), '(file scope)');
});

test('extractSymbol handles python def', () => {
  const file = 'def handler(req):\n    x = parse(req)\n    return x\n';
  assert.equal(extractSymbol(file, 'parse(req)'), 'handler');
});

test('extractSymbol skips control-flow keywords for the enclosing function', () => {
  const file = [
    'function process(items) {',
    '  for (const x of items) {',
    '    if (x.valid) {',
    '      doTheThing(x);',
    '    }',
    '  }',
    '}',
  ].join('\n');
  // Must resolve to the real function, not "if" or "for".
  assert.equal(extractSymbol(file, 'doTheThing(x)'), 'process');
});
