'use strict';
/* Formatting helpers: scan tables, deltas, and the audit findings list. */

function fmt(n) { return n.toLocaleString('en-US'); }

function bar(frac, width = 20) {
  const filled = Math.round(frac * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function scanTable({ files, total, counter, skippedLarge = [] }, { top = 0 } = {}) {
  const rows = top > 0 ? files.slice(0, top) : files;
  const wPath = Math.max(4, ...rows.map(f => f.path.length));
  const lines = [];
  lines.push(`counter: ${counter}   files: ${files.length}   total: ${fmt(total)} tokens`);
  lines.push('');
  lines.push(`${'TOKENS'.padStart(9)}  ${'SHARE'.padEnd(22)}  FILE`);
  for (const f of rows) {
    const frac = total ? f.tokens / total : 0;
    lines.push(`${fmt(f.tokens).padStart(9)}  ${bar(frac)} ${(frac * 100).toFixed(1).padStart(4)}%  ${f.path.padEnd(wPath)}`);
  }
  if (top > 0 && files.length > top) {
    const rest = files.slice(top).reduce((s, f) => s + f.tokens, 0);
    lines.push(`${fmt(rest).padStart(9)}  ${' '.repeat(22)}  …${files.length - top} more files`);
  }
  if (skippedLarge.length) {
    const mb = (b) => `${(b / 1048576).toFixed(1)}MB`;
    lines.push('');
    lines.push(`skipped ${skippedLarge.length} large file(s) (>2MB, likely generated/minified — not tokenized):`);
    for (const f of skippedLarge.slice(0, 5)) lines.push(`  ${mb(f.bytes).padStart(8)}  ${f.path}`);
    if (skippedLarge.length > 5) lines.push(`  …and ${skippedLarge.length - 5} more`);
  }
  return lines.join('\n');
}

function delta(before, after) {
  const saved = before - after;
  const pct = before ? (saved / before) * 100 : 0;
  return `${fmt(before)} → ${fmt(after)} tokens  (${saved >= 0 ? '-' : '+'}${fmt(Math.abs(saved))}, ${pct.toFixed(1)}%)`;
}

function skillReport(a) {
  const L = [];
  const t = a.tiers;
  L.push(`skill: ${a.name || '(no name)'}    counter: ${a.counter}`);
  L.push('');
  L.push('CONTEXT COST (progressive disclosure — how an agent actually loads it)');
  L.push(`  ${'Tier 0  always-on'.padEnd(20)} ${fmt(t.alwaysOn).padStart(6)} tok   name+description — in context EVERY turn, every session`);
  L.push(`  ${'Tier 1  on-invoke'.padEnd(20)} ${fmt(t.onInvoke).padStart(6)} tok   SKILL.md body — loaded when the skill triggers`);
  L.push(`  ${'Tier 2  on-demand'.padEnd(20)} ${fmt(t.onDemand).padStart(6)} tok   reference docs — only if a pointer is followed`);
  for (const f of t.onDemandDocs) L.push(`  ${' '.repeat(20)} ${fmt(f.tokens).padStart(6)} tok     └ ${f.path}`);
  L.push(`  ${'─'.repeat(44)}`);
  L.push(`  ${'fully expanded'.padEnd(20)} ${fmt(a.fullyExpanded).padStart(6)} tok   worst case: invoked + every reachable doc read`);

  const nc = a.notContext;
  const codeTotal = nc.code.reduce((s, f) => s + f.tokens, 0);
  if (nc.code.length || nc.humanDocs.length || nc.orphanDocs.length) {
    L.push('');
    L.push('NOT CONTEXT (in the repo, never loaded into the window)');
    if (nc.code.length) L.push(`  ${'code/assets (run)'.padEnd(20)} ${fmt(codeTotal).padStart(6)} tok   ${nc.code.length} files — executed or ignored, not read`);
    for (const f of nc.humanDocs) L.push(`  ${'human doc'.padEnd(20)} ${fmt(f.tokens).padStart(6)} tok   ${f.path}  (for people, not agents)`);
    for (const f of nc.orphanDocs) L.push(`  ${'⚠ orphan doc'.padEnd(20)} ${fmt(f.tokens).padStart(6)} tok   ${f.path}  (no SKILL.md path reaches it — agents won't read it)`);
  }

  L.push('');
  // guidance focused on the highest-leverage tier
  if (t.alwaysOn > 120) L.push(`! Tier 0 is ${fmt(t.alwaysOn)} tok. The description loads every turn — keep it tight (aim <~100). This is the highest-leverage place to cut.`);
  if (nc.orphanDocs.length) L.push(`! ${nc.orphanDocs.length} orphan doc(s): either link them from SKILL.md or delete — as-is they cost repo weight but never help an agent.`);
  L.push('See references/optimization-guide.md; preserve every load-bearing instruction.');
  return L.join('\n');
}

module.exports = { scanTable, skillReport, delta, fmt, bar };
