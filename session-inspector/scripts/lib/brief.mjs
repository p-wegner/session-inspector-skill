/**
 * BRIEF — the harness-neutral handoff brief, as data and as markdown.
 *
 * Why a brief and not `--resume`: a session id cannot cross harnesses.
 * `claude --resume <id> --fork-session` and `codex fork <id>` both hand an id back
 * to the tool that owns the transcript, and the two stores are different formats in
 * different trees. What crosses is the key parts, written down, seeded into a fresh
 * session of the other agent. Same economics as the within-harness handoff this
 * skill already recommends (a cold resume of a long session costs ~20x its warm
 * turn; a brief is 2-5k tokens), plus the two things resume cannot do at all:
 * compare two models on one task, and move work off an exhausted account.
 *
 * ONE RULE, and everything here serves it: **the brief never upgrades a claim.**
 * What a committed tracking file records is evidence and is labelled with its
 * source; what the session said about itself is an assertion and is labelled
 * unverified. They are never merged, and the assertion half is never trimmed into
 * looking like the evidence half.
 *
 * The CLI (`scripts/brief.mjs`) resolves a session and does the IO; this module is
 * the part with judgement in it, so it can be tested.
 */

import { existsSync, readFileSync } from "fs";
import { routeOf, isLoopWakeup } from "./session-facts.mjs";

/**
 * Its write calls to local services, grouped by route. Git records none of this, and
 * for an operator session it IS the work (rebases, merges, preference writes, ticket
 * edits). A call that timed out is flagged: the request may still have been acted on,
 * so re-sending it is how a duplicate job starts.
 */
export function httpLedger(http, max = 6) {
  const g = new Map();
  for (const a of http || []) {
    const k = `${a.method} :${a.port}${routeOf(a.path)}`;
    const e = g.get(k) || { route: k, n: 0, status: {}, last: "", timeouts: 0 };
    e.n++; e.last = a.ts;
    const st = a.status || (/timed? ?out|Operation timed out/i.test(a.reply || "") ? "000" : "?");
    e.status[st] = (e.status[st] || 0) + 1;
    if (st === "000") e.timeouts++;
    g.set(k, e);
  }
  return [...g.values()].sort((a, b) => b.n - a.n).slice(0, max);
}

export const HARNESSES = ["claude", "codex", "copilot", "any"];

// ── vocabulary: what one harness calls a thing, the other does not ───────────
export const GLOSS = {
  codex: [
    [/\bsubagents?\b/gi, "helper runs the other agent dispatched"],
    [/\bthe Task tool\b/gi, "its delegation tool"],
    [/\bTodoWrite\b/g, "its in-session todo list"],
    [/\bthe Monitor tool\b/gi, "a background watcher it armed"],
  ],
  claude: [
    [/\bapply_patch\b/g, "its patch tool (the Edit/Write equivalent)"],
    [/\bthe sandbox\b/gi, "its approval sandbox"],
  ],
  copilot: [],
  any: [],
};

const SENTINEL = String.fromCharCode(1); // cannot occur in anything we render

/**
 * A translator into ONE target harness's vocabulary, which leaves code alone.
 *
 * Code spans are held out and put back: the first version of this table rewrote
 * "skill" inside a backticked flag name and produced a flag that does not exist.
 * A brief that reads oddly is recoverable; one that invents a command is not. The
 * table stays short for the same reason — it cannot tell a term it understands from
 * a term it merely matches, so generic words ("skill", "hook") are left out, and
 * real filenames (CLAUDE.md, AGENTS.md) are never vocabulary.
 */
export function makeGloss(target) {
  const rules = GLOSS[target] || [];
  return (text) => {
    const code = [];
    let out = String(text || "").replace(/`[^`]*`/g, (m) => {
      code.push(m);
      return `${SENTINEL}${code.length - 1}${SENTINEL}`;
    });
    for (const [re, to] of rules) out = out.replace(re, to);
    return out.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"), (_, i) => code[Number(i)]);
  };
}

export const clip = (t, n) => {
  const x = String(t || "").replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n)}…` : x;
};
export const estimateTokens = (t) => Math.ceil(String(t || "").length / 4); // chars/4
/** Keep line structure (a quoted CONTINUE pass is markdown), cut at a line or char cap. */
export function clipLines(t, maxLines, maxChars) {
  const lines = String(t || "").replace(/\r/g, "").split("\n");
  let out = [], n = 0;
  for (const l of lines) {
    if (out.length >= maxLines || n + l.length > maxChars) { out.push("…"); break; }
    out.push(l); n += l.length + 1;
  }
  return out.join("\n").trim();
}

/**
 * The human prompts of a codex session — which are NOT where a reader expects them.
 *
 * `parseCodex` collects `event_msg/user_message`, and a codex run that was seeded
 * rather than typed into (`codex "<prompt>"`, a Herdr pane, a batch runner) emits
 * none of those: its prompts arrive as `response_item/message` with role `user`.
 * Measured on a real board-monitor run — 17 such messages, zero `user_message`
 * events — so the Goal section came out empty for exactly the sessions a handoff is
 * about.
 *
 * That channel also carries the harness's injected envelopes (AGENTS.md, the plugin
 * list, each skill's body). They are recognisable by their leading tag and are
 * skipped rather than guessed at: a bad guess would put a wall of injected
 * instructions into the brief as "the goal", which is worse than saying nothing.
 */
const ENVELOPE = /^\s*<(?:recommended_plugins|skills?_instructions|skill|permissions|user_instructions|environment_context|task-notification)\b/i;
export function codexHumanPrompts(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const pl = o.payload || {};
    if (o.type !== "response_item" || pl.type !== "message" || pl.role !== "user") continue;
    const blocks = Array.isArray(pl.content) ? pl.content : [];
    const body = blocks.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n").trim();
    if (!body || ENVELOPE.test(body) || /^#+\s*AGENTS\.md\b/i.test(body)) continue;
    out.push(body);
  }
  return out;
}

/**
 * Anchors are for the RECEIVING agent, so they must be paths it will open: files in
 * the repo, relative to it. A previous session's temp scratchpad is worse than noise
 * here — it points into a tree the new session has no reason to trust and the OS may
 * already have cleared.
 */
const SCRATCHY = /(?:[\\/]|^)(?:Temp|tmp|scratchpad)(?:[\\/]|$)/i;
export function repoRelativeFiles(list, cwd) {
  const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
  const root = cwd ? norm(cwd).replace(/\/+$/, "") : "";
  const seen = new Set();
  const out = [];
  for (const f of list || []) {
    if (!f || SCRATCHY.test(f)) continue;
    const n = norm(f);
    if (root && !n.startsWith(`${root}/`)) continue;
    const rel = root ? String(f).slice(cwd.length).replace(/^[\\/]+/, "") : String(f);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/**
 * Bullets under the headings matching `re` — for the convention's standing sections
 * that `parseContinueDoc` does not itemise ("Tried and rejected"). Kept here rather
 * than added to repo.mjs: it is one shape this tool wants, and repo.mjs is consumed
 * by half a dozen other scripts.
 */
export function sectionBullets(path, re, cap = 6) {
  if (!path || !existsSync(path)) return [];
  const out = [];
  let inSection = false, fence = false, raw = null;
  // An indented line continues the bullet above it; a first-line read cut every
  // wrapped item mid-sentence ("Rejected by").
  const flush = () => { if (raw !== null) out.push(clip(raw, 240)); raw = null; };
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fence = !fence; flush(); continue; }
    if (fence) continue;
    const head = line.match(/^#{2,4}\s+(.*)$/);
    if (head) { flush(); inSection = re.test(head[1]); if (out.length >= cap) break; continue; }
    if (!inSection) continue;
    const b = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)(.+)$/);
    if (b && b[1].trim()) { flush(); if (out.length >= cap) break; raw = b[1]; continue; }
    if (raw !== null && /^\s{2,}\S/.test(line)) { raw += ` ${line.trim()}`; continue; }
    flush();
  }
  flush();
  return out.slice(0, cap);
}

export const TRIED_REJECTED_RE = /tried|rejected|do not|don'?t/i;

/**
 * The opening of the newest dated pass of a CONTINUE.md, verbatim. Its itemised "Next
 * steps" can be a standing section days older than the pass on top — measured: both
 * readers of a brief were handed four 2026-09-13 items while the 2026-09-18 pass said,
 * in prose, which six tickets were stuck and what a human had to run.
 */
