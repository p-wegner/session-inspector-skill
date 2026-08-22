/**
 * Has this cut-off session ALREADY been picked up? Without an answer, every
 * resume/continuation tool keeps ranking work that is finished — measured case:
 * a 4h34m session killed by a usage limit stayed the #1 "resume this"
 * recommendation for two days after another session had committed its stranded
 * work and pushed.
 *
 * Three evidence sources, strongest first. Each link carries `via` so a caller
 * can trust them differently — the weak one is a heuristic and says so.
 *
 *   ledger   `~/.spawn-session/ledger.jsonl` — written at spawn time by
 *            spawn-session, so it names BOTH sides explicitly. Authoritative.
 *   brief    `~/.spawn-session/handoffs/*.md` carries `**from session**: <uuid>`;
 *            a later transcript whose opening prompt names that brief path is
 *            its other half. Strong: both ends are machine-written.
 *   mention  a later session in the same project dir whose text names the
 *            candidate's short id. Weak — it is how a human finds this by hand,
 *            and it can equally mean "was discussed", not "was continued".
 *
 * Node builtins only.
 */
import { readFileSync, readdirSync, existsSync, openSync, readSync, closeSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";

// Scanning transcripts for a mention is the expensive half of this module: one
// project dir here holds 134 MB, and reading every candidate dir whole took long
// enough to look hung. Two bounds keep it interactive, and both are reported to
// the caller rather than applied silently:
//   - CHUNKED, early-exit search instead of readFileSync, so a hit in the first
//     megabyte of a 30 MB transcript costs a megabyte.
//   - a file budget, newest-first, because a successor is nearly always one of
//     the next few sessions in that repo, not the fortieth.
const CHUNK = 1 << 20;             // 1 MiB
const DEFAULT_MAX_FILES = 60;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
// How many distinct candidates one session may mention before we read it as
// ANALYSIS (a fleet tool run, a triage conversation) rather than a continuation.
const ANALYSIS_FANOUT = 3;

/**
 * Does `path` contain any of `needles`? Streams in chunks and stops at the first
 * hit. Overlaps chunk boundaries by the longest needle so a match spanning two
 * reads is not missed.
 */
export function fileContainsAny(path, needles, budget = { bytes: Infinity }) {
  if (!needles.length) return null;
  const overlap = Math.max(...needles.map((n) => n.length)) - 1;
  let fd;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = "";
    for (;;) {
      if (budget.bytes <= 0) return null;
      const n = readSync(fd, buf, 0, Math.min(CHUNK, Math.max(0, budget.bytes)), null);
      if (n <= 0) return null;
      budget.bytes -= n;
      const text = carry + buf.toString("utf-8", 0, n);
      for (const needle of needles) if (text.includes(needle)) return needle;
      carry = overlap > 0 ? text.slice(-overlap) : "";
    }
  } catch { return null; } finally { closeSync(fd); }
}

export const SPAWN_DIR = join(homedir(), ".spawn-session");
export const LEDGER_PATH = join(SPAWN_DIR, "ledger.jsonl");
const BRIEF_DIR = join(SPAWN_DIR, "handoffs");

/** Spawn-session's own record of who handed what to whom. */
export function readLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  const out = [];
  for (const line of readFileSync(LEDGER_PATH, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* a torn append is not fatal */ }
  }
  return out;
}

