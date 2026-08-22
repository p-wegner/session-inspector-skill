#!/usr/bin/env node
/**
 * Find CUT-OFF sessions that are worth RESUMING — the ones a usage/rate limit
 * killed mid-task (or a user interrupted) — and print the exact command to pick
 * each back up. This is the discovery half of "I got rate-limited, continue that
 * session": it locates the session across every Claude profile home and hands you
 * a ready-to-run resume line; the single-session analyzer is the explain half.
 *
 * Why a dedicated tool: the analyzer's `hitLimit` flag fires on ANY mention of a
 * limit, so a session that merely quotes/discusses the banner reads as a limit
 * hit. This tool ranks on `endedOnLimit` — the banner as the session's FINAL
 * assistant message — which is the trustworthy "actually cut off here" signal.
 *
 * Usage:
 *   node scripts/resumable.mjs                     # all profiles, last 7 days, ranked by recency
 *   node scripts/resumable.mjs --project webapp # substring: session cwd / project dir / git remote
 *   node scripts/resumable.mjs --cwd               # only sessions whose cwd is the current directory
 *   node scripts/resumable.mjs --days 30           # widen the mtime window (default 7; 0 = all time)
 *   node scripts/resumable.mjs --interrupted       # also include user-interrupted sessions
 *   node scripts/resumable.mjs --all-endings       # include normal-ending sessions too (just rank by recency)
 *   node scripts/resumable.mjs --latest            # print ONLY the top hit + its resume command
 *   node scripts/resumable.mjs --resume            # print ONLY the resume command for the top hit (scriptable)
 *   node scripts/resumable.mjs --top 20            # how many to list (default 12)
 *   node scripts/resumable.mjs --include-instant   # list instant deaths individually too
 *   node scripts/resumable.mjs --json
 *
 * Instant deaths — sessions that died within seconds of launch with zero tool
 * calls (typically a fleet launched into an exhausted profile window) — carry
 * NOTHING to resume: `claude --resume` would reopen an empty session. They are
 * grouped into one summary block per launch directory with "relaunch the work,
 * don't resume" advice, instead of drowning the ranked list (observed: 53 such
 * 1-turn corpses burying the two real resumable sessions).
 *
 * Then continue it:
 *   cd <cwd> && CLAUDE_CONFIG_DIR=<home> claude --resume <sessionId>
 *   (or inspect first:  node scripts/analyze-claude-session.mjs <path> --events -v)
 */

import { readFileSync, statSync } from "fs";
import { basename, dirname } from "path";
import { discover, projectIdentity } from "./lib/sessions.mjs";
import { parseClaude } from "./lib/parse.mjs";
import { findSuccessors, successorLabel, strongLinks } from "./lib/successor.mjs";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const projectQ = (opt("--project", "") || "").toLowerCase();
const useCwd = has("--cwd");
const days = parseInt(opt("--days", "7"), 10);
const top = parseInt(opt("--top", "12"), 10);
const includeInterrupted = has("--interrupted");
const allEndings = has("--all-endings");
const includeInstant = has("--include-instant");
const includeSubagents = has("--include-subagents");
const includeContinued = has("--include-continued");
const latest = has("--latest");
const resumeOnly = has("--resume");
const asJson = has("--json");
// stat-prefilter window (0 = all time). +1 day slack so a session that spilled
// past midnight isn't dropped by an mtime that's just over the boundary.
const windowStartMs = days > 0 ? Date.now() - days * 86400000 - 86400000 : 0;
const cwdKey = useCwd ? process.cwd().replace(/\\/g, "/").toLowerCase() : "";

// ── classify a session's ending ──────────────────────────────────────────────
// endedOnLimit is the strong signal (banner as FINAL message). We rank it above
// interrupts, which are above everything else.
function ending(s) {
  if (s.endedOnLimit === "usage-limit") return { kind: "usage-limit", rank: 3, label: "⛔ USAGE LIMIT" };
  if (s.endedOnLimit === "rate-limit") return { kind: "rate-limit", rank: 3, label: "⛔ RATE LIMIT" };
  if (s.stopReason === "tool_use") return { kind: "mid-tool", rank: 2, label: "… MID-TOOL-CALL" };
  if (s.endedInterrupted) return { kind: "interrupted", rank: 1, label: "✋ INTERRUPTED" };
  return { kind: "normal", rank: 0, label: "ended normally" };
}

