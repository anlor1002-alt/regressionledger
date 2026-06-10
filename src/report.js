// `rl report` and `rl show --by-error` — turn the ledger into artifacts worth
// sharing: a markdown summary for terminals/PRs, a self-contained HTML report
// for screenshots, and an error-signature clustering that surfaces "you keep
// hitting the same wall from different angles".

import { loadLedger, loadHits, summarize } from './ledger.js';

/**
 * Group FAILED attempts by their error signature. Attempts with no captured
 * signature are grouped under "(no signature captured)".
 * @returns [{signature, count, files:[…], attempts:[…], lastTs}] sorted by count desc.
 */
export function groupByError(root) {
  const ledger = loadLedger(root);
  const groups = new Map();
  for (const a of ledger.attempts) {
    if (a.outcome !== 'fail') continue;
    const sig = a.errorSignature || '(no signature captured)';
    if (!groups.has(sig)) groups.set(sig, { signature: sig, count: 0, files: new Set(), attempts: [], lastTs: 0 });
    const g = groups.get(sig);
    g.count++;
    g.files.add(a.file);
    g.attempts.push(a);
    if (a.ts > g.lastTs) g.lastTs = a.ts;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, files: [...g.files] }))
    .sort((x, y) => y.count - x.count);
}

/** Collect everything the report needs in one pass. */
export function buildReportData(root) {
  const ledger = loadLedger(root);
  const hits = loadHits(root);
  const summary = summarize(root);
  const blocked = hits.filter((h) => h.mode === 'block').length;
  const warned = hits.filter((h) => h.mode === 'warn').length;

  const byFile = new Map();
  for (const a of ledger.attempts) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file).push(a);
  }
  for (const list of byFile.values()) list.sort((x, y) => x.ts - y.ts);

  return {
    generatedAt: new Date().toISOString(),
    summary: { ...summary, blocked, warned },
    errorClusters: groupByError(root),
    files: [...byFile.entries()].map(([file, attempts]) => ({ file, attempts })),
    hits,
  };
}

const dt = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
const mark = { fail: '✗', pass: '✓', pending: '…' };

