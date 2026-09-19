/**
 * DOC GAPS — what a session established that its repo's CONTINUE.md / BACKLOG.md
 * do not record.
 *
 * The tracking files are the convention's hand-over, and they are written by the
 * same session at the end of a long run, from memory. Measured on two real sessions
 * (2026-09-19): an independent reader of each transcript listed 27 and 32
 * weight-2/3 facts, and most of them were in neither file — the human's answers to
 * the session's questions, the doc URLs the work was built from, the defect a fix
 * commit repaired, a test count the file still gave as 5 after the sixth test
 * landed, the links it created outside the repo.
 *
 * Deterministic on purpose: every candidate comes from lib/session-facts.mjs or git,
 * and "recorded" is a token match against the files. So it can say "not found",
 * never "not recorded in other words" — a paraphrase is a miss, and the output says
 * so. What to write about a gap is the session's call; this lists them.
 */

const STOP = new Set(("about after again against because before being between could does doing during every "
  + "first from have into itself just more most much must never other over same should since some still such "
  + "than that their them then there these they this those through under until very were what when where which "
  + "while with would your yours only also will been here make made like want need done").split(" "));

/** Distinctive tokens of a fact: code spans, URLs, long words, numbers with units. */
export function tokensOf(text) {
  const t = String(text || "");
  const out = new Set();
  for (const m of t.matchAll(/`([^`]{3,80})`/g)) out.add(m[1].toLowerCase());
  for (const m of t.matchAll(/https?:\/\/[^\s)>"'`]+/g)) out.add(m[0].replace(/[.,;]+$/, "").toLowerCase());
  const bare = t.replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ");
  for (const w of bare.toLowerCase().match(/[a-z][a-z0-9_-]{5,}/g) || []) if (!STOP.has(w)) out.add(w);
  return [...out].slice(0, 10);
}

/** Share of a fact's tokens the doc contains; `found` when at least half are there. */
export function mentioned(docLower, text) {
  const toks = tokensOf(text);
  if (!toks.length) return { found: false, share: 0, toks };
  const hit = toks.filter((k) => docLower.includes(k));
  return { found: hit.length / toks.length >= 0.5, share: hit.length / toks.length, toks, missing: toks.filter((k) => !hit.includes(k)) };
}

/**
 * Counts the doc states ("5 tests", "109 checks") against the last runner tally.
 * A tracking file that still quotes an older count reads as current; this is the
 * one gap that is a contradiction rather than an omission.
 */
export function staleCounts(docText, tests) {
  const last = [...(tests || [])].reverse().find((t) => t.ok && (t.runs || []).length);
  if (!last) return [];
  const passed = [];
  for (const run of last.runs) {
    for (const l of run) {
      const m = l.match(/(?:ℹ\s*pass\s+(\d+))|(\d+)\s+(?:\w+\s+){0,2}passed/i);
      if (m) passed.push(Number(m[1] || m[2]));
    }
  }
  if (!passed.length) return [];
  const out = [];
  for (const m of String(docText).matchAll(/\b(\d{1,4})\s+((?:[a-z-]+\s+){0,2})(?:tests?|checks?)\b/gi)) {
    // "4 ms of test time" is a duration, not a count.
    if (/\b(?:ms|s|sec|secs|seconds?|min|minutes?|hours?|of|kb|mb|gb|percent)\b/i.test(m[2])) continue;
    const n = Number(m[1]);
    if (!passed.includes(n) && passed.every((p) => Math.abs(p - n) <= Math.max(3, p * 0.2))) {
      out.push({ docSays: m[0], lastRun: passed.join(" + "), command: last.command });
    }
  }
  return out;
}

/**
 * @param facts    sessionFacts() output
 * @param docText  CONTINUE.md + BACKLOG.md (+ .local layer) of the work repo, concatenated
 * @param extra    { commits: history.during, remote, links, scratchSecrets }
 * @returns [{ kind, fact, found, missing }] plus `stale` contradictions
 */
