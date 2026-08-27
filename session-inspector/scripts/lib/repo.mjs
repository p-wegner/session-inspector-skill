/**
 * A repo's own account of what is left to do — the source the session tools were
 * blind to. Measured: for "which sessions should we continue?", the transcripts
 * tell you where work STOPPED, but the actionable next step almost always lives
 * in the repo's `CONTINUE.md` (per this setup's convention: CONTINUE.md = "where
 * do I pick this up", BACKLOG.md = "what could we do next"). Answering the
 * question without reading them means guessing.
 *
 * The parser is deliberately conservative about what counts as OPEN, because the
 * whole value is not re-proposing finished work:
 *   - `- [ ]` is open; `- [x]` is not.
 *   - a numbered "Next steps" item is open unless it is struck through (`~~…~~`)
 *     or its first line announces completion ("Done", "landed", "superseded").
 * Anything ambiguous is reported as open — a false positive costs a glance, a
 * false negative loses the work.
 *
 * Node builtins only.
 */
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// "Done" markers that appear at the START of an item's text. Deliberately not a
// bare /done/ search: "Done 2026-08-20" opens a closed item, but "what remains to
// be done" is an open one.
const DONE_HEAD = /^(~~|\*\*?done\b|done\b|landed\b|superseded\b|obsolete\b)/i;
const isDone = (text) => {
  const t = String(text || "").trim();
  if (DONE_HEAD.test(t)) return true;
  // fully struck-through item: ~~…~~ possibly followed by a note
  if (/^~~[\s\S]*?~~/.test(t)) return true;
  return false;
};

const SECTION_BLOCKED = /blocked|open question|watch/i;
const SECTION_NEXT = /next step|next|todo|to do|remaining|open/i;

// ── pass recency ─────────────────────────────────────────────────────────────
// The convention writes CONTINUE.md newest-pass-first and archives older passes
// out. When that archive pass is overdue the file keeps BOTH pictures, and a
// positional parser cannot tell them apart: measured on agentic-kanban's 2279-line
// CONTINUE.md, line 6 was a 2026-08-25 pass headed "#807 done" while line 930, in
// the 2026-08-23/24 pass, still said "Operator: decide the push. It unblocks #834
// and #807" — and the second one is what got proposed as the top next step.
//
// So: date each level-2 pass, and treat an item from an older pass as SUSPECT.
// Not dropped — a superseding pass does not always restate what it superseded, so
// deleting a stale-looking item can lose real work. Demoted and labelled, which
// costs a glance instead.
const ARCHIVE_LINES = 600; // the convention's own archive trigger

/** Latest ISO date mentioned in a heading, or null. "2026-08-23/24" → 2026-08-23. */
function headingDate(title) {
  const found = String(title || "").match(/\d{4}-\d{2}-\d{2}/g);
  if (!found) return null;
  return found.sort()[found.length - 1];
}

/**
 * Parse a CONTINUE.md-shaped document into open / done / blocked items.
 *
 * @returns {{exists, path, mtime, open, done, blocked, sections}}
 *   open    [{ text, section, kind }]  kind: checkbox | step
 */
export function parseContinueDoc(path) {
  if (!existsSync(path)) {
    return {
      exists: false, path, mtime: null, lineCount: 0,
      open: [], done: [], blocked: [], sections: [], passes: [],
      newestPassDate: null, topPassDate: null, overdueArchive: false, archiveLines: ARCHIVE_LINES,
    };
  }
  const raw = readFileSync(path, "utf-8");
  const mtime = statSync(path).mtime;
  const lines = raw.split(/\r?\n/);

  const open = [], done = [], blocked = [], sections = [], passes = [];
  let section = "";
  // The enclosing level-2 PASS, which is what carries the date. The immediate
  // section can be a "### Next steps" inside it and have no date of its own.
  let pass = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const head = line.match(/^(#{2,4})\s+(.*)$/);
    if (head) {
      section = head[2].trim();
      sections.push(section);
      if (head[1].length === 2) {
        pass = { title: section, date: headingDate(section), index: passes.length };
        passes.push(pass);
      }
      continue;
    }
    const stamp = () => ({
      passTitle: pass ? pass.title : null,
      passDate: pass ? pass.date : null,
      passIndex: pass ? pass.index : -1,
    });

    // checkbox items — the most reliable open/closed signal in the convention
    const box = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/);
    if (box) {
      const text = clip(box[2], 200);
      if (!text) continue;
      if (box[1] === " ") {
        (SECTION_BLOCKED.test(section) ? blocked : open).push({ text, section, kind: "checkbox", ...stamp() });
      } else {
        done.push({ text, section, kind: "checkbox", ...stamp() });
      }
      continue;
    }

    // numbered steps under a "Next steps"-ish heading
    const step = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (step && SECTION_NEXT.test(section)) {
      const text = clip(step[2], 200);
      if (!text) continue;
      if (isDone(text)) done.push({ text, section, kind: "step", ...stamp() });
      else open.push({ text, section, kind: "step", ...stamp() });
      continue;
    }

    // bare bullets under an explicitly blocked/open-question heading
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet && SECTION_BLOCKED.test(section)) {
      const text = clip(bullet[1], 200);
      if (text && !isDone(text)) blocked.push({ text, section, kind: "bullet", ...stamp() });
    }
  }

  // The newest dated pass is the doc's own claim about "now". Items from an
  // OLDER dated pass are suspect; items from an undated pass (the convention's
  // standing sections — next steps, blocked, tried-and-rejected) are not.
  const dates = passes.map((p) => p.date).filter(Boolean).sort();
  const newestPassDate = dates.length ? dates[dates.length - 1] : null;
  const markStale = (i) => ({ ...i, stale: Boolean(newestPassDate && i.passDate && i.passDate < newestPassDate) });

  const lineCount = lines.length;
  const topPassDate = passes.length ? passes[0].date : null;
  // Both halves of the convention's archive trigger: too long, or the top pass is
  // no longer today's. Only reported — this module does not rewrite anyone's docs.
  const overdueArchive = lineCount > ARCHIVE_LINES;

  return {
    exists: true, path, mtime, lineCount,
    open: open.map(markStale), done: done.map(markStale), blocked: blocked.map(markStale),
    sections, passes, newestPassDate, topPassDate, overdueArchive, archiveLines: ARCHIVE_LINES,
  };
}