export function renderMarkdown(data) {
  const s = data.summary;
  const lines = [];
  lines.push('# RegressionLedger report');
  lines.push('');
  lines.push(`_Generated ${data.generatedAt}_`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Edit attempts recorded | ${s.total} |`);
  lines.push(`| Failed | ${s.fail} |`);
  lines.push(`| Passed | ${s.pass} |`);
  lines.push(`| Pending | ${s.pending} |`);
  lines.push(`| Files touched | ${s.files} |`);
  lines.push(`| **Repeat fixes blocked** | **${s.blocked}** |`);
  lines.push(`| Would-have-blocked (warn mode) | ${s.warned} |`);
  if (s.blocked > 0) {
    lines.push('');
    lines.push(
      `> Each block is a failing test cycle that never ran — at minimum ${s.blocked} wasted round-trip${s.blocked === 1 ? '' : 's'} prevented.`
    );
  }
  lines.push('');

  if (data.errorClusters.length) {
    lines.push('## Walls you keep hitting (failures by error signature)');
    lines.push('');
    for (const g of data.errorClusters) {
      lines.push(`### ${g.count}× — \`${g.signature}\``);
      lines.push('');
      lines.push(`Across ${g.files.length} file${g.files.length === 1 ? '' : 's'}: ${g.files.map((f) => `\`${f}\``).join(', ')}`);
      lines.push('');
      for (const a of g.attempts) {
        lines.push(`- ${dt(a.ts)} · \`${a.file}\` · ${a.symbol} — ${a.preview || ''}`);
      }
      lines.push('');
    }
  }

  lines.push('## Attempt history');
  lines.push('');
  for (const f of data.files) {
    lines.push(`### ${f.file}`);
    lines.push('');
    for (const a of f.attempts) {
      const sig = a.errorSignature ? ` — ${a.errorSignature}` : '';
      lines.push(`- ${mark[a.outcome] || '?'} ${a.outcome.toUpperCase()} · ${dt(a.ts)} · ${a.symbol}${sig}`);
      if (a.preview) lines.push(`  - \`${a.preview}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderHtml(data) {
  const s = data.summary;
  const stat = (label, value, cls = '') =>
    `<div class="stat ${cls}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

  const clusters = data.errorClusters
    .map(
      (g) => `
    <div class="cluster">
      <div class="cluster-head"><span class="count">${g.count}×</span><code>${esc(g.signature)}</code></div>
      <div class="cluster-files">${g.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>
      <ul>${g.attempts
        .map((a) => `<li><span class="ts">${esc(dt(a.ts))}</span> <code>${esc(a.file)}</code> · ${esc(a.symbol)}<div class="preview">${esc(a.preview || '')}</div></li>`)
        .join('')}</ul>
    </div>`
    )
    .join('');

  const files = data.files
    .map(
      (f) => `
    <div class="file">
      <h3><code>${esc(f.file)}</code></h3>
      <ul>${f.attempts
        .map((a) => {
          const cls = a.outcome === 'fail' ? 'fail' : a.outcome === 'pass' ? 'pass' : 'pending';
          const sig = a.errorSignature ? `<div class="sig">${esc(a.errorSignature)}</div>` : '';
          return `<li class="${cls}"><span class="badge">${esc(a.outcome)}</span><span class="ts">${esc(dt(a.ts))}</span> ${esc(a.symbol)}<div class="preview">${esc(a.preview || '')}</div>${sig}</li>`;
        })
        .join('')}</ul>
    </div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RegressionLedger report</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#30363d; --ink:#e6edf3; --soft:#8b949e;
          --red:#f85149; --green:#3fb950; --yellow:#d29922; --mono:ui-monospace,SFMono-Regular,Consolas,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--ink); font:15px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif; padding:32px 20px 60px; }
  .wrap { max-width:860px; margin:0 auto; }
  h1 { font-size:1.6rem; } h2 { font-size:1.15rem; margin:34px 0 14px; color:var(--soft); text-transform:uppercase; letter-spacing:1px; font-weight:600; }
  .meta { color:var(--soft); font-size:.85rem; margin-top:4px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-top:22px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; text-align:center; }
  .stat b { display:block; font-size:1.6rem; } .stat span { color:var(--soft); font-size:.78rem; }
  .stat.blocked b { color:var(--red); } .stat.warned b { color:var(--yellow); }
  .note { background:linear-gradient(135deg,#1c2128,transparent); border-left:3px solid var(--red); border-radius:0 8px 8px 0; padding:12px 16px; margin-top:16px; color:var(--soft); }
  code { font-family:var(--mono); font-size:.85em; background:var(--panel); border:1px solid var(--line); border-radius:5px; padding:1px 6px; }
  .cluster,.file { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin-bottom:12px; }
  .cluster-head { display:flex; align-items:center; gap:10px; }
  .cluster-head .count { color:var(--red); font-weight:700; font-size:1.1rem; white-space:nowrap; }
  .cluster-files { margin:8px 0 4px; }
  ul { list-style:none; margin-top:10px; } li { padding:7px 0; border-top:1px solid var(--line); }
  .ts { color:var(--soft); font-size:.8rem; font-family:var(--mono); margin-right:8px; }
  .preview { font-family:var(--mono); font-size:.8rem; color:var(--soft); margin-top:3px; overflow-wrap:anywhere; }
  .sig { font-family:var(--mono); font-size:.8rem; color:var(--red); margin-top:3px; }
  .badge { display:inline-block; font-size:.7rem; font-weight:700; text-transform:uppercase; border-radius:5px; padding:1px 8px; margin-right:8px; }
  li.fail .badge { background:#3d1d20; color:var(--red); } li.pass .badge { background:#1c2f21; color:var(--green); }
  li.pending .badge { background:#332b18; color:var(--yellow); }
  footer { margin-top:40px; color:var(--soft); font-size:.82rem; text-align:center; }
  a { color:#58a6ff; }
</style>
</head>
<body><div class="wrap">
  <h1>RegressionLedger report</h1>
  <div class="meta">Generated ${esc(data.generatedAt)}</div>
  <div class="stats">
    ${stat('attempts', s.total)}
    ${stat('failed', s.fail)}
    ${stat('passed', s.pass)}
    ${stat('pending', s.pending)}
    ${stat('files', s.files)}
    ${stat('blocked', s.blocked, 'blocked')}
    ${stat('warn hits', s.warned, 'warned')}
  </div>
  ${s.blocked > 0 ? `<div class="note">Each block is a failing test cycle that never ran — at minimum ${s.blocked} wasted round-trip${s.blocked === 1 ? '' : 's'} prevented.</div>` : ''}
  ${data.errorClusters.length ? `<h2>Walls you keep hitting</h2>${clusters}` : ''}
  <h2>Attempt history</h2>
  ${files || '<div class="meta">No attempts recorded yet.</div>'}
  <footer>Generated by <a href="https://github.com/anlor1002-alt/regressionledger">RegressionLedger</a> — stop your coding agent from resurrecting fixes that already failed.</footer>
</div></body></html>`;
}
