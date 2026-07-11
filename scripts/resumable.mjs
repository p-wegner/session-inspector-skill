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
 *   node scripts/resumable.mjs --project shift-app # substring: session cwd / project dir / git remote
 *   node scripts/resumable.mjs --cwd               # only sessions whose cwd is the current directory
 *   node scripts/resumable.mjs --days 30           # widen the mtime window (default 7; 0 = all time)
 *   node scripts/resumable.mjs --interrupted       # also include user-interrupted sessions
 *   node scripts/resumable.mjs --all-endings       # include normal-ending sessions too (just rank by recency)
 *   node scripts/resumable.mjs --latest            # print ONLY the top hit + its resume command
 *   node scripts/resumable.mjs --resume            # print ONLY the resume command for the top hit (scriptable)
 *   node scripts/resumable.mjs --top 20            # how many to list (default 12)
 *   node scripts/resumable.mjs --json
 *
 * Then continue it:
 *   cd <cwd> && CLAUDE_CONFIG_DIR=<home> claude --resume <sessionId>
 *   (or inspect first:  node scripts/analyze-claude-session.mjs <path> --events -v)
 */

import { readFileSync, statSync } from "fs";
import { basename, dirname } from "path";
import { discover, projectIdentity } from "./lib/sessions.mjs";
import { parseClaude } from "./lib/parse.mjs";

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
// Session path: <home>/projects/<projectDir>/<id>.jsonl
//   dirname ×1 = .../projects/<dir>, ×2 = .../projects, ×3 = <home>
function homeDir(path) { return dirname(dirname(dirname(path))); }
function projectDirName(path) { return basename(dirname(path)); }

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

// ── collect ──────────────────────────────────────────────────────────────────
const sessions = discover("claude");
const hits = [];

for (const s of sessions) {
  if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
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

  hits.push({
    end, stat, path: s.path, dir,
    project: idn.project,
    cutoff: stat.endTime,
    cutoffLocal: localTime(stat.endTime),
    mtime: s.mtime,
    resume: resumeCommand(stat, s.path),
  });
}

// rank: severity desc, then recency desc
hits.sort((a, b) => (b.end.rank - a.end.rank) || (new Date(b.cutoff) - new Date(a.cutoff)));

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
    resumeBash: h.resume.bash,
    resumePwsh: h.resume.pwsh,
  }));
  console.log(JSON.stringify(latest ? out[0] || null : out, null, 2));
  process.exit(0);
}

if (!hits.length) {
  console.log(`No cut-off/resumable sessions found${projectQ ? ` for project "${projectQ}"` : ""}${cwdKey ? " in this directory" : ""} in the last ${days} day(s).`);
  console.log("Try: --days 30, drop --project/--cwd, or --all-endings to list normal-ending sessions too.");
  process.exit(0);
}

const shown = latest ? hits.slice(0, 1) : hits.slice(0, top);
console.log("═".repeat(72));
console.log(`RESUMABLE SESSIONS  —  ${hits.length} cut-off session(s), last ${days || "∞"} day(s)`);
console.log("═".repeat(72));

for (const h of shown) {
  const s = h.stat;
  console.log("");
  console.log(`${h.end.label}   ${h.cutoffLocal} (local)   ${h.resume.tag}/${h.dir}`);
  console.log(`  session:  ${s.sessionId}`);
  if (s.aiTitle) console.log(`  goal:     ${oneLine(s.aiTitle)}`);
  if (s.lastPrompt) console.log(`  last ask: ${oneLine(s.lastPrompt)}`);
  console.log(`  ran:      ${s.assistantTurns} turns · ${Math.round((s.durationSec || 0) / 60)}m · cwd ${s.cwd || "?"}`);
  console.log(`  resume →  ${process.platform === "win32" ? h.resume.pwsh : h.resume.bash}`);
  console.log(`  inspect → node scripts/analyze-claude-session.mjs "${h.path}" --events -v`);
}

if (!latest && hits.length > shown.length) {
  console.log(`\n… ${hits.length - shown.length} more. Use --top ${hits.length} to see all, or --latest for just the top one.`);
}
