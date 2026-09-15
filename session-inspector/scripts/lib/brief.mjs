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
  let inSection = false, fence = false;
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const head = line.match(/^#{2,4}\s+(.*)$/);
    if (head) { inSection = re.test(head[1]); continue; }
    if (!inSection) continue;
    const b = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)(.+)$/);
    if (b && b[1].trim()) out.push(clip(b[1], 200));
    if (out.length >= cap) break;
  }
  return out;
}

export const TRIED_REJECTED_RE = /tried|rejected|do not|don'?t/i;

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
    asserted: {
      lastMessage: clip(s.lastAssistant, 900),
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
      scratchpad: scratch ? { dir: scratch.dir, files: scratch.files, bytes: scratch.bytes } : null,
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
  if (m.repo) {
    const track = m.repo.tracked === false ? " · no upstream" : (m.repo.ahead || m.repo.behind) ? ` · ${m.repo.ahead} ahead / ${m.repo.behind} behind` : "";
    L.push(`- **Repo:** \`${m.repo.dir}\` on \`${m.repo.branch}\` · ${m.repo.dirty} uncommitted path(s)${track}`);
    if (m.repo.lastCommit) L.push(`- **Last commit:** ${m.repo.lastCommit}${m.repo.lastCommitAt ? ` (${m.repo.lastCommitAt})` : ""}`);
  } else if (cwd) {
    L.push(`- **Working directory:** \`${cwd}\` — not a git checkout, or git could not read it`);
  }
  L.push(`- **Full transcript**, if this brief proves insufficient: \`${src.transcript}\``);
  L.push("");

  L.push("## Goal");
  L.push(gloss(m.firstAsk) || gloss(m.goal) || "(nothing captured — the transcript holds no human prompt)");
  if (m.lastAsk && m.lastAsk !== m.firstAsk) { L.push(""); L.push(`**Latest instruction:** ${gloss(m.lastAsk)}`); }
  L.push("");

  const rec = m.recorded;
  L.push("## Recorded in the repo's tracking files");
  if (!rec.continuePath && !rec.backlogPath) {
    L.push("Nothing: this repo has no `CONTINUE.md` / `BACKLOG.md`. Everything below is the prior session's own assertion, so verify before relying on it.");
  } else {
    L.push(`Source: \`${rec.continuePath || "-"}\`${rec.backlogPath ? ` and \`${rec.backlogPath}\`` : ""}${rec.hasLocalLayer ? " (plus a gitignored `.local.md` layer — machine-specific, less settled, usually newer)" : ""}. **Read them; they are the settled picture and this brief only samples them.**`);
    if (rec.passes.length) { L.push(""); L.push(`Newest pass${rec.passes.length > 1 ? "es" : ""}: ${rec.passes.map((p) => `_${p}_`).join(" · ")}`); }
    if (rec.done.length) { L.push(""); L.push("**Done and recorded** — the doc's claim, with whatever check it names:"); for (const d of rec.done) L.push(`- ${gloss(d)}`); }
    if (rec.next.length) { L.push(""); L.push("**Next steps, as the doc has them:**"); for (const n of rec.next) L.push(`- ${gloss(n)}`); }
    if (rec.open.length) { L.push(""); L.push("**Open items:**"); for (const o of rec.open) L.push(`- ${gloss(o.text)}  _(${o.doc}${o.stale ? ", from an older pass — suspect" : ""})_`); }
    if (rec.blocked.length) { L.push(""); L.push("**Blocked / open questions:**"); for (const b of rec.blocked) L.push(`- ${gloss(b)}`); }
    if (!rec.done.length && !rec.next.length && !rec.open.length && !rec.blocked.length) {
      L.push("");
      L.push("Nothing itemised: the file is written as prose rather than as checkboxes or numbered steps, so **no conclusion about what is open can be drawn from this brief** — read the file.");
    }
    if (rec.docWarnings.length) { L.push(""); L.push(`**Distrust note:** ${rec.docWarnings.slice(0, 3).join(" · ")}`); }
  }
  L.push("");

  if (rec.triedRejected.length) {
    L.push("## Do not redo — tried and rejected");
    for (const t of rec.triedRejected) L.push(`- ${gloss(t)}`);
    L.push("");
  }

  L.push("## Asserted by the prior session — unverified");
  L.push("Its own account of where it got to. No check backs any of it.");
  if (m.asserted.openTodos.length) { L.push(""); L.push("Its open task list:"); for (const t of m.asserted.openTodos) L.push(`- ${gloss(t)}`); }
  if (m.asserted.lastMessage) { L.push(""); L.push("Its last message:"); L.push(""); L.push(`> ${gloss(m.asserted.lastMessage).replace(/\n/g, "\n> ")}`); }
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
    if (m.machine.scratchpad) L.push(`- **Its scratchpad** (the OS can clear it, and it is not yours): \`${m.machine.scratchpad.dir}\` — ${m.machine.scratchpad.files} file(s), ${(m.machine.scratchpad.bytes / 1048576).toFixed(1)} MB`);
    for (const n of m.machine.notifications) L.push(`- **A delegated result arrived (${n.status || "event"}):** ${n.summary} — check whether it was acted on before the session stopped.`);
  }
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
