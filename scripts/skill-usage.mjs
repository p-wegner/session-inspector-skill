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
 *
 *   ── Repo-scoped audit (the "which of THIS repo's skills are dead weight?" case) ──
 *   node scripts/skill-usage.mjs --project shift-app          # scope sessions AND the
 *       project-skill universe to one repo (matches folder / cwd / git-remote;
 *       `-`/`_`/separators are normalized, so `shift-app` == `shift_app`). "avail"
 *       then means "project sessions since the skill existed".
 *   node scripts/skill-usage.mjs --cwd                        # shorthand: --project <this cwd>
 *   node scripts/skill-usage.mjs --project shift-app --repo-only   # report ONLY skills
 *       DEFINED in the matched repo's .claude/.codex/skills (drop user-level globals) —
 *       the exact "intersection of skills IN this repo × sessions IN this repo".
 *   node scripts/skill-usage.mjs --project shift-app --repo-only --cost   # + TOKEN TAX:
 *       measures each skill via the token-budget CLI (tokt.js skill --json) — Tier-0
 *       alwaysOn (name+desc, paid every turn) and Tier-1 onInvoke (SKILL.md body). A
 *       dead SMALL skill is cheap; a dead LARGE one is real waste, so the dead/loaded-only
 *       buckets get ranked by tax (waste≈alwaysOn×avail). tokt.js is found via $TOKT_BIN,
 *       the sibling token-budget skill, or the known repo/profile locations; absent → skip.
 */

import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { discover, projectIdentity } from "./lib/sessions.mjs";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const vals = (f) => argv.reduce((a, x, i) => (x === f && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
const days = parseInt(val("--days", "0"), 10) || 0;   // 0 = all time
const provider = val("--provider", "all");
const includePlugins = has("--include-plugins");
const unusedOnly = has("--unused-only");
// --repo-only: report ONLY skills defined in a matched repo's .claude/.codex/skills
// (source "project"), dropping user-level globals. Answers "skills IN this repo" as
// opposed to "all skills available to this repo's sessions". Implies the repo scope.
const repoOnly = has("--repo-only");
const jsonOut = has("--json");
const top = parseInt(val("--top", "0"), 10) || 0;
const extraProjectDirs = vals("--project-dir");
const noGit = has("--no-git");
// --cost: measure each reported skill's TOKEN tax via the token-budget CLI
// (tokt.js skill --json → Tier-0 alwaysOn = name+description paid every turn,
// Tier-1 onInvoke = SKILL.md body paid when it fires). A dead SMALL skill is
// cheap; a dead LARGE one is real waste — this ranks by that. Opt-in: one node
// subprocess per reported skill.
const withCost = has("--cost");
// --project <substr>: scope BOTH the session set AND the project-skill universe to
// one repo (matches folder name / cwd / git-remote, same as incidents.mjs).
// --cwd: shorthand for --project <this-process's-cwd>, i.e. "skills of the repo I'm in".
const projectQ = (has("--cwd") ? process.cwd() : val("--project", "")).toLowerCase();

const HOME = homedir();
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };

// Collapse `-`, `_`, whitespace and path separators to a single `-` so the
// hyphenated Claude session folder (`C--projects-papershift-shift-app`) and the
// underscored real repo path (`…\papershift\shift_app`) compare equal. Without
// this, `--project shift-app` matches sessions but not the repo root, so
// project-skill discovery silently finds nothing.
const projNorm = (s) => (s || "").toLowerCase().replace(/[-_\s/\\]+/g, "-");
const projectQN = projNorm(projectQ);

// True when a working dir / repo root matches the --project substring. Matches the
// same haystack incidents.mjs uses (dir basename, raw path, git-remote-derived
// identity), but separator-normalized so `-`/`_` differences never split a match.
function projectMatch(cwd, folder = "") {
  if (!projectQ) return true;
  if (!cwd && !folder) return false;
  const id = cwd ? projectIdentity(cwd) : { project: "", projectKey: "" };
  const hay = projNorm([folder, cwd, id.project, id.projectKey].join(" "));
  return hay.includes(projectQN);
}

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

// Earliest moment a skill could have fired = when its SKILL.md first existed.
// git first-add is authoritative (fs birthtime is reset by every checkout/junction);
// fall back to fs birthtime/mtime only when the path isn't git-tracked.
const createdCache = new Map();   // git-toplevel|skill-relpath -> ts (dedup the many worktree copies)
function gitCreatedAt(skillDir) {
  let root;
  try {
    root = execFileSync("git", ["-C", skillDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
    }).trim();
  } catch { return null; }
  if (!root) return null;
  // identity = the skill's path inside ITS repo (so the 100s of worktree copies collapse to one)
  const rel = skillDir.replace(/\\/g, "/").replace(/.*[/\\]\.(?:claude|codex)[/\\]skills[/\\]/, "");
  const key = root.toLowerCase() + "|" + rel.toLowerCase();
  if (createdCache.has(key)) return createdCache.get(key);
  let ts = null;
  try {
    const out = execFileSync("git", ["-C", skillDir, "log", "--diff-filter=A", "--format=%aI", "--", "SKILL.md"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 6000,
    }).trim().split("\n").filter(Boolean);
    if (out.length) ts = new Date(out[out.length - 1]).getTime();
  } catch { /* untracked */ }
  createdCache.set(key, ts);
  return ts;
}
function skillCreatedAt(paths) {
  // Prefer non-worktree, shortest paths; only probe a few — they collapse by repo anyway.
  const ordered = [...paths].sort((a, b) => (/\bworktrees\b/i.test(a) - /\bworktrees\b/i.test(b)) || a.length - b.length);
  let min = Infinity;
  for (const p of ordered.slice(0, 6)) {
    let t = noGit ? null : gitCreatedAt(p);
    if (t == null) { try { const st = statSync(join(p, "SKILL.md")); t = Math.min(st.birthtimeMs || Infinity, st.mtimeMs) || st.mtimeMs; } catch { /* gone */ } }
    if (t && t < min) min = t;
  }
  return isFinite(min) ? min : null;
}

function gitRoot(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
    }).trim();
  } catch { return cwd; }
}

