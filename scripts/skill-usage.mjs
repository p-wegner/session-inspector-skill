#!/usr/bin/env node
/**
 * Skill usage / dead-skill audit across MANY sessions (Claude + Codex + Copilot).
 *
 * Answers "which of my agent skills NEVER get triggered?" — the filesystem
 * `.claude/skills` / `.codex/skills` / `.copilot/skills` definitions cross-
 * referenced against every session transcript. Board-INDEPENDENT: it knows
 * nothing about the kanban DB `agent_skills` table (those are triggered by
 * deterministic server actions, not by agents). It only looks at skills an
 * AGENT can invoke from disk, and at how often the transcripts show them firing.
 *
 * Sibling to token-sinks.mjs / tool-failures.mjs (same stat-filter-then-scan
 * fan-out, same flags) but the unit is a SKILL, not a tool or a token.
 *
 * ── Where skills are discovered (the "universe") ────────────────────────────
 *   user     ~/.claude/skills/<name>/SKILL.md, ~/.codex/skills, ~/.copilot/skills
 *   project  <repo>/.claude/skills, <repo>/.codex/skills — repo roots come from
 *            the cwd this runs in AND from every distinct session cwd (existing
 *            worktrees/checkouts only), plus any --project-dir you pass
 *   plugin   ~/.claude/plugins (recursive; OFF by default — third-party/cataloged
 *            != installed is noisy; enable with --include-plugins)
 * A skill is one directory containing a SKILL.md. Identity is its NAME (the dir
 * name) — the same name found in several roots (e.g. a board-materialized skill
 * copied into many worktrees) is one skill, with all its sources listed.
 *
 * ── How a trigger is detected in a transcript ───────────────────────────────
 *   STRONG (an agent explicitly invoked it):
 *     Claude  "name":"Skill","input":{"skill":"X"}  (the Skill tool)
 *     Claude  <command-name>/X</command-name>       (a /slash invocation)
 *     Copilot "skill":"X" / "skillName":"X"
 *   WEAK (the skill body was loaded/read — the ONLY signal Codex emits, since
 *   Codex has no Skill tool): a `skills/X/SKILL.md` path token, or Claude's
 *     "Base directory for this skill: …/skills/X" launch banner.
 * "Triggered" = strong OR weak. A skill with neither, anywhere, is DEAD. Both
 * counts are shown so you can tell a genuinely-fired skill from one whose file
 * was merely read (e.g. while editing the skill itself).
 *
 * Usage:
 *   node scripts/skill-usage.mjs                  # all time, all providers, default roots
 *   node scripts/skill-usage.mjs --days 30        # only sessions modified in last 30d
 *   node scripts/skill-usage.mjs --provider codex # claude | codex | copilot | all
 *   node scripts/skill-usage.mjs --include-plugins # also audit installed plugin skills
 *   node scripts/skill-usage.mjs --project-dir C:\repo  # add a repo's .claude/.codex skills
 *   node scripts/skill-usage.mjs --unused-only    # print only the never-triggered list
 *   node scripts/skill-usage.mjs --json
 */

import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import { discover } from "./lib/sessions.mjs";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const vals = (f) => argv.reduce((a, x, i) => (x === f && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
const days = parseInt(val("--days", "0"), 10) || 0;   // 0 = all time
const provider = val("--provider", "all");
const includePlugins = has("--include-plugins");
const unusedOnly = has("--unused-only");
const jsonOut = has("--json");
const top = parseInt(val("--top", "0"), 10) || 0;
const extraProjectDirs = vals("--project-dir");

const HOME = homedir();
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };

// ── skill discovery ───────────────────────────────────────────────────────────
// Returns Map<name, { sources: Set<"user|project|plugin">, paths: Set<string> }>
function skillsUnder(root, scope, acc) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const dir = join(root, e.name);
    let st; try { st = statSync(dir); } catch { continue; }      // statSync follows junctions
    if (!st.isDirectory()) continue;
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    const cur = acc.get(e.name) || { sources: new Set(), paths: new Set() };
    cur.sources.add(scope);
    cur.paths.add(dir);
    acc.set(e.name, cur);
  }
}

function discoverPluginSkills(acc) {
  const base = join(HOME, ".claude", "plugins");
  const stack = [base];
  let guard = 0;
  while (stack.length && guard++ < 200000) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const f = join(d, e.name);
      let st; try { st = statSync(f); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (existsSync(join(f, "SKILL.md"))) {
        const cur = acc.get(e.name) || { sources: new Set(), paths: new Set() };
        cur.sources.add("plugin");
        cur.paths.add(f);
        acc.set(e.name, cur);
      } else {
        stack.push(f);
      }
    }
  }
}

function gitRoot(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
    }).trim();
  } catch { return cwd; }
}

