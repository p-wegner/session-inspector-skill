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
}) {
  const s = summary;
  const continuePath = docs?.continueDoc?.exists ? docs.continueDoc.path : null;
  const docNext = (docs?.open || []).filter((i) => /next/i.test(i.section || "")).slice(0, 5);
  const docOpen = (docs?.open || []).filter((i) => !docNext.includes(i)).slice(0, 6);
  const first = humanPrompts[0] || "";
  const last = humanPrompts.length ? humanPrompts[humanPrompts.length - 1] : "";

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
    goal: clip(s.aiTitle || s.firstPrompt || s.firstUser || first, 300),
    firstAsk: clip(s.firstPrompt || s.firstUser || first, 700),
    lastAsk: clip(s.lastPrompt || s.lastUser || last, 500),
    repo: git?.exists ? {
      dir: git.dir, branch: git.branch, dirty: git.dirty, ahead: git.ahead, behind: git.behind,
      tracked: git.tracked, lastCommit: git.lastCommit, lastCommitAt: git.lastCommitAt,
    } : null,
    recorded: {
      continuePath, backlogPath: docs?.backlogDoc?.exists ? docs.backlogDoc.path : null,
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
      during: history.during.slice(-10),
      // The first commits after the end are the likeliest to have finished what the
      // session left open (its uncommitted work, its last ask); the newest say where
      // the repo is now. Both ends, the middle counted.
      after: history.after.length > 10 ? [...history.after.slice(0, 6), null, ...history.after.slice(-3)] : history.after,
      afterCount: history.after.length,
      // A tracking-file pass dated after the session's last day was written by
      // someone later; the brief says so instead of letting it pass as the session's.
      passesAfterEnd: (docs?.continueDoc?.passes || []).filter((p) => p.date && s.endTime && p.date > s.endTime.slice(0, 10)).length,
    } : null,
    landing: landing ? {
      during: landing.during.map((c) => ({ sha: c.sha, subject: c.subject, files: c.files.length, pushed: Boolean(c.pushed) })),
      after: landing.after.map((c) => ({ sha: c.sha, when: c.when, subject: c.subject, files: c.files.length, pushed: Boolean(c.pushed) })),
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
      commitCommands: facts.commitCommands || 0,
      failedSources: facts.sources.filter((x) => x.kind === "url" && !x.ok && x.failedFetches).length,
    } : null,
    countWarnings: countWarnings || [],
    built: built || null,
    openMatches: openMatches || [],
    landedMatches: landedMatches || [],
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
      background: machine.background.slice(-4).map((b) => ({ how: b.how, command: clip(b.command, 160), paths: b.paths.slice(0, 2) })),
      monitors: machine.monitors.slice(-3).map((m) => ({ description: clip(m.description, 120), persistent: m.persistent, paths: m.paths.slice(0, 2) })),
      services: Object.keys(machine.services || {}).map((p) => `127.0.0.1:${p}`),
      scratchpad: scratch ? { dir: scratch.dir, files: scratch.files, bytes: scratch.bytes, names: (scratch.names || []).slice(0, 12), secrets: scratch.secrets || [] } : null,
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
    const where = (list) => list.map((c) => `\`${c.sha}\`${c.pushed ? " (pushed)" : " (**not on any remote branch**)"}`).join(", ");
    const bits = [];
    if (ld0.dirtyCount) bits.push(`**${ld0.dirtyCount} of the files it edited are uncommitted right now**`);
    if (ld0.during.length) bits.push(`it committed its edits itself in ${where(ld0.during)}`);
    if (ld0.after.length) bits.push(`its edits were committed **after it ended**, by later work, in ${where(ld0.after)}`);
    const noGit = m.session && !m.session.commitCommands && !m.session.pushes.length ? " It ran no `git commit` and no `git push` itself." : "";
    L.push(`**State in one line:** ${bits.join("; ")}.${noGit}${m.successors && m.successors.length ? ` Session \`${m.successors[0].sessionId}\` picked it up.` : ""}`);
    L.push("");
  }
  if (h) {
    L.push("## Since the session ended");
    if (!h.afterCount) {
      L.push(`Nothing committed in the work repo since the session ended${src.endedAt ? ` (${src.endedAt})` : ""}. The repo state above is still the session's, apart from uncommitted changes nobody tracks.`);
    } else {
      L.push(`**${h.afterCount} commit(s) landed after the session ended**, so the repo state and the tracking files describe NOW, not the moment it stopped. Check whether they already did what the session left open:`);
      for (const c of h.after) L.push(c === null ? `- _… ${h.afterCount - 9} more in between_` : `- \`${c.sha}\` ${c.when.slice(0, 16)} ${c.subject}`);
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
  if ((cl && (cl.next || cl.open.length)) || later) {
    L.push("## Next step");
    if (later) L.push(`- **First:** later work exists (see *Since the session ended*). Check whether it already did the step below before doing it.`);
    if (cl && cl.next) L.push(`- **The session's own next step** (its words, unverified): ${gloss(cl.next)}`);
    else if (cl && cl.open.length) L.push(`- **The session's first open item** (its words, unverified): ${gloss(cl.open[0])}`);
    L.push("");
  }

  const se = m.session;
  if (se && (se.answers.length || se.prompts.length > 2)) {
    L.push("## What the human decided and asked, in order");
    for (const a of se.answers) L.push(`- **Asked:** ${gloss(a.question)} → **answered:** ${gloss(a.answer)}`);
    const ps = se.prompts;
    const shown = ps.length > 12 ? [...ps.slice(0, 2), null, ...ps.slice(-9)] : ps;
    for (const p of shown) L.push(p === null ? `- _(${ps.length - 11} more prompt(s) in between)_` : `- ${gloss(p)}`);
    L.push("");
  }
  if (se && (se.pushes.length || (h && h.during.length))) {
    L.push("## What it committed and pushed");
    for (const c of (h ? h.during : [])) {
      L.push(`- \`${c.sha}\` ${c.subject}${c.mine ? "" : "  _(in the session's window; the transcript never printed this sha — may be another session's)_"}`);
      if (c.body) L.push(`  ${gloss(c.body)}`);
    }
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
  if (se && se.failures.length) {
    L.push("## Problems it hit");
    for (const x of se.failures.filter((f) => f.error)) {
      L.push(`- ${x.tool}: ${x.error}${x.resolved ? " — _the same tool succeeded afterwards_" : " — **no later success of that tool**"}`);
      if (x.diagnosis) L.push(`  _its next words:_ ${gloss(x.diagnosis)}`);
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
    if (rec.next.length) { L.push(""); L.push("**Next steps, as the doc has them:**"); for (const n of rec.next) L.push(`- ${gloss(n)}`); }
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
    for (const o of cl.open) L.push(`- [ ] ${gloss(o)}`);
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
      const cmds = [...(x.commands || [])].sort((p, q) => (SETS.test(q) && !/^\s*(?:grep|S=|rm)\b/.test(q)) - (SETS.test(p) && !/^\s*(?:grep|S=|rm)\b/.test(p)));
      for (const c of cmds.slice(0, 3)) L.push(`    - ran: \`${c.replace(/`/g, "'")}\``);
      if (x.keyish && x.keyish.length) L.push(`    - **⚠ may hold a key:** ${x.keyish.map((f) => `\`${f}\``).join(", ")} — named on a line that also mentions a key or token. The value is not shown here.`);
    }
  }
  if (m.outside && m.outside.length) L.push(`- **Files it wrote outside any git repo:** ${m.outside.map((f) => `\`${f}\``).join(", ")}`);
  L.push("");

  L.push("## How to continue");
  L.push(continuationBlock(m.target));
  L.push("");
  L.push("## What this brief does not contain");
  L.push("The transcript, the tool output, the intermediate reasoning, and anything the prior session never wrote down. If a decision here carries no reason, the reason is not recoverable from this file — ask, or decide again and record it.");

  let text = `${L.join("\n")}\n`;
  // Budget, enforced by dropping in a fixed order so the trim is predictable:
  // anchors first (recoverable from git), then the machine-state detail, then the
  // quoted last message. The recorded sections are never trimmed — they are the
  // evidence, and carrying them is what the brief is for.
  const drops = [
    [/\n## Anchors\n[\s\S]*?(?=\n## )/, "\n## Anchors\n_(dropped for the token budget — `git diff --stat` recovers it)_\n"],
    [/\n## Sources it relied on\n[\s\S]*?(?=\n## )/, "\n## Sources it relied on\n_(dropped for the token budget — the transcript's WebFetch calls hold them)_\n"],
    // The quoted tracking-file writes are the largest block and overlap the
    // "verified" and "built" sections; keep the newest quote, drop the older ones.
    // Measured: before this step, machine state (a key-bearing config file) went first.
    [/(\n## What it wrote into the tracking files itself\n[^\n]*\n)[\s\S]*?(\n`[^`\n]+`, [^\n]+:\n\n(?:> [^\n]*\n)+)(?=\n## )/, "$1\n_(older entries dropped for the token budget)_\n$2"],
    [/\n## Machine state it left behind\n[\s\S]*?(?=\n## )/, "\n## Machine state it left behind\n_(dropped for the token budget — `analyze-claude-session.mjs --handoff` prints it)_\n"],
    [/(\n## Asserted by the prior session[\s\S]{0,400})[\s\S]*?(?=\n## )/, "$1\n_(its last message trimmed for the token budget)_\n"],
  ];
  for (const [re, to] of drops) {
    if (estimateTokens(text) <= budget) break;
    text = text.replace(re, to);
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