// ── token cost via the token-budget CLI (tokt.js) ─────────────────────────────
// The same skill dir found under many worktrees has identical content, so pick one
// stable path (prefer non-worktree, shortest) — matches skillCreatedAt's ordering.
function primaryPath(paths) {
  return [...paths].sort((a, b) => (/\bworktrees\b/i.test(a) - /\bworktrees\b/i.test(b)) || a.length - b.length)[0];
}
// Locate tokt.js: explicit $TOKT_BIN, then the token-budget skill junctioned as a
// sibling of this skill, then the known repo / user-profile locations.
let _toktBin;
function toktBin() {
  if (_toktBin !== undefined) return _toktBin;
  const here = dirname(fileURLToPath(import.meta.url));           // .../session-inspector/scripts
  const skillsDir = dirname(dirname(here));                       // .../skills
  const cands = [
    process.env.TOKT_BIN,
    join(skillsDir, "token-budget", "bin", "tokt.js"),
    join(HOME, ".claude", "skills", "token-budget", "bin", "tokt.js"),
    "C:/projects/andrena/token-budget/bin/tokt.js",
  ].filter(Boolean);
  _toktBin = cands.find((p) => existsSync(p)) || null;
  return _toktBin;
}
const costCache = new Map();   // skillDir -> { alwaysOn, onInvoke, fullyExpanded } | null
function measureSkillCost(skillDir) {
  if (!skillDir) return null;
  if (costCache.has(skillDir)) return costCache.get(skillDir);
  const bin = toktBin();
  let out = null;
  if (bin) {
    try {
      const raw = execFileSync("node", [bin, "skill", skillDir, "--json"], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000, maxBuffer: 8 << 20,
      });
      const j = JSON.parse(raw);
      out = { alwaysOn: j.tiers?.alwaysOn ?? 0, onInvoke: j.tiers?.onInvoke ?? 0, fullyExpanded: j.fullyExpanded ?? 0 };
    } catch { out = null; }
  }
  costCache.set(skillDir, out);
  return out;
}