// ── home + resume command ────────────────────────────────────────────────────
// A main transcript is <home>/projects/<projectDir>/<id>.jsonl, but a subagent's
// is <home>/projects/<projectDir>/<parentId>/subagents/agent-<id>.jsonl — two
// levels deeper. Counting `dirname` hops therefore lands on the PROJECT DIR for
// nested transcripts, and CLAUDE_CONFIG_DIR pointed at a project dir cannot
// resolve anything (measured: every subagent row printed an unusable resume
// command). Anchor on the `projects` path segment instead, which is fixed for
// every layout.
function homeDir(path) {
  const parts = String(path).split(/[\\/]/);
  const i = parts.lastIndexOf("projects");
  if (i > 0) return parts.slice(0, i).join("\\");
  return dirname(dirname(dirname(path)));
}
function projectDirName(path) {
  const parts = String(path).split(/[\\/]/);
  const i = parts.lastIndexOf("projects");
  if (i >= 0 && parts[i + 1]) return parts[i + 1];
  return basename(dirname(path));
}

function resumeCommand(s, path) {
  const home = homeDir(path);
  const tag = basename(home);
  const cwd = s.cwd || "<cwd unknown — check the session>";
  const id = s.sessionId;
  // The session lives under a specific profile home; resuming under the wrong
  // profile won't find it. Only set CLAUDE_CONFIG_DIR when it's a non-default home.
  const isDefault = tag === ".claude";
  const bash = isDefault
    ? `cd "${cwd}" && claude --resume ${id}`
    : `cd "${cwd}" && CLAUDE_CONFIG_DIR="${home}" claude --resume ${id}`;
  const pwsh = isDefault
    ? `Set-Location "${cwd}"; claude --resume ${id}`
    : `$env:CLAUDE_CONFIG_DIR="${home}"; Set-Location "${cwd}"; claude --resume ${id}`;
  return { bash, pwsh, home, tag, cwd, id };
}

