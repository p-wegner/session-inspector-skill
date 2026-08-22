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

/**
 * Parse a CONTINUE.md-shaped document into open / done / blocked items.
 *
 * @returns {{exists, path, mtime, open, done, blocked, sections}}
 *   open    [{ text, section, kind }]  kind: checkbox | step
 */
export function parseContinueDoc(path) {
  if (!existsSync(path)) return { exists: false, path, mtime: null, open: [], done: [], blocked: [], sections: [] };
  const raw = readFileSync(path, "utf-8");
  const mtime = statSync(path).mtime;
  const lines = raw.split(/\r?\n/);

  const open = [], done = [], blocked = [], sections = [];
  let section = "";
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const head = line.match(/^(#{2,4})\s+(.*)$/);
    if (head) { section = head[2].trim(); sections.push(section); continue; }

    // checkbox items — the most reliable open/closed signal in the convention
    const box = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/);
    if (box) {
      const text = clip(box[2], 200);
      if (!text) continue;
      if (box[1] === " ") {
        (SECTION_BLOCKED.test(section) ? blocked : open).push({ text, section, kind: "checkbox" });
      } else {
        done.push({ text, section, kind: "checkbox" });
      }
      continue;
    }

    // numbered steps under a "Next steps"-ish heading
    const step = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (step && SECTION_NEXT.test(section)) {
      const text = clip(step[2], 200);
      if (!text) continue;
      if (isDone(text)) done.push({ text, section, kind: "step" });
      else open.push({ text, section, kind: "step" });
      continue;
    }

    // bare bullets under an explicitly blocked/open-question heading
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet && SECTION_BLOCKED.test(section)) {
      const text = clip(bullet[1], 200);
      if (text && !isDone(text)) blocked.push({ text, section, kind: "bullet" });
    }
  }

  return { exists: true, path, mtime, open, done, blocked, sections };
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
    open: [
      ...cont.open.map((i) => ({ ...i, doc: "CONTINUE.md" })),
      ...localCont.open.map((i) => ({ ...i, doc: "CONTINUE.local.md" })),
      ...back.open.map((i) => ({ ...i, doc: "BACKLOG.md" })),
      ...localBack.open.map((i) => ({ ...i, doc: "BACKLOG.local.md" })),
    ],
    blocked: [...cont.blocked, ...back.blocked].map((i) => ({ ...i })),
  };
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