function discoverSkills(sessionCwds) {
  const acc = new Map();
  // user-level
  skillsUnder(join(HOME, ".claude", "skills"), "user", acc);
  skillsUnder(join(HOME, ".codex", "skills"), "user", acc);
  skillsUnder(join(HOME, ".copilot", "skills"), "user", acc);

  // project-level: cwd-of-this-process repo + every distinct session cwd + --project-dir.
  // With --project, only repos matching the substring are added, so a repo-scoped audit
  // never pulls in a sibling project's .claude/skills (e.g. agentic-kanban's).
  const roots = new Set();
  const selfRoot = gitRoot(process.cwd());
  if (projectMatch(selfRoot, basename(selfRoot))) roots.add(selfRoot);
  for (const p of extraProjectDirs) roots.add(p);   // explicit --project-dir always honoured
  for (const c of sessionCwds) if (c && existsSync(c) && projectMatch(c, basename(c))) roots.add(realOrSelf(c));
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
const matchedTimes = [];   // mtimes of sessions kept after --project filtering (avail denominator)
let scanned = 0, matched = 0, skippedProject = 0, bytes = 0;
const t0 = Date.now();
for (const s of sessions) {
  let text;
  try { text = readFileSync(s.path, "utf-8"); } catch { continue; }
  scanned++; bytes += text.length;
  const cm = text.match(RE_CWD);
  let cwd = "";
  if (cm) { try { cwd = JSON.parse('"' + cm[1] + '"'); } catch { cwd = cm[1]; } }
  // --project: keep only sessions whose repo matches. Folder name (from the transcript's
  // parent dir) is a fallback so path-encoded projects match even when no cwd line exists.
  const folder = basename(dirname(s.path));
  if (projectQ && !projectMatch(cwd, folder)) { skippedProject++; continue; }
  matched++;
  if (cwd) cwds.add(cwd);
  matchedTimes.push(s.mtime.getTime());
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
if (!jsonOut) process.stderr.write(`\r  scanned ${scanned} sessions (${(bytes / 1e6).toFixed(0)}MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s${projectQ ? `  ·  ${matched} matched project "${projectQ}" (${skippedProject} skipped)` : ""}\n`);

const allSkills = discoverSkills(cwds);   // full universe — keep for orphan detection
// --repo-only narrows the REPORTED universe to repo-defined skills, but a user-level
// skill invoked in the logs must not then be mislabeled an on-disk orphan.
const skills = repoOnly ? new Map([...allSkills].filter(([, d]) => d.sources.has("project"))) : allSkills;

// scanned-session times sorted ascending → count sessions that ran AFTER a skill existed.
// With --project this is the MATCHED set, so "avail" means "project sessions since it existed".
const sessTimes = matchedTimes.sort((a, b) => a - b);
const lowerBound = (t) => { let lo = 0, hi = sessTimes.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sessTimes[mid] < t) lo = mid + 1; else hi = mid; } return lo; };
const availableSessionsSince = (t) => (t == null ? sessTimes.length : sessTimes.length - lowerBound(t));

// ── join discovered universe with observed triggers ───────────────────────────
const fmtDate = (t) => (t && isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "—");
const rows = [];
for (const [name, def] of skills) {
  const u = usage.get(name);
  const row = {
    name,
    sources: [...def.sources].sort(),
    paths: [...def.paths],
    createdAt: undefined,        // filled lazily (git is slow) only for skills we report availability for
    availableSessions: undefined,
    strongInv: u ? u.strongInv : 0,
    weakRefs: u ? u.weakRefs : 0,
    sessions: u ? u.sessions.size : 0,
    providers: u ? [...u.providers].sort() : [],
    last: u ? u.last : 0,
    first: u ? u.first : 0,
    triggered: !!u,
    alwaysOn: null, onInvoke: null, fullyExpanded: null,   // filled by --cost
  };
  rows.push(row);
}
// fill creation-time / availability lazily — only for skills whose availability we report
// (never-invoked: the dead-vs-too-new split; loaded-only: their weak-only avail column)
function ensureAvail(r) {
  if (r.createdAt !== undefined) return r;
  r.createdAt = skillCreatedAt(r.paths);
  r.availableSessions = availableSessionsSince(r.createdAt);
  return r;
}
for (const r of rows) if (!r.triggered || r.strongInv === 0) ensureAvail(r);

