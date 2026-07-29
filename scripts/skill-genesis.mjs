#!/usr/bin/env node
/**
 * Skill-genesis mining — find the INTERACTION PATTERNS that lead to a skill
 * being created or improved, across many sessions (Claude only — Codex/Copilot
 * have no Skill tool or Write-tool signal to key off).
 *
 * Different question from skill-usage.mjs (which skills exist and do they ever
 * fire) and tool-friction.mjs (which command chains repeat). This one asks: of
 * the sessions that DID create or touch a SKILL.md, what shape was the human
 * interaction that led there? Four shapes we look for:
 *
 *   same-prompt         first human message asks for a THING and asks for a
 *                       skill/CLI to do it, in one breath ("build X, and wrap
 *                       it in a skill with a CLI so this is easy next time")
 *   interactive-then-ask a task was done first (several tool calls), and only
 *                       LATER in the same session did a human message ask to
 *                       turn it into a skill
 *   lab-driven          the session invoked a "*-lab" meta-skill (a companion
 *                       skill whose job is to improve another skill)
 *   compounding         the first human message explicitly references a prior
 *                       session/skill ("continue", "last time", "extend the
 *                       X skill", "as we did before")
 * A session can match more than one shape (e.g. lab-driven AND compounding).
 * "genesis" = created (Write to a new-looking SKILL.md) vs "improved" (Edit to
 * an existing skill's SKILL.md or its scripts/tools/references files).
 *
 * Usage:
 *   node scripts/skill-genesis.mjs                    # all-time, all Claude sessions
 *   node scripts/skill-genesis.mjs --days 90
 *   node scripts/skill-genesis.mjs --project slidesmith
 *   node scripts/skill-genesis.mjs --skill refactor    # only sessions touching this skill name
 *   node scripts/skill-genesis.mjs --examples 3         # print N real snippets per pattern
 *   node scripts/skill-genesis.mjs --json
 */

import { readFileSync } from "fs";
import { basename, dirname } from "path";
import { discover, projectIdentity } from "./lib/sessions.mjs";
import { parseClaude } from "./lib/parse.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const days = parseInt(val("--days", "0"), 10) || 0;
const jsonOut = has("--json");
const examplesN = parseInt(val("--examples", "0"), 10) || 0;
const skillFilter = (val("--skill", "") || "").toLowerCase();
const projNorm = (s) => (s || "").toLowerCase().replace(/[-_\s/\\]+/g, "-");
const projectQ = projNorm(val("--project", ""));

// ── regex vocabulary ─────────────────────────────────────────────────────────
const SKILL_PATH_RE = /skills[\\/]([A-Za-z0-9._-]+)[\\/]SKILL\.md$/i;
const SKILL_SIDE_RE = /skills[\\/]([A-Za-z0-9._-]+)[\\/](?:scripts|references|tools|src)[\\/]/i;
const ASK_FOR_SKILL_RE = /\b(create|build|make|write|turn (?:this|it) into|wrap (?:this|it) (?:in|into)|package (?:this|it) (?:as|into))\b[^.!?\n]{0,80}\b(skill|cli|command)\b/i;
const COMPOUNDING_RE = /\b(continue|continuing|last time|previous session|as (?:we|i) did before|pick up where|extend the [a-z0-9_-]+ skill|following up on|building on (?:the|our) (?:last|previous)|from (?:last|our previous) session)\b/i;
const LAB_SKILL_RE = /^([a-z0-9_-]+)-lab$/i;

function withinDays(mtime) {
  if (!days) return true;
  return Date.now() - mtime.getTime() <= days * 864e5;
}

function skillNameFromPath(p) {
  const norm = String(p || "").replace(/\\/g, "/");
  let m = norm.match(SKILL_PATH_RE);
  if (m) return m[1];
  m = norm.match(SKILL_SIDE_RE);
  if (m) return m[1];
  return null;
}

// A SKILL.md write "looks like genesis" if it's the FIRST write to that path in
// the session (we can't see history before the session, so this is necessarily a
// per-session signal: "this session wrote a SKILL.md" — genesis vs improve is
// decided by write-vs-edit, not by cross-session history).
function classifySession(stats) {
  const touched = new Map(); // skillName -> { created: bool, improved: bool }
  for (const fp of stats.filesWritten) {
    const n = skillNameFromPath(fp);
    if (n && (!skillFilter || n.toLowerCase().includes(skillFilter))) {
      if (/SKILL\.md$/i.test(fp)) {
        const e = touched.get(n) || { created: false, improved: false };
        e.created = true; touched.set(n, e);
      }
    }
  }
  for (const fp of stats.filesEdited) {
    const n = skillNameFromPath(fp);
    if (n && (!skillFilter || n.toLowerCase().includes(skillFilter))) {
      const e = touched.get(n) || { created: false, improved: false };
      e.improved = true; touched.set(n, e);
    }
  }
  if (!touched.size) return null;

  const human = stats.userMessages.filter((m) => typeof m === "string" && m.trim() && !m.startsWith("<") && !m.startsWith("["));
  const first = stats.firstPrompt || human[0] || "";
  const later = human.slice(1);

  const patterns = [];
  if (COMPOUNDING_RE.test(first)) patterns.push({ shape: "compounding", evidence: first.slice(0, 220) });
  if (ASK_FOR_SKILL_RE.test(first)) {
    patterns.push({ shape: "same-prompt", evidence: first.slice(0, 220) });
  } else {
    const laterAsk = later.find((m) => ASK_FOR_SKILL_RE.test(m));
    if (laterAsk && stats.toolCalls > 3) patterns.push({ shape: "interactive-then-ask", evidence: laterAsk.slice(0, 220) });
  }
  const labNames = Object.keys(stats.toolNames || {})
    .filter((k) => k.startsWith("Skill:"))
    .map((k) => k.slice("Skill:".length))
    .filter((n) => LAB_SKILL_RE.test(n));
  if (labNames.length) patterns.push({ shape: "lab-driven", evidence: `invoked ${labNames.join(", ")}` });

  if (!patterns.length) patterns.push({ shape: "unclassified", evidence: (first || "").slice(0, 220) });

  return { touched: [...touched.entries()].map(([name, v]) => ({ name, ...v })), patterns, firstPrompt: first };
}