/** Handoff briefs on disk, each naming the session that wrote it. */
export function readBriefs() {
  if (!existsSync(BRIEF_DIR)) return [];
  const out = [];
  for (const name of readdirSync(BRIEF_DIR)) {
    if (!name.endsWith(".md")) continue;
    const path = join(BRIEF_DIR, name);
    let head;
    try { head = readFileSync(path, "utf-8").slice(0, 2000); } catch { continue; }
    const from = head.match(/\*\*from session\*\*:\s*`([0-9a-f-]{8,})`/i)?.[1] || "";
    const repo = head.match(/\*\*target repo\*\*:\s*`([^`]+)`/i)?.[1] || "";
    const written = head.match(/\*\*written\*\*:\s*([0-9TZ:.\-]+)/i)?.[1] || "";
    out.push({ path, name, from, repo, written });
  }
  return out;
}

const sid8 = (id) => String(id || "").replace(/-/g, "").slice(0, 8);
const projectDirOf = (p) => basename(dirname(String(p || "")));

/**
 * Annotate candidates with the sessions that appear to have continued them.
 *
 * @param candidates [{ sessionId, path, endTime }]
 * @param records    every discovered transcript (from `discover("claude")`)
 * @param opts.readFile  injectable reader (tests)
 * @returns Map<sessionId, [{ sessionId, via, when, path, confidence }]>
 */
export function findSuccessors(candidates, records, opts = {}) {
  const read = opts.readFile || ((p) => readFileSync(p, "utf-8"));
  const out = new Map(candidates.map((c) => [c.sessionId, []]));
  if (!candidates.length) return out;

  const add = (id, link) => {
    const list = out.get(id);
    if (!list) return;
    // One successor can be found by two routes; keep the strongest only.
    const dup = list.find((l) => l.sessionId === link.sessionId);
    if (!dup) { list.push(link); return; }
    if (link.confidence > dup.confidence) Object.assign(dup, link);
  };

  // ── ledger: explicit, both sides named ────────────────────────────────────
  for (const e of readLedger()) {
    if (!e.sourceSessionId) continue;
    add(e.sourceSessionId, {
      sessionId: e.targetSessionId || e.targetAgent || "(spawned)",
      via: "ledger", when: e.ts || "", path: e.brief || "", confidence: 3,
    });
  }

  // ── briefs: source side on disk, target side found in a transcript ────────
  const briefsBySource = new Map();
  for (const b of readBriefs()) {
    if (!b.from) continue;
    if (!briefsBySource.has(b.from)) briefsBySource.set(b.from, []);
    briefsBySource.get(b.from).push(b);
  }

  // Only sessions that could plausibly be a successor get read: newer than the
  // oldest candidate, and either in a candidate's project dir (mention route) or
  // any session at all (brief route, since a handoff can change repo).
  const oldest = candidates
    .map((c) => new Date(c.endTime || 0).getTime())
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)[0] || 0;
  const candDirs = new Set(candidates.map((c) => projectDirOf(c.path)));
  const candIds = new Set(candidates.map((c) => c.sessionId));
  const watch = candidates.map((c) => ({ id: c.sessionId, s8: sid8(c.sessionId) }));
  const anyBriefs = briefsBySource.size > 0;

  // Needle table: every brief filename whose source is a candidate, plus every
  // candidate's short id. One pass per file answers both routes.
  const needles = [];
  for (const [from, briefs] of briefsBySource) {
    if (!candIds.has(from)) continue;
    for (const b of briefs) needles.push({ text: b.name, route: "brief", target: from, confidence: 2 });
  }
  for (const w of watch) {
    if (w.s8.length === 8) needles.push({ text: w.s8, route: "mention", target: w.id, confidence: 1 });
  }
  if (!needles.length) return out;

  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const budget = { bytes: opts.maxBytes ?? DEFAULT_MAX_BYTES };

  // Newest-first: a successor is almost always one of the next sessions in that
  // repo. With a file budget, spending it on the nearest candidates is strictly
  // better than on whatever the directory order happened to be.
  const pool = records
    .filter((rec) => (rec.kind || "main") === "main")
    .filter((rec) => !candIds.has(rec.sessionId))
    .filter((rec) => !rec.mtime || rec.mtime.getTime() >= oldest)
    .filter((rec) => candDirs.has(projectDirOf(rec.path)) || anyBriefs)
    .sort((a, b) => (b.mtime?.getTime() || 0) - (a.mtime?.getTime() || 0))
    .slice(0, maxFiles);

  const truncated = { files: 0 };
  for (const rec of pool) {
    const inCandDir = candDirs.has(projectDirOf(rec.path));
    const when = rec.mtime ? new Date(rec.mtime).toISOString() : "";
    // A brief name can appear in any repo (a handoff may change repo); a short id
    // only counts inside the candidate's own project dir, so unrelated chatter
    // elsewhere cannot masquerade as a continuation.
    const applicable = needles.filter((n) => n.route === "brief" || inCandDir);
    if (!applicable.length) continue;
    if (budget.bytes <= 0) { truncated.files++; continue; }

    // The injected reader (tests) has no chunking; fall back to a whole read.
    let hits = [];
    if (opts.readFile) {
      let content;
      try { content = read(rec.path); } catch { continue; }
      hits = applicable.filter((n) => content.includes(n.text));
    } else {
      // Multiple needles can match; ask for each so a brief hit is not masked by
      // an id hit found first. Cheap in practice — the scan stops at the hit.
      for (const n of applicable) {
        if (budget.bytes <= 0) break;
        if (fileContainsAny(rec.path, [n.text], budget)) hits.push(n);
      }
    }
    for (const n of hits) {
      add(n.target, { sessionId: rec.sessionId, via: n.route, when, path: rec.path, confidence: n.confidence });
    }
  }
  out.scanTruncated = truncated.files > 0;

  // ── discard "it analyzed them" from "it continued them" ───────────────────
  // Measured false positive that made this dangerous rather than merely noisy: a
  // session inspecting the fleet (this very skill's own tools print session ids)
  // matched the short id of EVERY candidate, and so appeared to have continued
  // all nine — hiding two genuinely open cut-offs behind one heuristic hit.
  // A continuation picks up ONE piece of work; a tool run enumerates many. So a
  // would-be successor that mentions several distinct candidates is reclassified
  // as analysis and its mention links are dropped.
  const mentionsPerSuccessor = new Map();
  for (const list of out.values()) {
    for (const l of list) {
      if (l.via !== "mention") continue;
      mentionsPerSuccessor.set(l.sessionId, (mentionsPerSuccessor.get(l.sessionId) || 0) + 1);
    }
  }
  const analysts = new Set(
    [...mentionsPerSuccessor.entries()].filter(([, n]) => n >= ANALYSIS_FANOUT).map(([id]) => id));
  if (analysts.size) {
    for (const [id, list] of out) {
      out.set(id, list.filter((l) => !(l.via === "mention" && analysts.has(l.sessionId))));
    }
  }
  out.analysts = [...analysts];

  for (const list of out.values()) {
    list.sort((a, b) => b.confidence - a.confidence || String(a.when).localeCompare(String(b.when)));
  }
  return out;
}

/**
 * Links strong enough to conclude the work was actually handed over: both ends
 * machine-written (ledger, brief). Only these may HIDE a session from a "what
 * should we pick up?" list — a `mention` is a hint for a human to check, and
 * acting on it as fact loses real work.
 */
export function strongLinks(links) {
  return (links || []).filter((l) => l.confidence >= 2);
}

/** One-line human summary of a successor list, or "" when nothing continued it. */
export function successorLabel(links) {
  if (!links || !links.length) return "";
  const top = links[0];
  const who = String(top.sessionId).slice(0, 8);
  const note = { ledger: "handed off to", brief: "brief read by", mention: "possibly continued by" }[top.via] || "continued by";
  const more = links.length > 1 ? ` (+${links.length - 1} more)` : "";
  return `${note} ${who}${top.via === "mention" ? " — heuristic" : ""}${more}`;
}