// ── local-time formatting (no external deps) ─────────────────────────────────
function localTime(iso) {
  if (!iso) return "?";
  const d = new Date(iso);
  if (isNaN(d)) return "?";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function oneLine(t, n = 90) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// A session that died within moments of launch, having called no tool, has no
// context worth resuming — the launch itself must be repeated (usually after the
// limit window resets, or under a profile with headroom).
function isInstantDeath(s) {
  return (s.toolCalls || 0) === 0 && (s.assistantTurns || 0) <= 2 && (s.durationSec || 0) < 120;
}

// ── collect ──────────────────────────────────────────────────────────────────
const sessions = discover("claude");
const hits = [];
const instant = [];

for (const s of sessions) {
  if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
  // A subagent is not independently resumable — `claude --resume` takes the
  // PARENT's id, and a shared-account limit kills parent and children together,
  // so one cut-off orchestrator contributes a whole fan-out of look-alike rows.
  // Measured: 9 of the top 10 rows were one parent's 20 research subagents,
  // burying the 3 real cut-offs. Recover their output with subagent-results.mjs.
  if (!includeSubagents && (s.kind || "main") !== "main") continue;
  let content;
  try { content = readFileSync(s.path, "utf-8"); } catch { continue; }
  const stat = parseClaude(content.split("\n"));
  const end = ending(stat);
  if (!allEndings && end.rank === 0) continue;
  if (!allEndings && !includeInterrupted && end.rank < 2) continue; // limits + mid-tool only by default

  // project filter
  const idn = projectIdentity(stat.cwd);
  const dir = projectDirName(s.path);
  if (projectQ) {
    const hay = `${idn.projectKey} ${stat.cwd} ${dir}`.toLowerCase();
    if (!hay.includes(projectQ)) continue;
  }
  if (cwdKey) {
    const scwd = (stat.cwd || "").replace(/\\/g, "/").toLowerCase();
    if (scwd !== cwdKey) continue;
  }

  const hit = {
    end, stat, path: s.path, dir, kind: s.kind || "main",
    parentSessionId: s.parentSessionId || "",
    project: idn.project,
    cutoff: stat.endTime,
    cutoffLocal: localTime(stat.endTime),
    mtime: s.mtime,
    resume: resumeCommand(stat, s.path),
  };
  if (!includeInstant && end.rank >= 2 && isInstantDeath(stat)) instant.push(hit);
  else hits.push(hit);
}

// ── has someone already picked this up? ──────────────────────────────────────
// A cut-off session whose work another session finished is not work — it is
// noise that outranks everything real, because severity+recency both favour it.
const succ = findSuccessors(
  hits.filter((h) => h.kind === "main").map((h) => ({ sessionId: h.stat.sessionId, path: h.path, endTime: h.cutoff })),
  sessions,
);
for (const h of hits) {
  h.successors = succ.get(h.stat.sessionId) || [];
  h.strong = strongLinks(h.successors);
  h.successorLabel = successorLabel(h.successors);
}
// Only a machine-written handoff (ledger/brief) is grounds for hiding a session.
// A same-repo id mention stays in the list, annotated — it is a hint to check,
// not a fact, and treating it as one silently drops real cut-off work.
const continued = hits.filter((h) => h.strong.length);
const openHits = includeContinued ? hits : hits.filter((h) => !h.strong.length);

// rank: severity desc, then recency desc
openHits.sort((a, b) => (b.end.rank - a.end.rank) || (new Date(b.cutoff) - new Date(a.cutoff)));
hits.length = 0;
hits.push(...openHits);

// Group instant deaths by launch directory (the parent of each session's cwd —
// a fleet launched into worktrees of one repo collapses to a single line).
function instantGroups(list) {
  const groups = new Map();
  for (const h of list) {
    const cwd = (h.stat.cwd || "?").replace(/\\/g, "/");
    const key = cwd.includes("/") ? cwd.slice(0, cwd.lastIndexOf("/")) : cwd;
    const g = groups.get(key) || { parent: key, kind: h.end.kind, count: 0, first: h.cutoff, last: h.cutoff, sessions: [] };
    g.count++;
    if (h.cutoff < g.first) g.first = h.cutoff;
    if (h.cutoff > g.last) g.last = h.cutoff;
    g.sessions.push({ sessionId: h.stat.sessionId, cwd: h.stat.cwd, cutoff: h.cutoff, path: h.path });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
const instGroups = instantGroups(instant);

// ── output ────────────────────────────────────────────────────────────────────
if (resumeOnly) {
  const h = hits[0];
  if (!h) { console.error("No resumable session found in window."); process.exit(1); }
  console.log(process.platform === "win32" ? h.resume.pwsh : h.resume.bash);
  process.exit(0);
}

if (asJson) {
  const out = (latest ? hits.slice(0, 1) : hits.slice(0, top)).map((h) => ({
    sessionId: h.stat.sessionId,
    ending: h.end.kind,
    cutoff: h.cutoff,
    cutoffLocal: h.cutoffLocal,
    home: h.resume.home,
    profileTag: h.resume.tag,
    projectDir: h.dir,
    project: h.project,
    cwd: h.stat.cwd,
    goal: h.stat.aiTitle,
    firstAsk: h.stat.firstPrompt,
    lastAsk: h.stat.lastPrompt,
    durationSec: h.stat.durationSec,
    assistantTurns: h.stat.assistantTurns,
    path: h.path,
    kind: h.kind,
    parentSessionId: h.parentSessionId,
    resumable: h.kind === "main",
    successors: h.successors,
    resumeBash: h.resume.bash,
    resumePwsh: h.resume.pwsh,
  }));
  console.log(JSON.stringify(latest ? out[0] || null : {
    resumable: out,
    alreadyContinued: continued.map((h) => ({
      sessionId: h.stat.sessionId, cutoff: h.cutoff, by: h.successors, note: h.successorLabel,
    })),
    instantDeaths: instGroups,
  }, null, 2));
  process.exit(0);
}

function printInstantGroups() {
  if (!instGroups.length) return;
  console.log(`\n${"─".repeat(72)}`);
  console.log(`INSTANT DEATHS (${instant.length}) — died in seconds with zero tool calls; NOTHING to resume`);
  console.log(`Cause is almost always a launch into an exhausted limit window. RELAUNCH the`);
  console.log(`work (after the reset / under a profile with headroom) instead of resuming.`);
  console.log("─".repeat(72));
  for (const g of instGroups.slice(0, 8)) {
    console.log(`  ${String(g.count).padStart(3)}× under ${g.parent}   ${localTime(g.first)} → ${localTime(g.last)}   (${g.kind})`);
  }
  if (instGroups.length > 8) console.log(`  … ${instGroups.length - 8} more group(s) (--json for all)`);
  console.log(`  (--include-instant lists them individually)`);
}

if (!hits.length) {
  console.log(`No cut-off/resumable sessions found${projectQ ? ` for project "${projectQ}"` : ""}${cwdKey ? " in this directory" : ""} in the last ${days} day(s).`);
  if (!instant.length) console.log("Try: --days 30, drop --project/--cwd, or --all-endings to list normal-ending sessions too.");
  printInstantGroups();
  process.exit(0);
}

const shown = latest ? hits.slice(0, 1) : hits.slice(0, top);
console.log("═".repeat(72));
console.log(`RESUMABLE SESSIONS  —  ${hits.length} open cut-off session(s), last ${days || "∞"} day(s)`);
console.log("═".repeat(72));

for (const h of shown) {
  const s = h.stat;
  console.log("");
  console.log(`${h.end.label}   ${h.cutoffLocal} (local)   ${h.resume.tag}/${h.dir}`);
  console.log(`  session:  ${s.sessionId}`);
  if (s.aiTitle) console.log(`  goal:     ${oneLine(s.aiTitle)}`);
  if (s.lastPrompt) console.log(`  last ask: ${oneLine(s.lastPrompt)}`);
  console.log(`  ran:      ${s.assistantTurns} turns · ${Math.round((s.durationSec || 0) / 60)}m · cwd ${s.cwd || "?"}`);
  if (h.successorLabel) console.log(`  ALREADY:  ${h.successorLabel} — check before redoing any of it`);
  if (h.kind === "main") {
    console.log(`  resume →  ${process.platform === "win32" ? h.resume.pwsh : h.resume.bash}`);
  } else {
    // Nested transcripts have no resume of their own; the parent carries the
    // conversation and subagent-results.mjs recovers what the child produced.
    console.log(`  NOTE:     this is a ${h.kind} transcript — not independently resumable.`);
    console.log(`  parent →  ${h.parentSessionId || "?"}`);
    console.log(`  recover → node scripts/subagent-results.mjs ${h.parentSessionId || "<parent>"} --unresolved`);
  }
  console.log(`  inspect → node scripts/analyze-claude-session.mjs "${h.path}" --events -v`);
}

if (!latest && continued.length && !includeContinued) {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`ALREADY CONTINUED (${continued.length}) — cut off, but another session picked the work up`);
  console.log(`Resuming these duplicates work that is already done. --include-continued to rank them anyway.`);
  console.log("─".repeat(72));
  for (const h of continued.slice(0, 8)) {
    console.log(`  ${h.stat.sessionId.slice(0, 8)}  ${h.cutoffLocal}  ${h.resume.tag}/${h.dir}  →  ${h.successorLabel}`);
  }
  if (continued.length > 8) console.log(`  … ${continued.length - 8} more (--json for all)`);
}

if (!latest && hits.length > shown.length) {
  console.log(`\n… ${hits.length - shown.length} more. Use --top ${hits.length} to see all, or --latest for just the top one.`);
}
if (!latest) printInstantGroups();
