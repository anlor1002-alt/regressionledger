// Reproducible fingerprint benchmark — three honest categories:
//
//  1. COSMETIC disguises (whitespace/comments)  -> must match the RAW channel
//     (hard-block territory: same code, constants included)
//  2. LITERAL variants (changed string/number constants) -> must match the
//     COLLAPSED channel but NOT the raw channel (note-and-allow territory —
//     timeout 5000→30000 is often the legitimate next experiment, so blocking
//     here would be a false positive; the old benchmark counted these as
//     "disguises to catch", which made its 0-false-block number circular.
//     Fixed after community stress-testing.)
//  3. DISTINCT fixes -> must match NEITHER channel
//
// Deterministic by construction.  Run with:  npm run bench

import { fingerprint } from '../src/fingerprint.js';
import { tokenSimilarity } from '../src/similarity.js';
import { DEFAULT_CONFIG } from '../src/ledger.js';

const THRESHOLD = DEFAULT_CONFIG.threshold;

const BASES = [
  'return res.status(401).json({ message: "unauthorized", code: 401 });',
  'if (!user || !user.token) { throw new AuthError("missing token", 401); }',
  'const result = await retry(() => fetchData(url, { timeout: 5000 }), 3);',
  'items = items.filter(item => item != null && item.id !== undefined);',
  'cache.set(key, value, { ttl: 60000 }); return cache.get(key);',
  'for (let i = 0; i < rows.length - 1; i++) { merge(rows[i], rows[i + 1]); }',
  'const safe = String(input).split("<").join("&lt;").split(">").join("&gt;");',
  'if (balance - amount < 0) { return reject(new Error("insufficient funds")); }',
  'await db.transaction(async tx => { await tx.update(order); await tx.insert(log); });',
  'const parsed = JSON.parse(raw || "{}"); return parsed.data ?? [];',
  'socket.on("close", () => { clearInterval(heartbeat); reconnect(backoff * 2); });',
  'const idx = list.findIndex(x => x.name === target); if (idx === -1) return null;',
  'res.setHeader("Cache-Control", "no-store"); res.setHeader("Pragma", "no-cache");',
  'while (queue.length > 0 && workers < MAX_WORKERS) { spawn(queue.shift()); workers++; }',
  'const hash = createHash("sha256").update(salt + password).digest("hex");',
  'if (Date.now() - session.createdAt > SESSION_TTL) { await destroySession(session.id); }',
  'element.addEventListener("scroll", throttle(onScroll, 100), { passive: true });',
  'const total = lines.reduce((sum, line) => sum + line.qty * line.price, 0);',
  'try { await unlink(tmpPath); } catch (err) { if (err.code !== "ENOENT") throw err; }',
  'const [major] = process.versions.node.split("."); if (Number(major) < 18) exit(1);',
];

// Same code, cosmetic churn only — re-applying these IS re-applying the fix.
// (Reflow inserts line breaks after statement boundaries; it must not touch
// string contents — altering a string's interior IS a literal change.)
const COSMETIC = [
  ['reflowed statements', (s) => s.replace(/; /g, ';\n    ')],
  ['inline comment added', (s) => `${s} // make sure this handles the edge case`],
  ['leading comment added', (s) => `/* second attempt at the fix */ ${s}`],
];

// Same shape, different constants — often a LEGITIMATE new experiment.
const LITERAL = [
  ['string literals changed', (s) => s.replace(/"([^"]*)"/g, '"changed-text"')],
  ['number literals changed', (s) => s.replace(/\b\d+\b/g, '9876')],
  ['both changed', (s) => s.replace(/"([^"]*)"/g, '"x"').replace(/\b\d+\b/g, '42')],
];

function channels(a, b) {
  const fa = fingerprint({ filePath: 'bench.js', changedCode: a });
  const fb = fingerprint({ filePath: 'bench.js', changedCode: b });
  const raw = fa.rawHash === fb.rawHash;
  const collapsed =
    fa.intentHash === fb.intentHash ? 1 : tokenSimilarity(fa.tokens, fb.tokens);
  return { raw, collapsed: collapsed >= THRESHOLD };
}

let cosmeticTotal = 0, cosmeticHard = 0;
const cosmeticMiss = [];
for (const base of BASES) {
  for (const [name, fn] of COSMETIC) {
    cosmeticTotal++;
    const c = channels(base, fn(base));
    if (c.raw) cosmeticHard++;
    else cosmeticMiss.push({ name, base: base.slice(0, 50) });
  }
}

let literalTotal = 0, literalRouted = 0, literalWrongBlock = 0;
const literalMiss = [];
for (const base of BASES) {
  for (const [name, fn] of LITERAL) {
    const variant = fn(base);
    if (variant === base) continue; // base had no literal of that kind
    literalTotal++;
    const c = channels(base, variant);
    if (c.raw) literalWrongBlock++; // would hard-block a parameter change — BAD
    else if (c.collapsed) literalRouted++; // correctly routed to note-and-allow
    else literalMiss.push({ name, base: base.slice(0, 50) });
  }
}

let distinctTotal = 0, distinctHits = 0;
for (let i = 0; i < BASES.length; i++) {
  for (let j = i + 1; j < BASES.length; j++) {
    distinctTotal++;
    const c = channels(BASES[i], BASES[j]);
    if (c.raw || c.collapsed) distinctHits++;
  }
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
console.log('RegressionLedger fingerprint benchmark (deterministic, two-channel)');
console.log('  collapsed-similarity threshold:', THRESHOLD);
console.log('');
console.log(`  1. Cosmetic re-applies HARD-matched (raw)   : ${cosmeticHard}/${cosmeticTotal}  (${pct(cosmeticHard, cosmeticTotal)})`);
console.log(`  2. Literal variants routed to note-not-block : ${literalRouted}/${literalTotal}  (${pct(literalRouted, literalTotal)})`);
console.log(`     ...wrongly hard-blocked (false positives) : ${literalWrongBlock}/${literalTotal}`);
console.log(`  3. Distinct fixes matching either channel    : ${distinctHits}/${distinctTotal}  (${pct(distinctHits, distinctTotal)})`);
console.log('');
for (const m of cosmeticMiss) console.log(`  MISS cosmetic [${m.name}] :: ${m.base}…`);
for (const m of literalMiss) console.log(`  MISS literal  [${m.name}] :: ${m.base}…`);

const ok = !cosmeticMiss.length && !literalWrongBlock && !distinctHits && !literalMiss.length;
if (ok) console.log('  ✓ cosmetic repeats hard-blocked, parameter changes never blocked, distinct fixes untouched.');
process.exitCode = ok ? 0 : 1;