function discoverSkills(sessionCwds) {
  const acc = new Map();
  // user-level
  skillsUnder(join(HOME, ".claude", "skills"), "user", acc);
  skillsUnder(join(HOME, ".codex", "skills"), "user", acc);
  skillsUnder(join(HOME, ".copilot", "skills"), "user", acc);

  // project-level: cwd-of-this-process repo + every distinct session cwd + --project-dir
  const roots = new Set();
  roots.add(gitRoot(process.cwd()));
  for (const p of extraProjectDirs) roots.add(p);
  for (const c of sessionCwds) if (c && existsSync(c)) roots.add(realOrSelf(c));
  const seenReal = new Set();
  for (const r of roots) {
    if (!r) continue;
    const rr = realOrSelf(r);
    if (seenReal.has(rr)) continue;
    seenReal.add(rr);
    skillsUnder(join(r, ".claude", "skills"), "project", acc);
    skillsUnder(join(r, ".codex", "skills"), "project", acc);
  }

  if (includePlugins) discoverPluginSkills(acc);
  return acc;
}

// ── trigger extraction (regex over raw transcript text — cheap, provider-uniform) ──
const RE_SKILL_TOOL = /"name":"Skill","input":\{"skill":"([^"]+)"/g;          // claude Skill tool
const RE_SLASH = /<command-name>\/?([A-Za-z0-9:_-]+)<\/command-name>/g;        // claude slash
const RE_COPILOT = /"skill(?:Name)?":"([^"]+)"/g;                              // copilot skill field
const RE_PATH = /skills[/\\]([A-Za-z0-9._-]+)[/\\]SKILL\.md/g;                 // any: body loaded/read
const RE_BANNER = /[Bb]ase directory for this skill:[^\n]*?[/\\]skills[/\\]([A-Za-z0-9._-]+)/g;

function scanSession(text, provider) {
  const strong = new Map();   // name -> count
  const weak = new Map();
  const bump = (m, n) => m.set(n, (m.get(n) || 0) + 1);
  let mm;
  if (provider === "claude") {
    while ((mm = RE_SKILL_TOOL.exec(text))) bump(strong, mm[1]);
    while ((mm = RE_SLASH.exec(text))) bump(strong, mm[1]);
  } else if (provider === "copilot") {
    while ((mm = RE_COPILOT.exec(text))) bump(strong, mm[1]);
  }
  while ((mm = RE_PATH.exec(text))) bump(weak, mm[1]);
  while ((mm = RE_BANNER.exec(text))) bump(weak, mm[1]);
  return { strong, weak };
}

// ── main ───────────────────────────────────────────────────────────────────────
const cutoff = days ? Date.now() - days * 864e5 : 0;
const sessions = discover(provider).filter((s) => !cutoff || s.mtime.getTime() >= cutoff);

// First pass would need cwds for project-skill discovery, but reading every file
// twice is wasteful. We extract cwd cheaply during the single scan pass, then run
// discovery — so do scan first collecting (cwd, triggers), then discover, then join.
const RE_CWD = /"cwd":"((?:[^"\\]|\\.)*)"/;   // first cwd occurrence (claude/codex)