// ── main scan ────────────────────────────────────────────────────────────────
const sessions = discover("claude").filter((s) => withinDays(s.mtime));
const results = [];
let scanned = 0;
for (const s of sessions) {
  let text;
  try { text = readFileSync(s.path, "utf-8"); } catch { continue; }
  scanned++;
  // Cheap prefilter before the full parse: skip files that never mention "skills/"
  // or "SKILL.md" at all (the overwhelming majority of sessions).
  if (!/skills[\\/]/i.test(text)) continue;
  const stats = parseClaude(text.split("\n"));
  if (projectQ) {
    const id = projectIdentity(stats.cwd);
    const hay = projNorm([basename(dirname(s.path)), stats.cwd, id.project, id.projectKey].join(" "));
    if (!hay.includes(projectQ)) continue;
  }
  const cls = classifySession(stats);
  if (!cls) continue;
  results.push({
    path: s.path, mtime: s.mtime, cwd: stats.cwd,
    aiTitle: stats.aiTitle, firstPrompt: cls.firstPrompt,
    touched: cls.touched, patterns: cls.patterns,
  });
  if (!jsonOut) process.stderr.write(`\r  scanned ${scanned}/${sessions.length} sessions, ${results.length} skill-touching…`);
}
if (!jsonOut) process.stderr.write(`\r  scanned ${scanned}/${sessions.length} sessions, ${results.length} touched a skill's files${projectQ ? ` (project filter "${projectQ}")` : ""}${skillFilter ? ` (skill filter "${skillFilter}")` : ""}\n`);

// ── aggregate ────────────────────────────────────────────────────────────────
const byShape = new Map();
const bySkill = new Map(); // skillName -> {created, improved, sessions}
for (const r of results) {
  for (const p of r.patterns) {
    if (!byShape.has(p.shape)) byShape.set(p.shape, []);
    byShape.get(p.shape).push({ ...r, evidence: p.evidence });
  }
  for (const t of r.touched) {
    const e = bySkill.get(t.name) || { created: 0, improved: 0, sessions: 0 };
    e.created += t.created ? 1 : 0;
    e.improved += t.improved ? 1 : 0;
    e.sessions += 1;
    bySkill.set(t.name, e);
  }
}

if (jsonOut) {
  console.log(JSON.stringify({
    window: days ? `${days}d` : "all-time",
    scannedSessions: scanned,
    skillTouchingSessions: results.length,
    byShape: Object.fromEntries([...byShape.entries()].map(([k, v]) => [k, v.length])),
    bySkill: Object.fromEntries(bySkill),
    sessions: results,
  }, null, 2));
  process.exit(0);
}

const bar = "─".repeat(70);
console.log(bar);
console.log(`SKILL GENESIS/IMPROVEMENT PATTERN AUDIT   window=${days ? days + "d" : "all-time"}`);
console.log(`${scanned} sessions scanned · ${results.length} touched a skill's SKILL.md/scripts/references`);
console.log(bar);

const SHAPE_ORDER = ["same-prompt", "interactive-then-ask", "lab-driven", "compounding", "unclassified"];
for (const shape of SHAPE_ORDER) {
  const rows = byShape.get(shape);
  if (!rows || !rows.length) continue;
  console.log(`\n● ${shape}  (${rows.length} session${rows.length === 1 ? "" : "s"})`);
  const n = examplesN || Math.min(3, rows.length);
  for (const r of rows.slice(0, n)) {
    console.log(`  - ${r.mtime.toISOString().slice(0, 10)}  ${(r.aiTitle || basename(r.path)).slice(0, 60)}`);
    console.log(`      skill(s): ${r.touched.map((t) => t.name).join(", ")}`);
    console.log(`      "${r.evidence.replace(/\s+/g, " ")}"`);
  }
  if (rows.length > n) console.log(`  … and ${rows.length - n} more`);
}

console.log(`\n● SKILLS TOUCHED, ranked by total sessions`);
const skillRows = [...bySkill.entries()].sort((a, b) => b[1].sessions - a[1].sessions);
for (const [name, e] of skillRows.slice(0, 25)) {
  console.log(`  ${name.padEnd(28)} sessions=${String(e.sessions).padStart(3)}  created=${e.created}  improved=${e.improved}`);
}
console.log("");