// --cost: measure each reported skill's token tax (one tokt.js subprocess per skill).
let costUnavailable = false;
if (withCost) {
  if (!toktBin()) {
    costUnavailable = true;
    if (!jsonOut) process.stderr.write("  --cost: token-budget CLI (tokt.js) not found — set $TOKT_BIN or junction the token-budget skill.\n");
  } else {
    let done = 0;
    for (const r of rows) {
      const c = measureSkillCost(primaryPath(r.paths));
      if (c) { r.alwaysOn = c.alwaysOn; r.onInvoke = c.onInvoke; r.fullyExpanded = c.fullyExpanded; }
      // wasted = the always-on description tax paid across sessions where it was available
      // but never fired (a per-session lower bound — it's actually paid every TURN).
      if (c && r.availableSessions != null && r.strongInv === 0) r.wastedTax = c.alwaysOn * r.availableSessions;
      if (!jsonOut && ++done % 10 === 0) process.stderr.write(`\r  measuring token cost ${done}/${rows.length}…`);
    }
    if (!jsonOut) process.stderr.write(`\r  measured token cost of ${rows.length} skills via ${basename(dirname(dirname(toktBin())))}          \n`);
  }
}
// triggered names observed in logs but NOT found in any discovered root (orphans)
const orphans = [...usage.keys()].filter((n) => !allSkills.has(n)).map((n) => {
  const u = usage.get(n);
  return { name: n, strongInv: u.strongInv, weakRefs: u.weakRefs, sessions: u.sessions.size, providers: [...u.providers].sort(), last: u.last };
}).filter((o) => o.strongInv > 0)   // ignore pure path-token noise for orphans
  .sort((a, b) => b.strongInv - a.strongInv);

// A skill only counts as "dead" if it was AVAILABLE to fire (≥1 session ran after it
// existed). Skills created after every scanned session ("too new") never had a chance.
const NEW_THRESHOLD = 3;   // <3 sessions of opportunity → treat as too-new, not dead
const deadAll = rows.filter((r) => !r.triggered);
const dead = deadAll.filter((r) => r.availableSessions >= NEW_THRESHOLD).sort((a, b) => b.availableSessions - a.availableSessions);
const tooNew = deadAll.filter((r) => r.availableSessions < NEW_THRESHOLD).sort((a, b) => a.name.localeCompare(b.name));
const live = rows.filter((r) => r.triggered).sort((a, b) => (b.strongInv + b.weakRefs) - (a.strongInv + a.weakRefs) || b.sessions - a.sessions);

if (jsonOut) {
  console.log(JSON.stringify({
    window: days ? `${days}d` : "all-time",
    provider, project: projectQ || null, scannedSessions: scanned, matchedSessions: projectQ ? matched : scanned,
    discoveredSkills: skills.size, triggered: live.length, neverTriggeredButAvailable: dead.length, tooNew: tooNew.length,
    dead, tooNew, live: top ? live.slice(0, top) : live, orphans,
  }, null, 2));
  process.exit(0);
}