export function docGaps(facts, docText, extra = {}) {
  const doc = String(docText || "").toLowerCase();
  const items = [];
  const add = (kind, fact, probe = fact) => {
    const r = mentioned(doc, probe);
    items.push({ kind, fact, found: r.found, share: Math.round(r.share * 100), missing: r.missing || [] });
  };
  for (const a of facts.answers || []) add("human decision", `${a.question} → ${a.answer}`, a.answer.length > 12 ? a.answer : `${a.question} ${a.answer}`);
  for (const p of (facts.humanPrompts || []).slice(1)) if (p.text.length > 30) add("human instruction", p.text);
  // A URL whose every fetch failed was not relied on.
  for (const s of facts.sources || []) if (s.kind === "url" && (s.ok || !s.failedFetches)) add("source relied on", s.value);
  // Its OWN commits only: in a repo where agents commit concurrently, the window holds
  // theirs too (measured: 10 "defect fixed" lines, 8 of them other agents' work).
  for (const c of (extra.commits || []).filter((x) => x.mine !== false)) if (c.body && /fix|defect|bug|broke|failed|silently|wrong|ran nothing/i.test(`${c.subject} ${c.body}`)) add("defect fixed", `${c.subject}: ${c.body}`);
  // Shell-quoting accidents and the session's own tool limits are its tooling, not
  // the project's: measured as the commonest false hits in the list.
  const TRIVIA = /unexpected EOF|here-?doc|syntax error near|Expected unicode escape|command not found|No such file or directory|Traceback \(most recent call last\)|exceeds maximum allowed size|Ripgrep search timed out|Invoke-Expression|In Zeile|Validate command safety|Path does not exist/i;
  const seenErr = new Map();
  for (const x of (facts.failures || []).filter((f) => f.error && !TRIVIA.test(f.error))) {
    const k = `${x.tool}|${x.error.slice(0, 60)}`;
    if (seenErr.has(k)) { seenErr.get(k).n++; continue; }
    seenErr.set(k, { x, n: 1 });
  }
  for (const { x, n } of seenErr.values()) add("trap hit", `${x.tool}${n > 1 ? ` (×${n})` : ""}: ${x.error}`, x.error);
  for (const [flag, b] of Object.entries(facts.bypasses || {})) add("guard bypassed", `\`${flag}\` on ${b.n} command(s), ${String(b.first).slice(11, 16)}–${String(b.last).slice(11, 16)}`, `${flag} bypass override`);
  // A file outside every repo it edited: no history anywhere else.
  for (const [file, e] of Object.entries(facts.edits || {})) {
    if (extra.isOutside && extra.isOutside(file)) add("changed outside the repo", `\`${file}\`: \`${e.old}\` → \`${e.new}\``, `${file.split(/[\\/]/).pop()} ${e.new}`);
  }
  for (const line of String((facts.lastCompaction && facts.lastCompaction.sections["pending tasks"]) || "").split("\n")) {
    const t = line.replace(/^\s*[-*]\s*/, "").trim();
    if (t.length > 30 && /^\s*[-*]/.test(line)) add("pending at its last compaction", t);
  }
  for (const t of (facts.tests || []).filter((r) => r.diagnosis)) add("defect found by a failing run", `${t.firstError ? `${t.firstError} — ` : ""}${t.diagnosis}`, t.diagnosis);
  for (const d of facts.closingChecklist?.done || []) add("claimed done", d);
  // Its own "Verified:" statements from chat; one it already wrote into the file matches itself.
  for (const v of (facts.verified || []).filter((x) => x.where === "message")) add(v.negative ? "stated as unverified" : "verified (its words)", v.text);
  if (extra.remote && extra.remote.url) add("remote", extra.remote.url, extra.remote.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, ""));
  for (const k of facts.links || []) add("machine wiring", `links created: ${k.command}`, "junction symlink linked profiles");
  for (const o of facts.closingChecklist?.open || []) add("left open", o);
  if (facts.closingChecklist?.next) add("next step", facts.closingChecklist.next);
  for (const s of extra.scratchSecrets || []) items.push({ kind: "credential left in scratchpad", fact: s, found: false, share: 0, missing: [] });
  return { items, stale: staleCounts(docText, facts.tests) };
}

export function renderGaps(g, { docPaths = [], sessionId = "" } = {}) {
  const L = [];
  const miss = g.items.filter((i) => !i.found);
  L.push(`# What session ${String(sessionId).slice(0, 8)} established that its tracking files do not record`);
  L.push("");
  L.push(`Compared against: ${docPaths.length ? docPaths.map((p) => `\`${p}\``).join(", ") : "(no CONTINUE.md / BACKLOG.md found — everything below is unrecorded)"}.`);
  L.push("A token match: a fact written in other words counts as missing. Each line is a candidate for the CONTINUE pass, not a verdict.");
  L.push("");
  if (g.stale.length) {
    L.push("## Contradicted by the last run");
    for (const s of g.stale) L.push(`- The file says **${s.docSays}**; the last run of \`${s.command}\` printed **${s.lastRun}** passed.`);
    L.push("");
  }
  L.push(`## Not found (${miss.length} of ${g.items.length})`);
  const byKind = new Map();
  for (const i of miss) { if (!byKind.has(i.kind)) byKind.set(i.kind, []); byKind.get(i.kind).push(i); }
  for (const [k, list] of byKind) {
    L.push(`- **${k}**`);
    for (const i of list) L.push(`  - ${i.fact.length > 220 ? `${i.fact.slice(0, 220)}…` : i.fact}`);
  }
  if (!miss.length) L.push("- nothing: every candidate fact has a match in the files.");
  L.push("");
  const hit = g.items.filter((i) => i.found);
  if (hit.length) L.push(`Found: ${hit.length} (${[...new Set(hit.map((i) => i.kind))].join(", ")}).`);
  return `${L.join("\n")}\n`;
}
