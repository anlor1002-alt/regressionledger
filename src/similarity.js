// Token-sequence similarity used to decide whether a proposed edit is
// "the same fix" as one we've seen before. Deliberately deterministic and
// dependency-free — no embeddings, no LLM, no network.

// A control char that cannot appear inside a token, so joined shingles can't
// collide across token boundaries (e.g. ["ab","c"] vs ["a","bc"]).
const SEP = String.fromCharCode(1);

/**
 * Build the set of contiguous k-gram shingles over a token array. Shingles
 * capture local ordering, so "a = b + c" and "c + b = a" don't collide the way
 * a bag-of-tokens would.
 */
export function shingles(tokens, k = 3) {
  const set = new Set();
  if (tokens.length === 0) return set;
  if (tokens.length < k) {
    set.add(tokens.join(SEP));
    return set;
  }
  for (let i = 0; i <= tokens.length - k; i++) {
    set.add(tokens.slice(i, i + k).join(SEP));
  }
  return set;
}

/** Jaccard overlap of two sets: |A ∩ B| / |A ∪ B|. Returns 0..1. */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

/**
 * Similarity of two normalized token arrays, 0..1.
 *  - Identical sequences short-circuit to 1.
 *  - Otherwise the Jaccard overlap of their k-gram shingles.
 */
export function tokenSimilarity(tokensA, tokensB, k = 3) {
  if (tokensA.length === 0 && tokensB.length === 0) return 1;
  if (tokensA.join(SEP) === tokensB.join(SEP)) return 1;
  return jaccard(shingles(tokensA, k), shingles(tokensB, k));
}
