import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenSimilarity } from '../src/similarity.js';

test('identical token streams are fully similar', () => {
  const t = ['return', 'a', '+', 'b', ';'];
  assert.equal(tokenSimilarity(t, t), 1);
});

test('a small change in a long stream stays highly similar', () => {
  const a = 'if ( user ) { return doThing ( user , flag , extra ) ; }'.split(' ');
  const b = 'if ( user ) { return doThing ( user , flag , other ) ; }'.split(' ');
  const sim = tokenSimilarity(a, b);
  assert.ok(sim > 0.6 && sim < 1, `expected high-but-not-1, got ${sim}`);
});

test('unrelated streams are dissimilar', () => {
  const a = 'const x = compute ( total ) ;'.split(' ');
  const b = 'while ( queue . length ) process ( ) ;'.split(' ');
  assert.ok(tokenSimilarity(a, b) < 0.2);
});

test('empty streams are equal', () => {
  assert.equal(tokenSimilarity([], []), 1);
});
