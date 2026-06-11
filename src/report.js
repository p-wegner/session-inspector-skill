'use strict';
/* Formatting helpers: scan tables, deltas, and the audit findings list. */

function fmt(n) { return n.toLocaleString('en-US'); }

function bar(frac, width = 20) {
  const filled = Math.round(frac * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function scanTable({ files, total, counter }, { top = 0 } = {}) {
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
  return lines.join('\n');
}

function delta(before, after) {
  const saved = before - after;
  const pct = before ? (saved / before) * 100 : 0;
  return `${fmt(before)} → ${fmt(after)} tokens  (${saved >= 0 ? '-' : '+'}${fmt(Math.abs(saved))}, ${pct.toFixed(1)}%)`;
}

module.exports = { scanTable, delta, fmt, bar };