/** CONTINUE.md + BACKLOG.md for a repo root, plus their `.local.md` layer. */
export function readRepoDocs(dir) {
  const pick = (...names) => {
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
    return join(dir, names[0]);
  };
  const cont = parseContinueDoc(pick("CONTINUE.md"));
  const back = parseContinueDoc(pick("BACKLOG.md"));
  const localCont = parseContinueDoc(pick("CONTINUE.local.md"));
  const localBack = parseContinueDoc(pick("BACKLOG.local.md"));
  return {
    continueDoc: cont,
    backlogDoc: back,
    local: { continueDoc: localCont, backlogDoc: localBack },
    hasLocal: localCont.exists || localBack.exists,
    // The union a human actually wants to see: CONTINUE's open items first (in
    // flight), then BACKLOG's (candidate). Local layer last — it is the newer but
    // less settled one, per the convention.
    // Within each doc, items from the newest pass come first: an overdue archive
    // leaves superseded passes in the file, and whatever is shown first is what
    // gets acted on. Order is otherwise preserved (stable sort).
    open: [
      ...freshFirst(cont.open).map((i) => ({ ...i, doc: "CONTINUE.md" })),
      ...freshFirst(localCont.open).map((i) => ({ ...i, doc: "CONTINUE.local.md" })),
      ...freshFirst(back.open).map((i) => ({ ...i, doc: "BACKLOG.md" })),
      ...freshFirst(localBack.open).map((i) => ({ ...i, doc: "BACKLOG.local.md" })),
    ],
    blocked: [...cont.blocked, ...back.blocked].map((i) => ({ ...i })),
    // Doc-hygiene warnings, so a caller can say WHY it distrusts what it read.
    warnings: [cont, back, localCont, localBack].flatMap(docWarnings),
  };
}

/** Newest-pass items first, original order within each group. */
function freshFirst(items) {
  return items.map((i, n) => [i, n])
    .sort((a, b) => (a[0].stale === b[0].stale ? a[1] - b[1] : a[0].stale ? 1 : -1))
    .map(([i]) => i);
}

/** Human-readable reasons a doc's open items may not describe today. */
function docWarnings(doc) {
  if (!doc.exists) return [];
  const name = doc.path.split(/[\\/]/).pop();
  const out = [];
  const staleOpen = doc.open.filter((i) => i.stale).length;
  if (doc.overdueArchive) {
    out.push(`${name} is ${doc.lineCount} lines (the convention archives past ~${doc.archiveLines})`
      + (staleOpen ? ` — ${staleOpen} of ${doc.open.length} open item(s) come from passes older than ${doc.newestPassDate}` : ""));
  } else if (staleOpen) {
    out.push(`${name}: ${staleOpen} of ${doc.open.length} open item(s) predate its newest pass (${doc.newestPassDate})`);
  }
  return out;
}

/** Measured git state of a checkout. Never throws — a non-repo returns exists:false. */
export function gitState(dir) {
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000,
  }).trim();
  try {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    let dirty = 0;
    try { dirty = git("status", "--porcelain").split("\n").filter((l) => l.trim()).length; } catch { /* ignore */ }
    let ahead = 0, behind = 0, tracked = false;
    try {
      const counts = git("rev-list", "--left-right", "--count", "@{upstream}...HEAD");
      const [b, a] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0);
      behind = b; ahead = a; tracked = true;
    } catch { /* no upstream */ }
    let lastCommit = "", lastCommitAt = "";
    try {
      const [sha, when, subject] = git("log", "-1", "--format=%h%x09%cI%x09%s").split("\t");
      lastCommit = `${sha} ${subject || ""}`.trim();
      lastCommitAt = when || "";
    } catch { /* empty repo */ }
    return { exists: true, dir, branch, dirty, ahead, behind, tracked, lastCommit, lastCommitAt };
  } catch {
    return { exists: false, dir, branch: "", dirty: 0, ahead: 0, behind: 0, tracked: false, lastCommit: "", lastCommitAt: "" };
  }
}
