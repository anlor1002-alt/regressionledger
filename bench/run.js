// Reproducible fingerprint benchmark: how well does the matcher catch
// cosmetically-disguised repeat fixes, and does it ever false-block a
// genuinely different fix?  Run with:  npm run bench
//
// Deterministic by construction (no randomness), so the numbers in the README
// are checkable by anyone in seconds.

import { fingerprint } from '../src/fingerprint.js';
import { tokenSimilarity } from '../src/similarity.js';
import { DEFAULT_CONFIG } from '../src/ledger.js';

const THRESHOLD = DEFAULT_CONFIG.threshold;

// 20 base "fixes" — realistic, structurally distinct edits across common bug-fix shapes.
const BASES = [
  'return res.status(401).json({ message: "unauthorized", code: 401 });',
  'if (!user || !user.token) { throw new AuthError("missing token", 401); }',
  'const result = await retry(() => fetchData(url, { timeout: 5000 }), 3);',
  'items = items.filter(item => item != null && item.id !== undefined);',
  'cache.set(key, value, { ttl: 60000 }); return cache.get(key);',
  'for (let i = 0; i < rows.length - 1; i++) { merge(rows[i], rows[i + 1]); }',
  'const safe = input.replace(/[<>"&]/g, ch => entities[ch] || ch);',
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

// Cosmetic disguises an agent (or reformatter) typically applies when it
// "re-discovers" the same fix: whitespace/layout churn, added comments,
// different string messages, different numeric constants.
const DISGUISES = [
  ['reflowed whitespace', (s) => s.replace(/ /g, '  ').replace(/; /g, ';\n  ')],
  ['inline comment added', (s) => `${s} // make sure this handles the edge case`],
  ['leading comment added', (s) => `/* second attempt at the fix */ ${s}`],
  ['string literals changed', (s) => s.replace(/"([^"]*)"/g, '"changed-text"')],
  ['number literals changed', (s) => s.replace(/\b\d+\b/g, '9876')],
  ['mixed: comments + literals', (s) => `// retry\n${s.replace(/\b\d+\b/g, '42').replace(/ /g, '  ')}`],
];

function sim(a, b) {
  const fa = fingerprint({ filePath: 'bench.js', changedCode: a });
  const fb = fingerprint({ filePath: 'bench.js', changedCode: b });
  if (fa.intentHash === fb.intentHash) return 1;
  return tokenSimilarity(fa.tokens, fb.tokens);
}

// --- repeat-fix detection: every disguise of a base must match that base ---
let repeatTotal = 0;
let repeatCaught = 0;
const misses = [];
for (const base of BASES) {
  for (const [name, disguise] of DISGUISES) {
    repeatTotal++;
    const s = sim(base, disguise(base));
    if (s >= THRESHOLD) repeatCaught++;
    else misses.push({ name, base: base.slice(0, 50), s: s.toFixed(3) });
  }
}

// --- false blocks: no pair of DIFFERENT bases may match ---
let distinctTotal = 0;
let falseBlocks = 0;
const collisions = [];
for (let i = 0; i < BASES.length; i++) {
  for (let j = i + 1; j < BASES.length; j++) {
    distinctTotal++;
    const s = sim(BASES[i], BASES[j]);
    if (s >= THRESHOLD) {
      falseBlocks++;
      collisions.push({ i, j, s: s.toFixed(3) });
    }
  }
}

const pct = (n, d) => ((100 * n) / d).toFixed(1) + '%';
console.log('RegressionLedger fingerprint benchmark (deterministic)');
console.log('  threshold:', THRESHOLD);
console.log('');
console.log(`  Disguised repeat fixes caught : ${repeatCaught}/${repeatTotal}  (${pct(repeatCaught, repeatTotal)})`);
console.log(`  False blocks on distinct fixes: ${falseBlocks}/${distinctTotal}  (${pct(falseBlocks, distinctTotal)})`);
console.log('');
if (misses.length) {
  console.log('  Missed disguises:');
  for (const m of misses) console.log(`    - [${m.name}] sim=${m.s} :: ${m.base}…`);
}
if (collisions.length) {
  console.log('  Collisions (false blocks):');
  for (const c of collisions) console.log(`    - bases #${c.i} vs #${c.j} sim=${c.s}`);
}
if (!misses.length && !falseBlocks) {
  console.log('  ✓ 100% of disguised repeats caught, zero false blocks.');
}
process.exitCode = misses.length || falseBlocks ? 1 : 0;
