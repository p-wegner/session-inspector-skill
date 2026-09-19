/**
 * lenses/render-md.mjs — the second render of a lens result: Markdown for an agent
 * or a terminal, from the SAME { headline, questions, sections } the HTML page draws.
 *
 * One source, two renders: a person opens the page, an agent reads this, and neither
 * can say something the other does not, because both are printed from one object.
 */

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function lensToMarkdown(l, { maxRows = 12 } = {}) {
  const out = [`## ${l.title}`, ""];
  if (l.headline?.length) {
    for (const t of l.headline) out.push(`- **${t.label}:** ${t.value}${t.note ? ` (${t.note})` : ""}`);
    out.push("");
  }
  for (const q of l.questions || []) {
    out.push(`### ${q.q}`, "", q.a);
    if (q.detail) out.push("", q.detail);
    out.push("");
  }
  for (const s of l.sections || []) {
    out.push(`### ${s.title}`, "");
    if (s.note) out.push(s.note, "");
    if (s.table) {
      out.push(`| ${s.table.cols.map(cell).join(" | ")} |`, `|${s.table.cols.map(() => "---").join("|")}|`);
      for (const r of s.table.rows.slice(0, maxRows)) out.push(`| ${r.map(cell).join(" | ")} |`);
      if (s.table.rows.length > maxRows) out.push(`| … ${s.table.rows.length - maxRows} more rows (--json has all) |`);
      out.push("");
    }
  }
  return out.join("\n");
}