// ── pretty report ─────────────────────────────────────────────────────────────
const bar = "─".repeat(64);
const strongLive = live.filter((r) => r.strongInv > 0);
const repoOf = (r) => { const p = r.paths.find((x) => /[/\\]\.(claude|codex)[/\\]skills[/\\]/.test(x)) || r.paths[0] || ""; return (p.replace(/[/\\]\.(claude|codex)[/\\]skills[/\\].*$/, "").split(/[/\\]/).pop()) || ""; };
const ktok = (n) => (n == null ? "" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
// per-turn always-on tax + on-invoke body, e.g. " t0=230 inv=7.6k"
const costCol = (r) => (withCost && !costUnavailable && r.alwaysOn != null ? `  t0=${String(r.alwaysOn).padStart(4)} inv=${ktok(r.onInvoke).padStart(5)}` : "");
// with --cost, rank the waste buckets by tax (big dead skills first), not by avail
if (withCost && !costUnavailable) {
  const byTax = (a, b) => (b.wastedTax || 0) - (a.wastedTax || 0) || (b.alwaysOn || 0) - (a.alwaysOn || 0);
  dead.sort(byTax);
}
console.log(bar);
console.log(`SKILL USAGE AUDIT   window=${days ? days + "d" : "all-time"}  provider=${provider}  sessions=${projectQ ? `${matched} (of ${scanned}) matching project "${projectQ}"` : scanned}`);
console.log(`discovered ${skills.size} skills · ${strongLive.length} agent-invoked · ${live.length - strongLive.length} loaded-only · ${dead.length} DEAD · ${tooNew.length} too-new${includePlugins ? "" : "   (plugins excluded; --include-plugins to add)"}`);
console.log(`NEVER AGENT-INVOKED (no Skill-tool/slash/copilot call): ${dead.length + (live.length - strongLive.length)} of ${skills.size}`);
if (withCost && !costUnavailable) {
  const neverInvoked = [...dead, ...live.filter((r) => r.strongInv === 0)];
  const tax = neverInvoked.reduce((s, r) => s + (r.alwaysOn || 0), 0);
  const wasted = neverInvoked.reduce((s, r) => s + (r.wastedTax || 0), 0);
  console.log(`TOKEN TAX of never-invoked skills: ${ktok(tax)} tok/turn always-on  ·  ≈${ktok(wasted)} tok paid across their available sessions (never fired)`);
}
console.log(bar);
console.log(`\nNote: "weak"/loaded counts are inflated by worktree skill MATERIALIZATION (kanban copies its built-in\nskills into every worktree's .claude/skills, so their SKILL.md path appears even when no agent invokes them).\n"strong" = an agent actually fired the skill. "avail" = sessions that ran AFTER the skill existed (git\nfirst-add) — the FAIR denominator; a skill is only DEAD if it had the chance to fire (avail≥${NEW_THRESHOLD}). Codex emits no strong signal.`);

console.log(`\n● NEVER TRIGGERED but WAS AVAILABLE (${dead.length}) — zero trace despite ≥${NEW_THRESHOLD} sessions after it existed`);
if (!dead.length) console.log("  (none — every available skill left some trace)");
if (withCost && !costUnavailable && dead.length) console.log(`  (sorted by token tax; t0=always-on tok/turn, inv=SKILL.md body, waste≈t0×avail)`);
for (const r of dead) console.log(`  ✗ ${r.name.padEnd(28)} avail=${String(r.availableSessions).padStart(4)}  since ${fmtDate(r.createdAt)}${costCol(r)}${withCost && !costUnavailable && r.wastedTax != null ? ` waste≈${ktok(r.wastedTax)}` : ""}  [${r.sources.join(",")}] repo:${repoOf(r) || "?"}`);

if (tooNew.length) {
  console.log(`\n● TOO NEW / never available (${tooNew.length}) — created after (almost) all scanned sessions; no fair chance to fire`);
  for (const r of tooNew) console.log(`  · ${r.name.padEnd(28)} avail=${String(r.availableSessions).padStart(4)}  since ${fmtDate(r.createdAt)}  [${r.sources.join(",")}] repo:${repoOf(r) || "?"}`);
}

if (!unusedOnly) {
  console.log(`\n● TRIGGERED (${live.length})   strong=Skill-tool/slash/copilot-field · weak=SKILL.md loaded/read`);
  console.log(`  ${"skill".padEnd(28)} ${"strong".padStart(7)} ${"weak".padStart(6)} ${"sess".padStart(5)}${withCost && !costUnavailable ? `  ${"t0".padStart(4)} ${"inv".padStart(5)}` : ""}  last        providers`);
  for (const r of (top ? live.slice(0, top) : live)) {
    console.log(`  ${r.name.padEnd(28)} ${String(r.strongInv).padStart(7)} ${String(r.weakRefs).padStart(6)} ${String(r.sessions).padStart(5)}${withCost && !costUnavailable ? `  ${String(r.alwaysOn ?? "").padStart(4)} ${ktok(r.onInvoke).padStart(5)}` : ""}  ${fmtDate(r.last)}  ${r.providers.join(",")}`);
  }
  // skills only ever read, never explicitly invoked — candidates that "fire" only via auto-injection
  const weakOnly = live.filter((r) => r.strongInv === 0);
  if (weakOnly.length) {
    console.log(`\n● REFERENCED BUT NEVER EXPLICITLY INVOKED (${weakOnly.length}) — only seen as a loaded/read SKILL.md, no Skill-tool/slash call`);
    console.log(`  (expected for Codex skills — Codex has no Skill tool; suspicious for Claude-only skills)`);
      if (withCost && !costUnavailable) weakOnly.sort((a, b) => (b.wastedTax || 0) - (a.wastedTax || 0) || (b.alwaysOn || 0) - (a.alwaysOn || 0));
    for (const r of weakOnly) console.log(`  ~ ${r.name.padEnd(28)} weak=${String(r.weakRefs).padStart(4)} avail=${String(r.availableSessions).padStart(4)}${costCol(r)}${withCost && !costUnavailable && r.wastedTax != null ? ` waste≈${ktok(r.wastedTax)}` : ""} [${r.providers.join(",")}]`);
  }
  if (orphans.length) {
    console.log(`\n● INVOKED BUT NOT FOUND ON DISK (${orphans.length}) — triggered in logs, no SKILL.md in scanned roots (uninstalled/renamed/removed)`);
    for (const o of orphans.slice(0, 20)) console.log(`  ? ${o.name.padEnd(28)} strong=${o.strongInv} [${o.providers.join(",")}]`);
  }
}
console.log("");