export function newestPassHead(path, maxLines = 12, maxChars = 1100) {
  if (!path || !existsSync(path)) return null;
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  let best = null;
  lines.forEach((l, i) => {
    const h = l.match(/^##\s+(.*\d{4}-\d{2}-\d{2}.*)$/);
    if (!h) return;
    const d = h[1].match(/\d{4}-\d{2}-\d{2}/g).sort().pop();
    if (!best || d > best.date) best = { date: d, title: h[1].trim(), at: i };
  });
  if (!best) return null;
  const body = [];
  for (const l of lines.slice(best.at + 1)) { if (/^##\s/.test(l)) break; body.push(l); }
  // A pass opens with what landed; what is still open sits under a bold lead-in
  // further down ("**Still In Progress on the board, …:**"). Headline + those.
  const paras = body.join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const OPEN = /^\*\*[^*]*\b(?:still|open|next|blocked|left|todo|not (?:yet|pushed|done)|needs?|human|operator|unverified|pending)\b[^*]*\*\*/i;
  const open = paras.slice(1).filter((p) => OPEN.test(p)).slice(0, 2);
  if (!open.length) return { title: best.title, date: best.date, text: clipLines(body.join("\n").trim(), maxLines, maxChars) };
  const head = clip(paras[0].split("\n")[0], 220);
  return { title: best.title, date: best.date, text: [head, "…", ...open.map((p) => clipLines(p, 8, 520))].join("\n") };
}

const WORD_STOP = new Set("about after again also because before being between could does doing during every first from have into itself just more most much must never other over same should since some still such than that their them then there these they this those through under until very were what when where which while with would your only will been here make made like want need done open item next step once".split(" "));
const wordsOf = (t) => new Set((String(t || "").toLowerCase().replace(/`[^`]*`/g, (m) => ` ${m.slice(1, -1)} `).match(/[a-z][a-z0-9_-]{3,}/g) || []).filter((w) => !WORD_STOP.has(w)));

/**
 * Pair what a session left open with later commits that look like they closed it.
 *
 * Measured on a cut-off session: two of its open items (a BACKLOG entry it added,
 * a hook-trust question) were solved by commits 9c3adaa and a368100 the next day,
 * and a positional cut of the "since" list ("… 18 more in between") hid both. A
 * shared-words match is weak evidence and is worded as "may have": its job is to
 * put the candidate in front of the successor, not to close the item.
 */
export function matchOpenToLater(items, commits, { min = 2, touchesCode = null } = {}) {
  const list = (commits || []).filter(Boolean).map((c) => ({ c, w: wordsOf(`${c.subject} ${c.body || ""}`) }));
  // Only words RARE across the later commits count: in a repo whose every commit
  // says "codex" and "harness", those words match everything and prove nothing.
  const df = new Map();
  for (const { w } of list) for (const x of w) df.set(x, (df.get(x) || 0) + 1);
  const rare = Math.max(2, Math.ceil(list.length * 0.1));
  const out = [];
  for (const item of items || []) {
    const w = wordsOf(item);
    if (w.size < 2) continue;
    const hits = [];
    for (const { c, w: cw } of list) {
      const shared = [...w].filter((x) => cw.has(x) && (df.get(x) || 0) <= rare);
      if (shared.length >= min) hits.push({ sha: c.sha, subject: c.subject, shared: shared.slice(0, 5), n: shared.length });
    }
    // A docs-only commit records the work; the one that changed code did it. Ask
    // only for the hits, and rank a code commit one shared word ahead.
    // A docs-only hit is dropped: on a held-out session both word matches were
    // docs-only commits, both were wrong, and both became wrong answers.
    if (touchesCode) for (const x of hits) x.code = touchesCode(x.sha);
    const kept = hits.filter((x) => x.code !== false);
    kept.sort((a, b) => b.n - a.n);
    if (kept.length) out.push({ item, commits: kept.slice(0, 2) });
  }
  return out;
}

/**
 * What to carry from a compaction summary, chosen by KIND, not position. Measured: cut
 * after its first four bullets, the excerpt held the agent's own parse and encoding
 * slips and lost the "Standing constraints" and "Hypotheses … refuted" blocks that
 * three key facts lived in. So: named blocks that bind (constraints) or correct
 * (refutations) first, then errors about the system being operated before the
 * agent's tooling slips, then what was pending.
 */
const TOOL_SLIP = /\b(?:python|parser|unicode|encod|powershell|shell one-liner|one-liner|heredoc|escap|quoting|typo|my (?:error|shell|parse)|probe design|guessed non-existent|CACError|--pool)/i;
export function compactionPick(sections) {
  const blocks = [];
  // Split every section into bold-titled blocks ("**Standing constraints …:**").
  for (const [name, text] of Object.entries(sections || {})) {
    let cur = { title: name, lines: [] };
    for (const line of String(text).split("\n")) {
      const t = line.match(/^\s*\*\*([^*]{4,120}?):?\*\*:?\s*$/);
      if (t) { blocks.push(cur); cur = { title: t[1].trim(), section: name, lines: [] }; continue; }
      cur.lines.push(line);
    }
    blocks.push(cur);
  }
  const bullets = (b) => b.lines.filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, "").trim());
  const out = [];
  const constraint = blocks.find((b) => /constraint|standing|rules?\b|must not|never/i.test(b.title) && bullets(b).length);
  if (constraint) out.push(["standing constraints (its list)", constraint ? bullets(constraint).slice(0, 8).map((l) => `- ${clip(l, 150)}`).join("\n") : ""]);
  const refuted = blocks.find((b) => /refut|self-correct|withdrawn|was wrong/i.test(b.title) && bullets(b).length);
  if (refuted) out.push(["hypotheses it refuted (its claim — a refutation can be wrong too)", bullets(refuted).slice(0, 6).map((l) => `- ${clip(l, 200)}`).join("\n")]);
  const errs = blocks.filter((b) => b.title === "errors and fixes").flatMap(bullets);
  const ranked = [...errs.filter((l) => !TOOL_SLIP.test(l)), ...errs.filter((l) => TOOL_SLIP.test(l))];
  if (ranked.length) out.push(["errors and fixes (about the system first, its own tool slips last)", ranked.slice(0, 6).map((l) => `- ${clip(l, 200)}`).join("\n")]);
  for (const k of ["pending tasks", "current work"]) {
    const v = (sections || {})[k] || "";
    if (v.replace(/[\s….]/g, "").length > 20) out.push([k, clipLines(v.trim(), 12, k === "pending tasks" ? 900 : 450)]);
  }
  return out;
}

/**
 * The tickets a session worked on, each with what git says about it: commits in the
 * session's window and after it that name the number (`fix(#1176)`, `ak-1172`,
 * "Merge branch 'feature/ak-1172-…'"). An operator session's unit of work is the
 * ticket; its files are other agents' — measured on a 15-hour board session that
 * edited 2 files, filed 9 tickets and drove about 20 more through review and merge.
 */
export function ticketLedger(tickets, created, during, after, { max = 10 } = {}) {
  const made = new Map((created || []).map((c) => [c.n, c]));
  // Subject only: a body cites neighbouring tickets ("…withheld (#1167)") as evidence.
  const names = (c, n) => new RegExp(String.raw`(?:#|\bak-)${n}\b`, "i").test(c.subject);
  const pick = [...(tickets || [])];
  for (const c of created || []) if (!pick.some((t) => t.n === c.n)) pick.push({ n: c.n, mentions: 0, context: "" });
  // Filed-by-it first, then by how much it talked about each.
  pick.sort((a, b) => (made.has(b.n) - made.has(a.n)) || (b.mentions - a.mentions));
  return pick.slice(0, max).map((t) => {
    const dur = (during || []).filter((c) => names(c, t.n));
    const aft = (after || []).filter((c) => c && names(c, t.n));
    // A merge counts only when it is on the checked-out branch (`onHead`, when the
    // caller knows it). Measured: a ticket shown as merged whose merge commit sat
    // on a train branch.
    const isMerge = (c) => /^Merge\b/i.test(c.subject) && c.onHead !== false;
    const merged = aft.find(isMerge);
    const mergedIn = dur.find(isMerge);
    return {
      n: t.n, mentions: t.mentions, filed: made.has(t.n), title: (made.get(t.n) || {}).title || "",
      context: t.context || "",
      during: dur.slice(-2).map((c) => ({ sha: c.sha, subject: c.subject })), duringCount: dur.length,
      after: aft.slice(-2).map((c) => ({ sha: c.sha, when: c.when, subject: c.subject })), afterCount: aft.length,
      mergedAfter: merged ? { sha: merged.sha, when: merged.when } : null,
      mergedDuring: mergedIn ? { sha: mergedIn.sha, when: mergedIn.when } : null,
    };
  });
}

/**
 * Open items the repo itself records as landed: a struck heading in the
 * convention's `BACKLOG-landed.md` (`## ~~title~~ — **DONE** (date)`). Stronger
 * than a commit's shared words: it is the repo's own statement. Measured on a
 * cut-off session whose two BACKLOG entries were both struck there a day later,
 * while the brief still showed them open.
 */
export function matchLanded(items, landedText) {
  const heads = [...String(landedText || "").matchAll(/^#{2,4}\s+(.*~~.+)$/gm)].map((m) => m[1].trim());
  if (!heads.length) return [];
  const out = [];
  for (const item of items || []) {
    const w = wordsOf(item);
    if (w.size < 2) continue;
    let best = null;
    for (const h of heads) {
      const hw = wordsOf(h);
      const shared = [...w].filter((x) => hw.has(x)).length;
      // Measured against the HEADING: a long item shares two words with most
      // headings in a repo whose every entry says "codex" and "spend".
      const share = shared / (hw.size || 1);
      if (shared >= 2 && share >= 0.5 && (!best || share > best.share)) best = { heading: h, share };
    }
    if (best) out.push({ item, landed: best.heading });
  }
  return out;
}

/**
 * Assemble the brief model from already-gathered inputs.
 *
 * Everything IO-ish is passed in, so this stays testable: `summary` from
 * lib/parse.mjs `summarize()`, `git` from lib/repo.mjs `gitState()`, `docs` from
 * `readRepoDocs()`, `machine`/`scratch` from lib/handoff.mjs (claude only — a codex
 * session has no background tools, and the brief says so rather than implying that
 * nothing was left running).
 */
export function buildModel({
  provider, target = "any", sessionId, transcript, profile = "",
  summary, cwd = "", git = null, docs = null, machine = null, scratch = null,
  humanPrompts = [], triedRejected = [],
  facts = null, work = null, history = null, landing = null, successors = null, outside = null,
  countWarnings = null, built = null, openMatches = null, landedMatches = null, touchedLater = null,
  tickets = null, tags = null,
}) {
  const s = summary;
  const continuePath = docs?.continueDoc?.exists ? docs.continueDoc.path : null;
  const docNext = (docs?.open || []).filter((i) => /next/i.test(i.section || "")).slice(0, 5);
  const docOpen = (docs?.open || []).filter((i) => !docNext.includes(i)).slice(0, 6);
  // A /loop wakeup marker is the first or last "user" entry of an operator session;
  // measured on a held-out one, it stood as both Goal and Latest instruction.
  // A skill's injected body ("Base directory for this skill: …") is no instruction either.
  const real = (x) => (x && !isLoopWakeup(x) && !/^\s*Base directory for this skill:/i.test(x) ? x : "");
  const asks = humanPrompts.filter((p) => real(p));
  const first = asks[0] || "";
  const last = asks.length ? asks[asks.length - 1] : "";

  return {
    source: {
      harness: provider, model: s.model || "", sessionId: sessionId || s.sessionId || "",
      transcript, profile,
      startedAt: s.startTime || "", endedAt: s.endTime || "",
      turns: s.turns || 0, toolCalls: s.toolCalls || 0,
      stoppedBecause: s.endedOnLimit ? `${s.endedOnLimit} — cut off here`
        : s.endedInterrupted ? "user interrupt"
        : s.stopReason === "tool_use" ? "mid-tool-call (interrupted, or still running when this was written)"
        : (s.stopReason || "ended"),
    },
    target,
    cwd,
    goal: clip(s.aiTitle || real(s.firstPrompt) || real(s.firstUser) || first, 300),
    firstAsk: clip(real(s.firstPrompt) || real(s.firstUser) || first, 700),
    lastAsk: clip(real(s.lastPrompt) || real(s.lastUser) || last, 500),
    repo: git?.exists ? {
      dir: git.dir, branch: git.branch, dirty: git.dirty, ahead: git.ahead, behind: git.behind,
      tracked: git.tracked, lastCommit: git.lastCommit, lastCommitAt: git.lastCommitAt,
    } : null,
    recorded: {
      continuePath, backlogPath: docs?.backlogDoc?.exists ? docs.backlogDoc.path : null,
      newestPass: continuePath ? newestPassHead(continuePath) : null,
      hasLocalLayer: Boolean(docs?.hasLocal),
      passes: (docs?.continueDoc?.passes || []).slice(0, 2).map((p) => p.title),
      done: (docs?.continueDoc?.done || []).filter((i) => !i.stale).slice(0, 6).map((i) => i.text),
      next: docNext.map((i) => i.text),
      open: docOpen.map((i) => ({ text: i.text, doc: i.doc, stale: Boolean(i.stale) })),
      blocked: (docs?.blocked || []).slice(0, 4).map((i) => i.text),
      triedRejected,
      docWarnings: (docs?.warnings || []).map((w) => (typeof w === "string" ? w : w.message || JSON.stringify(w))),
    },
    // Where the work landed, when that is not where the session started.
    work: work ? {
      root: work.root, sessionCwd: work.sessionCwd || "", differsFromCwd: Boolean(work.differsFromCwd),
      remote: work.remote || null,
      others: (work.others || []).slice(0, 4),
    } : null,
    history: history ? {
      // Its own commits always; others in the window only as the newest ten.
      during: [...history.during.filter((c) => c.mine), ...history.during.filter((c) => !c.mine).slice(-10)],
      duringOthers: history.during.filter((c) => !c.mine).length,
      // The first commits after the end are the likeliest to have finished what the
      // session left open (its uncommitted work, its last ask); the newest say where
      // the repo is now. Both ends, the middle counted.
      // When the branch split is known, list the checked-out branch's commits: the
      // others are other agents' feature branches, counted but not listed.
      // Five, not nine: the ticket ledger and the landing line carry what the list was for.
      after: ((list) => (list.length > 6 ? [...list.slice(0, 3), null, ...list.slice(-2)] : list))(
        history.onHeadCount !== undefined ? history.after.filter((c) => c.onHead) : history.after),
      afterCount: history.after.length,
      onHeadCount: history.onHeadCount,
      afterListed: history.onHeadCount !== undefined ? history.onHeadCount : history.after.length,
      // A tracking-file pass dated after the session's last day was written by
      // someone later; the brief says so instead of letting it pass as the session's.
      passesAfterEnd: (docs?.continueDoc?.passes || []).filter((p) => p.date && s.endTime && p.date > s.endTime.slice(0, 10)).length,
    } : null,
    landing: landing ? {
      during: landing.during.map((c) => ({ sha: c.sha, subject: c.subject, files: c.files.length, pushed: Boolean(c.pushed), upstream: c.upstream || "", otherRemoteRefs: c.otherRemoteRefs || 0, otherRemoteRef: c.otherRemoteRef || "", author: c.author || "", onLocal: c.onLocal || "" })),
      after: landing.after.map((c) => ({ sha: c.sha, when: c.when, subject: c.subject, files: c.files.length, pushed: Boolean(c.pushed), upstream: c.upstream || "", otherRemoteRefs: c.otherRemoteRefs || 0, otherRemoteRef: c.otherRemoteRef || "" })),
      dirty: landing.dirty.slice(0, 8), dirtyCount: landing.dirty.length,
      none: landing.none.length,
    } : null,
    successors: (successors || []).slice(0, 3).map((l) => ({ sessionId: String(l.sessionId).slice(0, 8), via: l.via, when: l.when || "" })),
    session: facts ? {
      prompts: facts.humanPrompts.map((p) => clip(p.text, 260)),
      answers: facts.answers.map((a) => ({ question: clip(a.question, 160), answer: clip(a.answer, 160) })),
      tests: facts.tests.slice(-4),
      pushes: facts.pushes.slice(-3),
      failures: facts.failures.slice(-6),
      // A fetch that returned a 404 or a redirect notice is not a source.
      sources: facts.sources.filter((x) => x.kind !== "url" || x.ok || !x.failedFetches).slice(0, 10),
      subagents: facts.subagents,
      // Its own entries, newest last; each clipped by lines so the markdown stays whole.
      trackingWrites: (facts.trackingWrites || []).slice(-3).map((w) => ({
        file: String(w.file).split(/[\\/]/).pop(), ts: w.ts,
        text: clipLines(w.text, 18, 1400),
      })),
      lastGitStatus: facts.lastGitStatus ? { ts: facts.lastGitStatus.ts, count: facts.lastGitStatus.entries.length, sample: facts.lastGitStatus.entries.slice(0, 8) } : null,
      links: (facts.links || []).slice(-3),
      homeState: (facts.homeState || []).slice(0, 4),
      // Its own "Verified:" lines, newest last. The final one usually states the
      // end state (counts plus the live checks); the negatives say what was not.
      verified: (facts.verified || []).slice(-5),
      edits: facts.edits || {},
      http: httpLedger(facts.http),
      httpTotal: (facts.http || []).length,
      compactions: facts.compactions || 0,
      lastCompaction: facts.lastCompaction ? { ts: facts.lastCompaction.ts, pick: compactionPick(facts.lastCompaction.sections) } : null,
      bypasses: Object.entries(facts.bypasses || {}).map(([k, v]) => ({ flag: k, ...v })),
      loop: facts.loop && (facts.loop.wakeups || facts.loop.schedules || (facts.loop.crons || []).length) ? facts.loop : null,
      commitCommands: facts.commitCommands || 0,
      failedSources: facts.sources.filter((x) => x.kind === "url" && !x.ok && x.failedFetches).length,
    } : null,
    countWarnings: countWarnings || [],
    built: built || null,
    openMatches: openMatches || [],
    landedMatches: landedMatches || [],
    // All of them feed the fate check on open items; only the top eight are listed.
    // Measured: a ticket ranked eleventh was cut, and its stale "still running, do not
    // touch" line went through unmarked and misled both readers.
    tickets: (tickets || []).slice(0, 8),
    ticketFate: (tickets || []).filter((t) => t.mergedAfter || t.mergedDuring),
    tags: tags || [],
    touchedLater: (touchedLater || []).slice(0, 8),
    touchedLaterCount: (touchedLater || []).length,
    outside: (outside || []).slice(0, 8),
    asserted: {
      // The checklist is rendered on its own, so it is cut out of the quote.
      lastMessage: clip(String((facts && facts.lastReal) || s.lastAssistant || "").split(/\r?\n/)
        .filter((l) => !/^\s*[-*]\s*\[[ xX]\]/.test(l) && !/^\s*\*\*Next:\*\*/.test(l)).join("\n"), 900),
      lastIsReal: Boolean(facts && facts.lastReal),
      closing: facts ? facts.closingChecklist : null,
      openTodos: (machine?.todos?.todos || []).filter((t) => t.status !== "completed")
        .map((t) => `${t.status === "in_progress" ? "in progress" : "pending"}: ${clip(t.content, 120)}`).slice(0, 8),
    },
    anchors: {
      changed: repoRelativeFiles([...(s.filesEdited || []), ...(s.filesWritten || [])], cwd).slice(0, 12),
      read: repoRelativeFiles(s.filesRead || [], cwd).slice(0, 8),
    },
    machine: machine ? {
      background: machine.background.slice(-4).map((b) => ({ how: b.how, command: clip(b.command, 110), paths: b.paths.slice(0, 2) })),
      monitors: machine.monitors.slice(-3).map((m) => ({ description: clip(m.description, 120), persistent: m.persistent, paths: m.paths.slice(0, 2) })),
      services: Object.keys(machine.services || {}).map((p) => `127.0.0.1:${p}`),
      scratchpad: scratch ? { dir: scratch.dir, files: scratch.files, bytes: scratch.bytes, names: (scratch.names || []).slice(0, 6), secrets: scratch.secrets || [] } : null,
      notifications: machine.notifications.slice(-2).map((n) => ({ status: n.status, summary: clip(n.summary, 140) })),
    } : null,
  };
}

// ── how to continue, per target harness ──────────────────────────────────────
// The only harness-specific instructions in the brief. Everything else is neutral.
export function continuationBlock(target) {
  const common = [
    "1. Re-establish state before editing anything: `git status`, `git diff`, and the tracking files named above. The working tree is the truth; this brief is a summary of someone else's reading of it.",
    "2. State the next step and the constraints (the *do not redo* list) in your first message, before acting. If you cannot, this brief is incomplete — say what is missing rather than guessing.",
    "3. Everything under \"asserted by the prior session\" is unverified. Confirm it with a check, or repeat it as unverified.",
  ];
  if (target === "codex") {
    return [...common,
      "4. You are codex. The prior work was done by Claude Code, so its tool names and its transcript are not yours — but the repo conventions are: read `AGENTS.md` if the repo has one, otherwise `CLAUDE.md`, which applies to any agent working here.",
      "5. The transcript is readable JSONL, and reading it defeats the point — it is the thing this brief replaced. Read it only if a specific fact is missing, and say which.",
    ].join("\n");
  }
  if (target === "claude") {
    return [...common,
      "4. You are Claude Code. The prior work was done by codex, which has no subagents, no background tools and no session scratchpad — so nothing is running on its behalf and there is nothing of that kind to salvage.",
      "5. Read `CLAUDE.md` for the repo conventions. The prior session followed `AGENTS.md` if the repo has one; where they disagree, `CLAUDE.md` is the one addressed to you.",
    ].join("\n");
  }
  return common.join("\n");
}

// ── render ───────────────────────────────────────────────────────────────────
export function renderBrief(m, { budget = 4500 } = {}) {
  const gloss = makeGloss(m.target);
  const L = [];
  const src = m.source;
  const cwd = m.cwd;

  L.push(`# Handoff brief — ${src.harness} session ${String(src.sessionId).slice(0, 8)} → ${m.target === "any" ? "any agent" : m.target}`);
  L.push("");
  L.push("Written by session-inspector. A SUMMARY, not a transcript: the sections are fixed, and every claim names its source.");
  L.push("");
  L.push(`- **From:** ${src.harness}${src.model ? ` / ${src.model}` : ""}${src.profile ? ` (auth profile ${src.profile})` : ""}, session \`${src.sessionId}\``);
  L.push(`- **Ran:** ${src.startedAt || "?"} → ${src.endedAt || "?"} · ${src.turns} turns, ${src.toolCalls} tool calls`);
  L.push(`- **Stopped because:** ${src.stoppedBecause}`);
  if (m.work && m.work.differsFromCwd) {
    L.push(`- **Where the work is:** \`${m.work.root}\` — NOT the session's start directory (\`${m.work.sessionCwd}\`). Everything below about the repo is about the work repo.`);
  }
  if (m.work && m.work.remote && m.work.remote.url) {
    L.push(`- **Remote:** \`${m.work.remote.url}\`${m.work.remote.upstream ? ` · tracking \`${m.work.remote.upstream}\`` : " · branch has no upstream (not pushed?)"}`);
  }
  if (m.work && m.work.others.length) {
    L.push(`- **Also touched:** ${m.work.others.map((o) => `\`${o.root}\` (${o.writes} write(s))`).join(", ")}`);
  }
  if (m.repo) {
    const track = m.repo.tracked === false ? " · no upstream" : (m.repo.ahead || m.repo.behind) ? ` · ${m.repo.ahead} ahead / ${m.repo.behind} behind` : "";
    L.push(`- **Repo:** \`${m.repo.dir}\` on \`${m.repo.branch}\` · ${m.repo.dirty} uncommitted path(s)${track}`);
    if (m.repo.lastCommit) L.push(`- **Last commit:** ${m.repo.lastCommit}${m.repo.lastCommitAt ? ` (${m.repo.lastCommitAt})` : ""}`);
  } else if (cwd) {
    L.push(`- **Working directory:** \`${cwd}\` — not a git checkout, or git could not read it`);
  }
  L.push(`- **Full transcript**, if this brief proves insufficient: \`${src.transcript}\``);
  L.push("");

  const h = m.history;
  // ── one line a successor can act on: did its work land, where, is it pushed ──
  // Measured: with the landing commit and 27 later commits both listed, a receiver
  // still could not say whether the session's own diff was safe; it had to
  // reconcile two sections. The verdict is computed, never inferred from prose.
  const ld0 = m.landing;
  if (ld0 && (ld0.during.length || ld0.after.length || ld0.dirtyCount)) {
    const local = (c) => (c.onLocal ? `on local \`${c.onLocal}\`; ` : "");
    const where = (list) => list.map((c) => `\`${c.sha}\`${c.pushed ? ` (${local(c)}on \`${c.upstream || "upstream"}\`)`
      : c.otherRemoteRefs ? ` (${local(c)}**not on \`${c.upstream || "the upstream"}\`** — only inside ${c.otherRemoteRefs} other pushed branch(es), e.g. \`${c.otherRemoteRef}\`)`
      : ` (${local(c)}**not on any remote branch**)`}`).join(", ");
    const bits = [];
    if (ld0.dirtyCount) bits.push(`**${ld0.dirtyCount} of the files it edited are uncommitted right now**`);
    if (ld0.during.length) bits.push(`it committed its edits itself in ${where(ld0.during)}`);
    if (ld0.after.length) bits.push(`its edits were committed **after it ended**, by later work, in ${where(ld0.after)}`);
    const noGit = m.session && !m.session.commitCommands && !m.session.pushes.length ? " It ran no `git commit` and no `git push` itself." : "";
    // A commit authored as someone else (a test identity from a repo-local config)
    // is a finding in itself; measured on a board repo whose .git/config said E2ETest.
    const authors = [...new Set(ld0.during.map((c) => c.author).filter(Boolean))];
    const who = authors.length ? ` **Its commits are authored as ${authors.map((a) => `\`${a}\``).join(", ")}**, not the machine's global git identity.` : "";
    L.push(`**State in one line:** ${bits.join("; ")}.${noGit}${who}${m.successors && m.successors.length ? ` Session \`${m.successors[0].sessionId}\` picked it up.` : ""}`);
    L.push("");
  }
  if (h) {
    L.push("## Since the session ended");
    if (!h.afterCount) {
      L.push(`Nothing committed in the work repo since the session ended${src.endedAt ? ` (${src.endedAt})` : ""}. The repo state above is still the session's, apart from uncommitted changes nobody tracks.`);
    } else {
      const branch = m.repo ? `\`${m.repo.branch}\`` : "the checked-out branch";
      const split = h.onHeadCount !== undefined && h.onHeadCount !== h.afterCount
        ? ` — **${h.onHeadCount} of them on ${branch}** (listed), ${h.afterCount - h.onHeadCount} only on other branches`
        : "";
      L.push(`**${h.afterCount} commit(s) landed after the session ended**${split}, so the repo state and the tracking files describe NOW, not the moment it stopped. Check whether they already did what the session left open:`);
      for (const c of h.after) L.push(c === null ? `- _… ${h.afterListed - 5} more in between_` : `- \`${c.sha}\` ${c.when.slice(0, 16)} ${c.subject}`);
    }
    const ld = m.landing;
    if (ld && (ld.during.length || ld.after.length || ld.dirtyCount)) {
      const parts = [];
      if (ld.during.length) parts.push(`committed by the session: ${ld.during.map((c) => `\`${c.sha}\` (${c.files} file(s))`).join(", ")}`);
      if (ld.after.length) parts.push(`**committed after it ended**, by later work: ${ld.after.map((c) => `\`${c.sha}\` ${c.subject} (${c.files} file(s))`).join("; ")}`);
      if (ld.dirtyCount) parts.push(`**still uncommitted now:** ${ld.dirty.map((f) => `\`${f}\``).join(", ")}${ld.dirtyCount > ld.dirty.length ? ", …" : ""}`);
      if (ld.none) parts.push(`${ld.none} file(s) show no change in git (written back identical, reverted, or ignored)`);
      L.push(`- **Where the files it edited ended up:** ${parts.join(" · ")}`);
    }
    const via = { ledger: "handed off to it", brief: "read a handoff brief of this session", seed: "was seeded with a handoff brief of this session", mention: "mentions this session: a hint, not proof" };
    if (m.successors && m.successors.length) {
      L.push(`- **Already continued:** ${m.successors.map((x) => `session \`${x.sessionId}\` (${via[x.via] || x.via}${x.when ? `, last active ${String(x.when).slice(0, 16)}` : ""})`).join("; ")}. Read what it did before redoing anything.`);
    }
    if (m.tags.length) {
      // A tag after the end is a release, a deploy or a promotion. Anything it left
      // waiting on one may already have happened.
      const waits = ((m.asserted.closing && m.asserted.closing.open) || []).filter((o) => /promot|deploy|release|roll ?out|publish/i.test(o));
      L.push(`- **Tags created since it ended** (${m.tags.length}): ${m.tags.slice(-5).map((t) => `\`${t.name}\` (${String(t.when).slice(0, 16)})`).join(", ")}${m.tags.length > 5 ? ", …" : ""}.${waits.length ? ` **Its open item${waits.length > 1 ? "s" : ""} waiting on one may be stale:** ${waits.map((w) => `_${gloss(clip(w, 100))}_`).join("; ")}` : ""}`);
    }
    if (m.touchedLater.length) {
      L.push(`- **Later commits that changed files it wrote** (${m.touchedLaterCount}; its version of these files is no longer the current one):`);
      for (const c of m.touchedLater) L.push(`  - \`${c.sha}\` ${String(c.when).slice(0, 10)} ${clip(c.subject, 100)} — ${c.files.slice(0, 3).map((f) => `\`${f}\``).join(", ")}${c.files.length > 3 ? ", …" : ""}`);
    } else if (h.afterCount) {
      L.push("- **None of the later commits changed a file it wrote.**");
    }
    if (m.landedMatches.length) {
      L.push("- **Recorded as landed by the repo itself** (a struck heading in its `BACKLOG-landed.md`):");
      for (const x of m.landedMatches) L.push(`  - _${gloss(clip(x.item, 120))}_ → ${gloss(clip(x.landed, 200))}${x.by ? ` · struck in \`${x.by.sha}\` ${clip(x.by.subject, 90)}` : ""}`);
    }
    const maybe = m.openMatches;
    if (maybe.length) {
      L.push("- **Later commits that may have closed what it left open** (shared words, not proof — check each):");
      for (const x of maybe) L.push(`  - _${gloss(clip(x.item, 120))}_ → ${x.commits.map((c) => `\`${c.sha}\` ${clip(c.subject, 90)}${c.code === false ? " _(docs only)_" : ""}`).join("; ")}`);
    }
    if (h.passesAfterEnd) L.push(`- ${h.passesAfterEnd} pass(es) of \`CONTINUE.md\` are dated after the session's last day — written by later work, not by this session.`);
    const gs = m.session && m.session.lastGitStatus;
    if (gs && h.afterCount) {
      L.push(`- **At the session's end** (its own last \`git status\`, ${String(gs.ts).slice(0, 16)}): ${gs.count ? `${gs.count} changed path(s), e.g. ${gs.sample.map((e) => `\`${e.trim()}\``).join(", ")}` : "clean"}. That is the state it left; the header shows today's.`);
    }
    L.push("");
  }

  L.push("## Goal");
  L.push(gloss(m.firstAsk) || gloss(m.goal) || "(nothing captured — the transcript holds no human prompt)");
  if (m.lastAsk && m.lastAsk !== m.firstAsk) { L.push(""); L.push(`**Latest instruction:** ${gloss(m.lastAsk)}`); }
  // The first prompt of a long session is often a question ("what's in the
  // backlog?") and not the work. The heading it wrote into CONTINUE.md names the work.
  const STANDING = /^(?:what is true|verified|next steps?|blocked|tried|open|archive|landed|done)\b/i;
  const named = (m.session?.trackingWrites || [])
    .flatMap((w) => [...w.text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((x) => x[1].trim()))
    .filter((t) => !STANDING.test(t));
  if (named.length) { L.push(""); L.push(`**What the work became**, in the heading it wrote into its tracking file: _${gloss(clip(named[0], 200))}_`); }
  L.push("");

  // What exists because of it — up front, because a receiver asked "what is done"
  // answered from the closing checklist and skipped a design that sat further down,
  // inside a quoted CONTINUE entry.
  const bt = m.built;
  if (bt && (bt.created.length || bt.absorbedBy.length)) {
    L.push("## What it built");
    if (bt.created.length) L.push(`- **Files it created:** ${bt.created.map((f) => `\`${f}\``).join(", ")}${bt.createdMore ? `, +${bt.createdMore} more` : ""}`);
    for (const c of bt.absorbedBy) L.push(`- **Committed later as \`${c.sha}\`** _${gloss(c.subject)}_${c.body ? `: ${gloss(c.body)}` : ""}`);
    L.push("");
  }

  // ── the single next step, and what outranks it ──────────────────────────────
  // A receiver asked for "the next step" picks one line. Measured: with later
  // commits present it picked the tracking file's newest item (written by later
  // work) or the session's own stale closing line. So the order is fixed: later
  // work first, then the session's own words, labelled as its words.
  const cl = m.asserted.closing;
  const later = (h && h.afterCount) || (m.successors && m.successors.length);
  // An open item that names a ticket gets that ticket's later fate, inline: a reader
  // given the ledger two sections away still acted on "#1172 needs re-triggering"
  // after #1172 had merged — and read "merged after it ended" as "before".
  const endMs = src.endedAt ? Date.parse(src.endedAt) : 0;
  const fate = new Map((m.ticketFate || []).map((t) => [t.n, t]));
  // A write call that timed out, tied to the open items that would repeat it.
  const timedOut = ((m.session && m.session.http) || []).filter((r) => r.timeouts);
  const verbOf = (route) => route.split("/").filter((s) => s && !s.startsWith(":")).pop() || "";
  let startHereShown = false;
  const waitsOnRelease = /promot|deploy|release|roll ?out|publish/i;
  const annotate = (text, opts = {}) => {
    const hits = [...new Set([...String(text).matchAll(/#(\d{2,6})\b/g)].map((x) => x[1]))].filter((n) => fate.has(n));
    const notes = hits.map((n) => {
      const t = fate.get(n);
      // Merged INSIDE its window: the item was already stale when it was written down
      // (measured: "#1145 gate still running, do not touch" after #1145 had merged).
      if (t.mergedDuring && !t.mergedAfter) return `**#${n} had already merged before it ended** (\`${t.mergedDuring.sha}\`, ${String(t.mergedDuring.when).slice(0, 16)})`;
      const f = t.mergedAfter;
      const hrs = endMs ? Math.round((Date.parse(f.when) - endMs) / 3600000) : null;
      return `**#${n} merged later** (\`${f.sha}\`, ${String(f.when).slice(0, 16)}${hrs !== null ? `, ${hrs} h after it ended` : ""})`;
    });
    if (waitsOnRelease.test(text) && m.tags && m.tags.length) notes.push(`**${m.tags.length} tag(s) since, last \`${m.tags.at(-1).name}\`** — the wait may be over`);
    // Tied by the route's verb ("merge") or by the item asking to trigger again —
    // the wording of an open item is "needs re-triggering", not the route name.
    // Only where the item still asks to send again and nothing later settled it; on
    // every line that merely says "merge" it was noise (measured: attached to 12 lines).
    const retry = /re-?trigger|re-?send|re-?queue|unqueued|re-?run/i.test(text);
    const hit = retry && !notes.length && !opts.noRetry
      ? (timedOut.find((r) => new RegExp(String.raw`\b${verbOf(r.route)}`, "i").test(text)) || [...timedOut].sort((a, b) => b.timeouts - a.timeouts)[0])
      : null;
    if (hit) notes.push(`its \`${hit.route}\` calls timed out ${hit.timeouts}× — **check the job's state before re-sending**, a timed-out trigger may still have run`);
    return notes.length ? `${text} → ${notes.join(", ")}` : text;
  };
  if ((cl && (cl.next || cl.open.length)) || later) {
    L.push("## Next step");
    if (later) L.push(`- **First:** later work exists (see *Since the session ended*). Check whether it already did the step below before doing it.`);
    // Its open items are the work; its Next line is often only an offer ("say the
    // word and I'll bring it back"). Measured: an aborted merge that needed
    // re-triggering sat in the open items while Next said nothing about it.
    // When later work has overtaken most of what it left open, the repo's own newest
    // pass is the real front of the queue. Measured: both readers of a brief whose open
    // items had all merged since still framed them as the next step.
    const openAnn = cl ? cl.open.map((o) => annotate(gloss(o))) : [];
    const overtaken = openAnn.filter((o) => /merged later|already merged|the wait may be over/.test(o)).length;
    const np = m.recorded.newestPass;
    if (np && openAnn.length && overtaken * 2 >= openAnn.length && src.endedAt && np.date > src.endedAt.slice(0, 10)) {
      const lead = np.text.split("\n").filter((l) => l !== "…").slice(1).join(" ") || np.text;
      startHereShown = true;
      L.push(`- **Start here instead:** ${overtaken} of its ${openAnn.length} open item(s) were overtaken by later work. The repo's newest pass (_${gloss(np.title)}_, written after it ended) says: ${gloss(clip(lead, 420))}`);
    }
    if (cl && cl.open.length) L.push(`- **What it left open** (its words, unverified; later fate from git where a ticket is named): ${openAnn.slice(0, 4).join(" · ")}`);
    if (cl && cl.next) L.push(`- **The session's own next step** (its words, unverified): ${gloss(cl.next)}`);
    L.push("");
  }

  const se = m.session;
  if (se && (se.answers.length || se.prompts.length > 2)) {
    L.push("## What the human decided and asked, in order");
    for (const a of se.answers) L.push(`- **Asked:** ${gloss(a.question)} → **answered:** ${gloss(a.answer)}`);
    const ps = se.prompts;
    const shown = ps.length > 12 ? [...ps.slice(0, 2), null, ...ps.slice(-9)] : ps;
    for (const p of shown) L.push(p === null ? `- _(${ps.length - 11} more prompt(s) in between)_` : `- ${gloss(p)}`);
    if (se.loop && se.loop.wakeups) L.push(`- _(plus ${se.loop.wakeups} automatic \`/loop\` wakeups, ${String(se.loop.first).slice(0, 16)} → ${String(se.loop.last).slice(0, 16)}, not listed: no human wrote them)_`);
    L.push("");
  }
  if (m.tickets.length) {
    L.push("## Tickets it worked on, and what git says about each since");
    L.push("Its own mentions (a ticket named once is left out); git is matched on `#N` / `ak-N` in commit messages. A merge after the session means later work finished it.");
    for (const t of m.tickets) {
      const bits = [];
      if (t.filed) bits.push(`**filed by it**${t.title ? `: _${gloss(clip(t.title, 110))}_` : ""}`);
      if (t.mentions) bits.push(`named ${t.mentions}×`);
      if (t.mergedDuring) bits.push(`merged before it ended (\`${t.mergedDuring.sha}\`)`);
      else if (t.duringCount) bits.push(`${t.duringCount} commit(s) in its window, e.g. \`${t.during.at(-1).sha}\``);
      if (t.mergedAfter) bits.push(`**merged after it ended** (\`${t.mergedAfter.sha}\`, ${String(t.mergedAfter.when).slice(0, 16)})`);
      else if (t.afterCount) bits.push(`${t.afterCount} later commit(s), last \`${t.after.at(-1).sha}\` ${clip(t.after.at(-1).subject, 70)}`);
      else bits.push("no later commit names it");
      L.push(`- **#${t.n}** — ${bits.join(" · ")}`);
      if (!t.filed && t.context && t.mentions >= 10) L.push(`  _first mention:_ ${gloss(t.context)}`);
    }
    L.push("");
  }
  if (se && se.http && se.http.length) {
    L.push(`## What it changed through local services — ${se.httpTotal} write call(s), none of them in git`);
    for (const r of se.http) {
      const st = Object.entries(r.status).map(([k, v]) => `${k === "?" ? "no status printed" : `HTTP ${k}`}${v > 1 ? `×${v}` : ""}`).join(", ");
      L.push(`- \`${r.route}\` ×${r.n} (${st}; last ${String(r.last).slice(11, 16)})${r.timeouts ? ` — ⚠ ${r.timeouts} timed out (see *Problems it hit*)` : ""}`);
    }
    L.push("");
  }
  if (se && (se.pushes.length || (h && h.during.length))) {
    L.push("## What it committed and pushed");
    // Its own commits in full; commits in its window it never printed a sha for are
    // other agents' in a busy repo (measured: 8 of 10 on a board session), so they
    // are one counted line, not ten bodies.
    const during = h ? h.during : [];
    const mine = during.filter((c) => c.mine), others = during.filter((c) => !c.mine);
    for (const c of mine) {
      L.push(`- \`${c.sha}\` ${c.subject}`);
      if (c.body) L.push(`  ${gloss(c.body)}`);
    }
    const nOthers = h ? (h.duringOthers || others.length) : others.length;
    if (nOthers) L.push(`- _${nOthers} more commit(s) in its window that it did not make itself (no \`git commit\` of its printed them) — other agents':_ ${others.slice(-6).map((c) => `\`${c.sha}\` ${clip(c.subject, 60)}`).join("; ")}${nOthers > 6 ? "; …" : ""}`);
    for (const p of se.pushes) L.push(`- **Push** ${p.ok ? "succeeded" : "FAILED"}${p.remote ? ` to \`${p.remote}\`` : ""}${p.refs.length ? `: ${p.refs.join(", ")}` : ""}`);
    if (!se.pushes.length && h && h.during.length) L.push("- No push appears in the transcript.");
    L.push("");
  }
  if (se && se.tests.length) {
    L.push("## Checks it ran (the runner's own tally, last runs)");
    // The number a successor quotes is the LAST PASSING run's, stated once, first.
    // Measured: listed among older runs and a same-command revert check, it lost
    // to a stale "5" in the tracking file two rounds running.
    const passOf = (r) => { for (const l of r) { const x = l.match(/(?:ℹ\s*pass\s+(\d+))|(\d+)\s+(?:\w+\s+){0,2}passed/i); if (x) return Number(x[1] || x[2]); } return null; };
    const lastPass = [...se.tests].reverse().find((t) => t.ok && (t.runs || []).length && passOf(t.runs[0]) !== null);
    if (lastPass) L.push(`**Last passing run:** ${lastPass.runs.map(passOf).filter((n) => n !== null).join(" + ")} passed — \`${lastPass.command}\` at ${String(lastPass.ts).slice(11, 16)}.`);
    for (const w of m.countWarnings || []) L.push(`- **⚠ Stale count:** ${w.where} says "${w.docSays}"; the last run printed ${w.lastRun} passed. Trust the run.`);
    L.push("Runs, oldest first. A second run in one command is often a check that reverts a fix and expects the failure.");
    let prev = null;
    for (const t of se.tests) {
      const runs = t.runs && t.runs.length ? t.runs : [t.tally];
      // A `git stash` in the same command means the later runs ran with the fix
      // taken out — a failure there is the proof the test catches the defect.
      const label = (i) => (runs.length > 1 ? (i > 0 && t.stashed ? `run ${i + 1}, fix stashed (failure expected): ` : `run ${i + 1}: `) : "");
      const shown = runs.map((r, i) => `${label(i)}${r.length ? r.join(" · ") : "(no tally printed)"}`).join(" | ");
      const key = `${t.command}|${shown}`;
      if (prev && prev.key === key) { prev.n++; L[prev.at] = `${prev.line} ×${prev.n}`; continue; }
      const line = `- ${t.ok ? "" : "**errored** · "}${String(t.ts).slice(11, 16)} \`${t.command}\` → ${shown}`;
      L.push(line);
      prev = { key, n: 1, at: L.length - 1, line };
      if (t.diagnosis) L.push(`  _its diagnosis:_ ${gloss(t.firstError ? `${t.firstError} — ` : "")}${gloss(t.diagnosis)}`);
    }
    L.push("");
  }
  // Checks no runner tallied: a live call through a gateway, another repo's
  // contract script. Measured: the successor never learned of them, because the
  // runner list is all it was shown. Quoted, so they stay the session's claims.
  if (se && se.verified.length) {
    L.push("## What it says it verified — its own words");
    for (const v of se.verified) L.push(`- ${v.negative ? "**not verified:** " : ""}${String(v.ts).slice(11, 16)} (${v.where}) ${gloss(v.text)}`);
    L.push("");
  }
  if (se && se.trackingWrites.length) {
    L.push("## What it wrote into the tracking files itself");
    L.push(`Quoted from its own edits, so this is ITS record even if the file has changed since${h && h.passesAfterEnd ? " (it has: later passes sit on top)" : ""}. Still its own account: check what it claims.`);
    for (const w of se.trackingWrites) {
      L.push("");
      L.push(`\`${w.file}\`, ${String(w.ts).slice(0, 16)}:`);
      L.push("");
      L.push(w.text.split("\n").map((l) => `> ${gloss(l)}`).join("\n"));
    }
    L.push("");
  }
  if (se && (se.failures.length || se.bypasses.length || (se.http || []).some((x) => x.timeouts))) {
    L.push("## Problems it hit");
    // The same refusal five times is one problem; its count is the information.
    const groups = new Map();
    for (const x of se.failures.filter((f) => f.error)) {
      const k = `${x.tool}|${x.error.slice(0, 60)}`;
      const g = groups.get(k) || { ...x, n: 0 };
      g.n++; g.resolved = x.resolved; if (!g.diagnosis && x.diagnosis) g.diagnosis = x.diagnosis;
      groups.set(k, g);
    }
    for (const x of groups.values()) {
      L.push(`- ${x.tool}${x.n > 1 ? ` (×${x.n})` : ""}: ${clip(x.error, 170)}${x.resolved ? " — _the same tool succeeded afterwards_" : " — **no later success of that tool**"}`);
      // Its words right after an error are a first guess, and they misled: two readers
      // repeated one ("the store may be fine now") that the session later corrected.
      // Only a session with no compaction summary gets them; otherwise the summary's
      // "errors and fixes" below is the settled account.
      if (x.diagnosis && !(se.lastCompaction && se.lastCompaction.pick.length)) L.push(`  _its first reaction (a guess, may be superseded):_ ${gloss(clip(x.diagnosis, 220))}`);
    }
    for (const r of (se.http || []).filter((x) => x.timeouts)) {
      L.push(`- **Write call timed out:** \`${r.route}\` ${r.timeouts} of ${r.n} time(s). A timeout is not a failure: the server may have acted, and re-sending a trigger starts a duplicate job. Read the resource's state first.`);
    }
    for (const b of se.bypasses) {
      L.push(`- **Guard bypassed:** \`${b.flag}\` on ${b.n} command(s), ${String(b.first).slice(11, 16)} → ${String(b.last).slice(11, 16)}, e.g. \`${b.example.replace(/`/g, "'")}\`. The commands are the record; a later summary saying otherwise is wrong.`);
    }
    L.push("");
  }
  const lc = se && se.lastCompaction;
  if (lc && lc.pick.length) {
    const mins = src.endedAt ? Math.round((Date.parse(src.endedAt) - Date.parse(lc.ts)) / 60000) : null;
    L.push(`## Its own last compaction summary — asserted, ${String(lc.ts).slice(0, 16)}${mins !== null ? `, ${mins} min before it ended` : ""} (${se.compactions} in total)`);
    L.push("The harness wrote this from the session's context: the settled account of what went wrong and what was pending at that point, better than any single message. Still the session's own claim — the commands and git above win where they disagree.");
    for (const [k, v] of lc.pick) {
      if (/^hypotheses/.test(k)) continue; // its own section below
      L.push("");
      L.push(`**${k[0].toUpperCase()}${k.slice(1)}:**`);
      L.push(k === "pending tasks" ? v.split("\n").map((l) => annotate(gloss(l))).join("\n") : gloss(v));
    }
    L.push("");
  }
  // Hypotheses it tested and dropped, at the top level: quoted inside the summary,
  // neither reader used them. A refutation is still its claim, and one that a change
  // still in effect rests on is shown as disputed rather than silently believed.
  const refuted = lc && lc.pick.find(([k]) => /^hypotheses/.test(k));
  if (refuted) {
    L.push("## Do not re-chase — hypotheses it tested and dropped (its claim)");
    L.push(refuted[1].split("\n").map((l) => annotate(gloss(l), { noRetry: true })).join("\n"));
    // Split on hyphens and dots too: "pnpm-store-v2" and ".pnpm-store" share "pnpm", "store".
    const words = (s) => new Set((String(s).toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []).filter((w) => !/^(?:which|would|there|their|about|after|before|every|since|still|these|those|refuted|because|could|users|with|from|that|this|only|left|what|have|were)$/.test(w)));
    for (const [file, e] of Object.entries((se && se.edits) || {})) {
      if (!(m.outside || []).includes(file) || !e.reason) continue;
      const ew = words(`${e.reason} ${e.new}`);
      for (const line of refuted[1].split("\n")) {
        const shared = [...words(line)].filter((w) => ew.has(w));
        if (shared.length >= 2) L.push(`- **⚠ Disputed:** its change to \`${file}\` (\`${e.new.replace(/`/g, "'")}\`) rests on a premise this line calls refuted (shared: ${shared.slice(0, 4).join(", ")}). The change is still in effect. Verify which is true before reverting or keeping it.`);
      }
    }
    L.push("");
  }
  if (se && se.sources.length) {
    L.push("## Sources it relied on");
    for (const x of se.sources) L.push(x.kind === "url" ? `- ${x.value}` : `- search: _${clip(x.value, 140)}_`);
    if (se.failedSources) L.push(`- _(${se.failedSources} more URL(s) fetched but returned an error, a redirect notice or nothing usable — left out)_`);
    L.push("");
  }

  const rec = m.recorded;
  L.push(h && h.passesAfterEnd ? "## Recorded in the repo's tracking files — as they are NOW, including later work" : "## Recorded in the repo's tracking files");
  if (!rec.continuePath && !rec.backlogPath) {
    L.push("Nothing: this repo has no `CONTINUE.md` / `BACKLOG.md`. Everything below is the prior session's own assertion, so verify before relying on it.");
  } else {
    L.push(`Source: \`${rec.continuePath || "-"}\`${rec.backlogPath ? ` and \`${rec.backlogPath}\`` : ""}${rec.hasLocalLayer ? " (plus a gitignored `.local.md` layer — machine-specific, less settled, usually newer)" : ""}. **Read them; they are the settled picture and this brief only samples them.**`);
    if (rec.passes.length) { L.push(""); L.push(`Newest pass${rec.passes.length > 1 ? "es" : ""}: ${rec.passes.map((p) => `_${p}_`).join(" · ")}`); }
    if (rec.done.length) { L.push(""); L.push("**Done and recorded** — the doc's claim, with whatever check it names:"); for (const d of rec.done) L.push(`- ${gloss(d)}`); }
    // Itemised steps older than the newest pass are not the current next step; the
    // newest pass's own opening is, even when it is prose.
    const staleSteps = rec.docWarnings.some((w) => /predate its newest pass|come from passes older/.test(w));
    if (rec.newestPass && startHereShown) {
      L.push(""); L.push(`**The newest pass** (_${gloss(rec.newestPass.title)}_): its open item is quoted under *Next step* above.`);
    } else if (rec.newestPass && (staleSteps || !rec.next.length)) {
      L.push(""); L.push(`**The newest pass, opening** (_${gloss(rec.newestPass.title)}_ — read this before the itemised steps):`);
      L.push(rec.newestPass.text.split("\n").map((l) => `> ${gloss(l)}`).join("\n"));
    }
    if (rec.next.length) { L.push(""); L.push(staleSteps ? "**Itemised next steps — from an OLDER pass, check whether they still hold:**" : "**Next steps, as the doc has them:**"); for (const n of rec.next) L.push(`- ${gloss(n)}`); }
    if (rec.open.length) { L.push(""); L.push("**Open items:**"); for (const o of rec.open) L.push(`- ${gloss(o.text)}  _(${o.doc}${o.stale ? ", from an older pass — suspect" : ""})_`); }
    // With later passes on top, the file's blocked list is theirs, not this
    // session's; measured as the largest noise block in the round-2 brief.
    if (rec.blocked.length && !(h && h.passesAfterEnd)) { L.push(""); L.push("**Blocked / open questions:**"); for (const b of rec.blocked) L.push(`- ${gloss(b)}`); }
    if (!rec.done.length && !rec.next.length && !rec.open.length && !rec.blocked.length) {
      L.push("");
      L.push("Nothing itemised: the file is written as prose rather than as checkboxes or numbered steps, so **no conclusion about what is open can be drawn from this brief** — read the file.");
    }
    if (rec.docWarnings.length) { L.push(""); L.push(`**Distrust note:** ${rec.docWarnings.slice(0, 3).join(" · ")}`); }
  }
  L.push("");

  if (rec.triedRejected.length) {
    L.push("## Do not redo — tried and rejected");
    if (h && h.passesAfterEnd) L.push("_From the file as it is now: some of these were decided by later work, and all of them still bind._");
    for (const t of rec.triedRejected) L.push(`- ${gloss(t)}`);
    L.push("");
  }

  L.push("## Asserted by the prior session — unverified");
  L.push("Its own account of where it got to. No check backs any of it.");
  if (m.asserted.openTodos.length) { L.push(""); L.push("Its open task list:"); for (const t of m.asserted.openTodos) L.push(`- ${gloss(t)}`); }
  if (cl && (cl.done.length || cl.open.length || cl.next)) {
    L.push(""); L.push("Its closing checklist:");
    for (const d of cl.done) L.push(`- [x] ${gloss(d)}`);
    for (const o of cl.open) L.push(`- [ ] ${annotate(gloss(o))}`);
    if (cl.next) L.push(`- **Next (its words):** ${gloss(cl.next)}`);
  }
  if (m.asserted.lastMessage) { L.push(""); L.push(m.asserted.lastIsReal ? "Its last real message (a limit banner, if any, is skipped):" : "Its last message:"); L.push(""); L.push(`> ${gloss(m.asserted.lastMessage).replace(/\n/g, "\n> ")}`); }
  L.push("");

  const a = m.anchors;
  if (a.changed.length || a.read.length) {
    L.push("## Anchors");
    L.push(`Repo-relative${cwd ? ` to \`${cwd}\`` : ""}; the prior session's temp files are deliberately not listed.`);
    if (a.changed.length) L.push(`- **Changed:** ${a.changed.map((f) => `\`${f}\``).join(", ")}`);
    if (a.read.length) L.push(`- **Read:** ${a.read.map((f) => `\`${f}\``).join(", ")}`);
    L.push("");
  }

  L.push("## Machine state it left behind");
  if (!m.machine) {
    L.push(`A ${src.harness} session has no background tools, no delegated helper runs and no session scratchpad, so there is nothing of that kind to inherit. Anything it started from a shell command is not tracked here — check for stray processes if the work involved a server or a long build.`);
  } else {
    const any = m.machine.background.length || m.machine.monitors.length || m.machine.services.length || m.machine.scratchpad || m.machine.notifications.length;
    if (!any) L.push("Nothing detected: no detached processes, no watchers, no scratchpad files, no local services.");
    for (const b of m.machine.background) L.push(`- **Background (${b.how})** — VERIFY whether it is still alive: \`${b.command}\`${b.paths.length ? ` · log \`${b.paths.join("`, `")}\`` : ""}`);
    for (const w of m.machine.monitors) L.push(`- **Watcher armed${w.persistent ? ", persistent" : ""}:** ${w.description}${w.paths.length ? ` · watches \`${w.paths.join("`, `")}\`` : ""}`);
    if (m.machine.services.length) L.push(`- **Local services it talked to:** ${m.machine.services.join(", ")} — assume nothing about them still being up.`);
    const sp = m.machine.scratchpad;
    if (sp) {
      const names = sp.names && sp.names.length ? `: ${sp.names.map((n) => `\`${n}\``).join(", ")}${sp.files > sp.names.length ? ", …" : ""}` : "";
      L.push(`- **Its scratchpad** (the OS can clear it, and it is not yours): \`${sp.dir}\` — ${sp.files} file(s), ${(sp.bytes / 1048576).toFixed(1)} MB${names}`);
      if (sp.secrets && sp.secrets.length) {
        L.push(`- **⚠ Credential-looking content in its scratchpad:** ${sp.secrets.map((n) => `\`${n}\``).join(", ")} — the value is not shown here. Delete it once nothing needs it; it sits outside every repo and nothing cleans it up.`);
      }
    }
    for (const n of m.machine.notifications) L.push(`- **A delegated result arrived (${n.status || "event"}):** ${n.summary} — check whether it was acted on before the session stopped.`);
  }
  // Wiring outside every repo: git records none of it, so nothing else will say so.
  const se2 = m.session;
  const lp = se2 && se2.loop;
  if (lp && lp.lastSchedule) {
    const s = lp.lastSchedule;
    L.push(s.stop
      ? `- **Its wakeup loop was stopped** by its last scheduling call (${String(s.ts).slice(0, 16)}), after ${lp.schedules} scheduled wakeups.`
      : `- **⚠ Its wakeup loop may still be armed:** the last of ${lp.schedules} scheduled wakeups (${String(s.ts).slice(0, 16)}, +${s.delay}s${s.reason ? `, "${s.reason}"` : ""}) was never followed by a stop. A wakeup fires into whichever session owns it; check before starting your own loop.`);
  }
  for (const c of (lp && lp.crons) || []) L.push(`- **${c.tool}** ${String(c.ts).slice(0, 16)}: ${c.what}`);
  if (se2 && se2.links.length) {
    for (const k of se2.links) {
      L.push(`- **Created links** (junctions/symlinks, outside git)${k.target ? ` to \`${k.target}\`` : ""}${k.perProfile ? ", one per `~/.claude*` profile" : ""}${k.result ? ` — its output: \`${clip(k.result, 200)}\`` : ""}`);
    }
  }
  if (se2 && se2.homeState.length) {
    L.push("- **Per-user state it changed** (outside git, may hold live config or keys):");
    for (const x of se2.homeState) {
      L.push(`  - \`${x.dir}\` (${x.mentions}×)${x.files && x.files.length ? ` — files named there: ${x.files.map((f) => `\`${f}\``).join(", ")}` : ""}`);
      // Commands that SET something first; probes and cleanup after.
      const SETS = /\b(?:set|sync|config|init|install|add|enable|disable|write|migrate|login|register)\b/i;
      // Only commands that SET something; a probe (`Test-Path`, `echo "--- npmrc ---"`)
      // is a read, however many statements it chains.
      const sets = (c) => SETS.test(c) && !/^\s*(?:grep|S=|rm|echo|for|\$p\s*=)\b/.test(c);
      for (const c of (x.commands || []).filter(sets).slice(0, 3)) L.push(`    - ran: \`${c.replace(/`/g, "'")}\``);
      if (x.keyish && x.keyish.length) L.push(`    - **⚠ may hold a key:** ${x.keyish.map((f) => `\`${f}\``).join(", ")} — named on a line that also mentions a key or token. The value is not shown here.`);
    }
  }
  if (m.outside && m.outside.length) {
    L.push(`- **Files it wrote outside any git repo** (no history, no review — the change is only recorded here):`);
    const ed = (m.session && m.session.edits) || {};
    for (const f of m.outside) {
      const e = ed[f];
      L.push(`  - \`${f}\`${e ? `: \`${e.old.replace(/`/g, "'")}\` → \`${e.new.replace(/`/g, "'")}\` (${String(e.ts).slice(0, 16)}; still in effect unless reverted)` : ""}`);
      if (e && e.reason) L.push(`    _its reason, said just before:_ ${gloss(clip(e.reason, 240))} — if a later summary calls that premise refuted, the change still stands; check which is true before reverting.`);
    }
  }
  L.push("");

  L.push("## How to continue");
  L.push(continuationBlock(m.target));
  L.push("");
  L.push("## What this brief does not contain");
  L.push("The transcript, the tool output, the intermediate reasoning, and anything the prior session never wrote down. If a decision here carries no reason, the reason is not recoverable from this file — ask, or decide again and record it.");

  let text = `${L.join("\n")}\n`;
  // Budget, enforced by dropping in a fixed order so the trim is predictable:
  // anchors first (recoverable from git), the recoverable detail after, machine
  // state last. The recorded sections are never trimmed — they are the
  // evidence, and carrying them is what the brief is for.
  const drops = [
    [/\n## Anchors\n[\s\S]*?(?=\n## )/, "\n## Anchors\n_(dropped for the token budget — `git diff --stat` recovers it)_\n"],
    [/\n## Sources it relied on\n[\s\S]*?(?=\n## )/, "\n## Sources it relied on\n_(dropped for the token budget — the transcript's WebFetch calls hold them)_\n"],
    // The quoted tracking-file writes are the largest block and overlap the
    // "verified" and "built" sections; keep the newest quote, drop the older ones.
    // Measured: before this step, machine state (a key-bearing config file) went first.
    [/(\n## What it wrote into the tracking files itself\n[^\n]*\n)[\s\S]*?(\n`[^`\n]+`, [^\n]+:\n\n(?:> [^\n]*\n)+)(?=\n## )/, "$1\n_(older entries dropped for the token budget)_\n$2"],
    // Machine state goes LAST: measured on a session whose final instruction was
    // "stop the server and all workers", it was the section cut, twice.
    // Only the quoted message goes; its checklist and Next line above it stay.
    [/(\nIts last (?:real )?message[^\n]*\n\n)(?:> [^\n]*\n?)+/, "$1> _(trimmed for the token budget; its checklist above is kept)_\n"],
    [/\n  _its next words:_ [^\n]*/g, ""],
    [/\n  _first mention:_ [^\n]*/g, ""],
    // Cheaper than machine state, in this order: the compaction's "current work"
    // (its last few calls, superseded by everything after), the bodies of its commits
    // (`git show` has them), and itemised steps the file itself dates older.
    [/\n\n\*\*Current work:\*\*\n[\s\S]*?(?=\n\n## |\n## )/, "\n"],
    [(t) => t.replace(/(\n## What it committed and pushed\n)([\s\S]*?)(?=\n## )/, (_, h, body) => h + body.split("\n").filter((l) => !/^ {2}(?!_)\S/.test(l)).join("\n"))],
    [/\n\n\*\*Itemised next steps — from an OLDER pass[^\n]*\n(?:- [^\n]*\n?)+/, "\n"],
    [/\n## Machine state it left behind\n[\s\S]*?(?=\n## )/, "\n## Machine state it left behind\n_(dropped for the token budget — `analyze-claude-session.mjs --handoff` prints it)_\n"],
  ];
  for (const [re, to] of drops) {
    if (estimateTokens(text) <= budget) break;
    text = typeof re === "function" ? re(text) : text.replace(re, to);
  }
  return text;
}

/**
 * The seed prompt for the receiving session. A POINTER, never the brief text:
 * prompt text on a command line is torn apart by Windows Terminal's `;` handling and
 * by cmd's parentheses, while a path has no `;`, no newline and no quote.
 */
export function seedPrompt(sourceHarness, briefPath) {
  return `Continue work handed over from a ${sourceHarness} session. Read the handoff brief at ${briefPath} first, `
    + "then follow its \"How to continue\" section: re-establish state from git, state the next step and the do-not-redo list "
    + "before acting, and treat its \"asserted\" section as unverified.\n";
}