// usage[name] = { strongInv, weakRefs, sessions:Set, providers:Set, last:0, first:Inf }
const usage = new Map();
const cwds = new Set();
let scanned = 0, bytes = 0;
const t0 = Date.now();
for (const s of sessions) {
  let text;
  try { text = readFileSync(s.path, "utf-8"); } catch { continue; }
  scanned++; bytes += text.length;
  const cm = text.match(RE_CWD);
  if (cm) { try { cwds.add(JSON.parse('"' + cm[1] + '"')); } catch { cwds.add(cm[1]); } }
  const { strong, weak } = scanSession(text, s.provider);
  const all = new Set([...strong.keys(), ...weak.keys()]);
  const t = s.mtime.getTime();
  for (const name of all) {
    const u = usage.get(name) || { strongInv: 0, weakRefs: 0, sessions: new Set(), providers: new Set(), last: 0, first: Infinity };
    u.strongInv += strong.get(name) || 0;
    u.weakRefs += weak.get(name) || 0;
    u.sessions.add(s.path);
    u.providers.add(s.provider);
    u.last = Math.max(u.last, t);
    u.first = Math.min(u.first, t);
    usage.set(name, u);
  }
  if (!jsonOut && scanned % 200 === 0) process.stderr.write(`\r  scanned ${scanned}/${sessions.length} sessions…`);
}
if (!jsonOut) process.stderr.write(`\r  scanned ${scanned} sessions (${(bytes / 1e6).toFixed(0)}MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const skills = discoverSkills(cwds);

// ── join discovered universe with observed triggers ───────────────────────────
const fmtDate = (t) => (t && isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "—");
const rows = [];
for (const [name, def] of skills) {
  const u = usage.get(name);
  rows.push({
    name,
    sources: [...def.sources].sort(),
    paths: [...def.paths],
    strongInv: u ? u.strongInv : 0,
    weakRefs: u ? u.weakRefs : 0,
    sessions: u ? u.sessions.size : 0,
    providers: u ? [...u.providers].sort() : [],
    last: u ? u.last : 0,
    first: u ? u.first : 0,
    triggered: !!u,
  });
}
// triggered names observed in logs but NOT found in any discovered root (orphans)
const orphans = [...usage.keys()].filter((n) => !skills.has(n)).map((n) => {
  const u = usage.get(n);
  return { name: n, strongInv: u.strongInv, weakRefs: u.weakRefs, sessions: u.sessions.size, providers: [...u.providers].sort(), last: u.last };
}).filter((o) => o.strongInv > 0)   // ignore pure path-token noise for orphans
  .sort((a, b) => b.strongInv - a.strongInv);

const dead = rows.filter((r) => !r.triggered).sort((a, b) => a.name.localeCompare(b.name));
const live = rows.filter((r) => r.triggered).sort((a, b) => (b.strongInv + b.weakRefs) - (a.strongInv + a.weakRefs) || b.sessions - a.sessions);

if (jsonOut) {
  console.log(JSON.stringify({
    window: days ? `${days}d` : "all-time",
    provider, scannedSessions: scanned,
    discoveredSkills: skills.size, triggered: live.length, neverTriggered: dead.length,
    dead, live: top ? live.slice(0, top) : live, orphans,
  }, null, 2));
  process.exit(0);
}

// ── pretty report ─────────────────────────────────────────────────────────────
const bar = "─".repeat(64);
const strongLive = live.filter((r) => r.strongInv > 0);
const repoOf = (r) => { const p = r.paths.find((x) => /[/\\]\.(claude|codex)[/\\]skills[/\\]/.test(x)) || r.paths[0] || ""; return (p.replace(/[/\\]\.(claude|codex)[/\\]skills[/\\].*$/, "").split(/[/\\]/).pop()) || ""; };
console.log(bar);
console.log(`SKILL USAGE AUDIT   window=${days ? days + "d" : "all-time"}  provider=${provider}  sessions=${scanned}`);
console.log(`discovered ${skills.size} skills · ${strongLive.length} agent-invoked · ${live.length - strongLive.length} loaded-only · ${dead.length} no-trace${includePlugins ? "" : "   (plugins excluded; --include-plugins to add)"}`);
console.log(`NEVER AGENT-INVOKED (no Skill-tool/slash/copilot call): ${dead.length + (live.length - strongLive.length)} of ${skills.size}`);
console.log(bar);
console.log(`\nNote: "weak"/loaded counts are inflated by worktree skill MATERIALIZATION (kanban copies its built-in\nskills into every worktree's .claude/skills, so their SKILL.md path appears even when no agent invokes them).\n"strong" = an agent actually fired the skill, and is the real trigger signal. Codex emits no strong signal.`);

console.log(`\n● NEVER TRIGGERED — zero trace at all (${dead.length})  [defined on disk, never even loaded]`);
if (!dead.length) console.log("  (none — every discovered skill left some trace)");
for (const r of dead) console.log(`  ✗ ${r.name.padEnd(28)} [${r.sources.join(",")}]  repo: ${repoOf(r) || "?"}`);

if (!unusedOnly) {
  console.log(`\n● TRIGGERED (${live.length})   strong=Skill-tool/slash/copilot-field · weak=SKILL.md loaded/read`);
  console.log(`  ${"skill".padEnd(28)} ${"strong".padStart(7)} ${"weak".padStart(6)} ${"sess".padStart(5)}  last        providers`);
  for (const r of (top ? live.slice(0, top) : live)) {
    console.log(`  ${r.name.padEnd(28)} ${String(r.strongInv).padStart(7)} ${String(r.weakRefs).padStart(6)} ${String(r.sessions).padStart(5)}  ${fmtDate(r.last)}  ${r.providers.join(",")}`);
  }
  // skills only ever read, never explicitly invoked — candidates that "fire" only via auto-injection
  const weakOnly = live.filter((r) => r.strongInv === 0);
  if (weakOnly.length) {
    console.log(`\n● REFERENCED BUT NEVER EXPLICITLY INVOKED (${weakOnly.length}) — only seen as a loaded/read SKILL.md, no Skill-tool/slash call`);
    console.log(`  (expected for Codex skills — Codex has no Skill tool; suspicious for Claude-only skills)`);
    for (const r of weakOnly) console.log(`  ~ ${r.name.padEnd(28)} weak=${r.weakRefs} [${r.providers.join(",")}]`);
  }
  if (orphans.length) {
    console.log(`\n● INVOKED BUT NOT FOUND ON DISK (${orphans.length}) — triggered in logs, no SKILL.md in scanned roots (uninstalled/renamed/removed)`);
    for (const o of orphans.slice(0, 20)) console.log(`  ? ${o.name.padEnd(28)} strong=${o.strongInv} [${o.providers.join(",")}]`);
  }
}
console.log("");
