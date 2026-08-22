#!/usr/bin/env node
/**
 * WHICH WORK SHOULD WE PICK UP NEXT — and, with the gate below, spawn a session
 * for. This is the tool the "identify what we could continue, then spawn for it"
 * task actually wanted, and the reason it was hand-assembled the first time:
 *
 *   - `resumable.mjs` finds sessions a limit CUT OFF. Necessary, not sufficient:
 *     on a measured fleet only 3 of 321 hits were real, and none of them was the
 *     most valuable thing to do next.
 *   - `incidents.mjs` ranks FRICTION — which session hurt, not which work is open.
 *   - The actionable next step nearly always lives in the repo's own
 *     `CONTINUE.md` / `BACKLOG.md`, which no session tool read.
 *
 * So this joins the two halves: sessions (who worked where, what was cut off,
 * what a human last asked) × repos (what their own docs say is still open, what
 * git says is unpushed or dirty) × the present (which repos already have a live
 * session, which profile has headroom). Output is a RANKED, EXPLAINED shortlist.
 *
 * Usage:
 *   node scripts/continuations.mjs                      # ranked shortlist, human-readable
 *   node scripts/continuations.mjs --days 14 --top 8
 *   node scripts/continuations.mjs --project kanban     # substring on repo path/name
 *   node scripts/continuations.mjs --all-provenance     # include board/monitor agent sessions
 *   node scripts/continuations.mjs --json
 *
 *   # the human gate — nothing spawns until a person picks:
 *   node scripts/continuations.mjs --plan plan.json     # write plan, every entry approved:false
 *   node scripts/continuations.mjs --review plan.json   # interactive gate (needs a TTY)
 *   node scripts/continuations.mjs --approve plan.json --pick 1,3
 *   node scripts/continuations.mjs --approve plan.json --pick none   # reset
 *   spawn.cmd -batch plan.json                          # launches ONLY approved entries
 *
 * The gate is deliberately split in two so both callers work: a human at a
 * terminal uses `--review`; an agent (whose stdin is /dev/null, so it cannot be
 * prompted) presents the summaries, asks its human, then records the answer with
 * `--approve --pick`. Neither can be skipped by accident — the plan is written
 * unapproved and the batch launcher refuses anything else.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { basename, dirname } from "path";
import { execFileSync } from "child_process";
import { discover } from "./lib/sessions.mjs";
import { parseClaude } from "./lib/parse.mjs";
import { classifyProvenance } from "./lib/provenance.mjs";
import { findSuccessors, successorLabel } from "./lib/successor.mjs";
import { readRepoDocs, gitState } from "./lib/repo.mjs";
import { readLiveSessions, claudeProfileHomes } from "./lib/live.mjs";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const days = parseInt(opt("--days", "10"), 10);
const top = parseInt(opt("--top", "6"), 10);
const projectQ = (opt("--project", "") || "").toLowerCase();
const allProvenance = has("--all-provenance");
const asJson = has("--json");
const minSize = parseInt(opt("--min-size", "50000"), 10);
const minTurns = parseInt(opt("--min-turns", "8"), 10);
const includeLive = has("--include-live");
const includeThin = has("--include-thin");
const planPath = opt("--plan", "");
const reviewPath = opt("--review", "");
const approvePath = opt("--approve", "");
const pickArg = opt("--pick", "");
const profileFilter = (opt("--profiles", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

const SCHEMA = "spawn-plan/1";
const nowMs = Date.now();
const windowStartMs = days > 0 ? nowMs - days * 86400000 : 0;

// ── plan file: read / write / approve ────────────────────────────────────────
// Kept intentionally small and versioned: spawn-session lives in ANOTHER repo and
// must read this without importing anything from here.
function readPlan(path) {
  if (!existsSync(path)) { console.error(`No such plan file: ${path}`); process.exit(1); }
  let plan;
  try { plan = JSON.parse(readFileSync(path, "utf-8")); } catch (e) {
    console.error(`Plan file is not valid JSON: ${e.message}`); process.exit(1);
  }
  if (plan.schema !== SCHEMA) {
    console.error(`Unexpected plan schema "${plan.schema}" (expected "${SCHEMA}")`); process.exit(1);
  }
  return plan;
}
function writePlan(path, plan) {
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
}

// ── gate: --approve --pick ───────────────────────────────────────────────────
if (approvePath) {
  const plan = readPlan(approvePath);
  const raw = pickArg.trim().toLowerCase();
  if (!raw) { console.error("--approve needs --pick <1,3 | all | none>"); process.exit(2); }
  let picked;
  if (raw === "all") picked = plan.candidates.map((_, i) => i + 1);
  else if (raw === "none") picked = [];
  else {
    picked = raw.split(/[,\s]+/).filter(Boolean).map((n) => parseInt(n, 10));
    const bad = picked.filter((n) => !Number.isInteger(n) || n < 1 || n > plan.candidates.length);
    if (bad.length) { console.error(`--pick out of range: ${bad.join(", ")} (1..${plan.candidates.length})`); process.exit(2); }
  }
  plan.candidates.forEach((c, i) => { c.approved = picked.includes(i + 1); });
  plan.approvedAt = new Date().toISOString();
  plan.approvedBy = "--pick";
  writePlan(approvePath, plan);
  const on = plan.candidates.filter((c) => c.approved);
  console.log(`Approved ${on.length} of ${plan.candidates.length} in ${approvePath}:`);
  for (const c of on) console.log(`  ✓ ${c.key}  → profile ${c.profile}  (${c.target})`);
  for (const c of plan.candidates.filter((x) => !x.approved)) console.log(`  · ${c.key}  (not approved)`);
  console.log(on.length
    ? `\nLaunch them:  & "C:\\projects\\andrena\\spawn-session\\spawn.cmd" -batch "${approvePath}"`
    : `\nNothing approved — the batch launcher will refuse this plan.`);
  process.exit(0);
}

// ── gate: --review (interactive, TTY only) ───────────────────────────────────
if (reviewPath) {
  const plan = readPlan(reviewPath);
  if (!process.stdin.isTTY) {
    console.error("--review needs an interactive terminal (stdin is not a TTY).");
    console.error("From an agent, print the summaries and then record the human's answer:");
    console.error(`  node scripts/continuations.mjs --approve "${reviewPath}" --pick 1,3`);
    process.exit(2);
  }
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  console.log(`\nHUMAN GATE — ${plan.candidates.length} candidate(s). y = spawn, n = skip, a = approve all remaining, q = stop.\n`);
  let approveRest = false;
  for (let i = 0; i < plan.candidates.length; i++) {
    const c = plan.candidates[i];
    console.log("─".repeat(74));
    console.log((c.summary || []).join("\n"));
    if (approveRest) { c.approved = true; console.log("  → approved (a)"); continue; }
    const a = (await ask(`\n  spawn #${i + 1} ${c.key} on profile ${c.profile}? [y/N/a/q] `)).trim().toLowerCase();
    if (a === "q") { console.log("  stopped — remaining entries left unapproved."); break; }
    if (a === "a") { approveRest = true; c.approved = true; continue; }
    c.approved = a === "y" || a === "yes";
  }
  rl.close();
  plan.approvedAt = new Date().toISOString();
  plan.approvedBy = "--review";
  writePlan(reviewPath, plan);
  const on = plan.candidates.filter((c) => c.approved);
  console.log(`\n${on.length} approved of ${plan.candidates.length}. ${on.length ? `Launch:\n  spawn.cmd -batch "${reviewPath}"` : "Nothing to launch."}`);
  process.exit(0);
}

// ── helpers ──────────────────────────────────────────────────────────────────
const clip = (s, n = 90) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const localTime = (iso) => {
  if (!iso) return "?";
  const d = new Date(iso);
  if (isNaN(d)) return "?";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const ageStr = (iso) => {
  const t = new Date(iso || 0).getTime();
  if (!t) return "?";
  const h = (nowMs - t) / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

// Repo root for a session cwd. A session often runs in a subdirectory
// (`beyond_vibe_coding/demo`), and the docs live at the root — grouping on cwd
// would split one repo into several candidates.
const rootCache = new Map();
function repoRoot(cwd) {
  if (!cwd) return "";
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  let root = cwd;
  try {
    root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000,
    }).trim() || cwd;
  } catch { /* not a repo — the cwd is its own unit */ }
  root = root.replace(/\//g, "\\");
  rootCache.set(cwd, root);
  return root;
}

function endingOf(stat) {
  if (stat.endedOnLimit === "usage-limit") return "usage-limit";
  if (stat.endedOnLimit === "rate-limit") return "rate-limit";
  if (stat.endedInterrupted) return "interrupted";
  if (stat.stopReason === "tool_use") return "mid-tool";
  return "normal";
}

// ── collect sessions ─────────────────────────────────────────────────────────
const records = discover("claude").filter((r) => (r.kind || "main") === "main");
const scanned = [];
for (const r of records) {
  if (windowStartMs && r.mtime.getTime() < windowStartMs) continue;
  if (r.size < minSize) continue;
  let content;
  try { content = readFileSync(r.path, "utf-8"); } catch { continue; }
  const stat = parseClaude(content.split("\n"));
  if ((stat.assistantTurns || 0) < minTurns) continue;
  const prov = classifyProvenance(content, stat.cwd);
  if (!allProvenance && !prov.humanDriven) continue;
  scanned.push({
    path: r.path, profile: r.profile, sessionId: stat.sessionId || r.sessionId,
    cwd: stat.cwd, root: repoRoot(stat.cwd),
    turns: stat.assistantTurns || 0, durationSec: stat.durationSec || 0,
    endTime: stat.endTime, ending: endingOf(stat),
    goal: stat.aiTitle || "", prov,
    lastHuman: prov.lastHuman || stat.lastPrompt || "",
    firstHuman: prov.firstHuman || stat.firstPrompt || "",
    projectDir: basename(dirname(r.path)),
  });
}

// ── successors: is a cut-off session already picked up? ──────────────────────
const cutoffs = scanned.filter((s) => s.ending === "usage-limit" || s.ending === "rate-limit");
const succ = findSuccessors(cutoffs, records);
for (const s of scanned) {
  const links = succ.get(s.sessionId) || [];
  s.successors = links;
  s.successorLabel = successorLabel(links);
}

// ── live sessions (a repo already being worked is not a candidate) ───────────
let live = [];
try {
  live = (readLiveSessions().sessions || []).filter((s) => s.state !== "orphan");
} catch { /* registry unreadable — degrade to "unknown", never block */ }
const liveByRoot = new Map();
for (const s of live) {
  const root = repoRoot(s.cwd);
  if (!liveByRoot.has(root)) liveByRoot.set(root, []);
  liveByRoot.get(root).push(s);
}

// ── group by repo ────────────────────────────────────────────────────────────
const byRoot = new Map();
for (const s of scanned) {
  if (!s.root) continue;
  if (!byRoot.has(s.root)) byRoot.set(s.root, []);
  byRoot.get(s.root).push(s);
}

const candidates = [];
for (const [root, sess] of byRoot) {
  if (projectQ && !`${root} ${basename(root)}`.toLowerCase().includes(projectQ)) continue;
  sess.sort((a, b) => new Date(b.endTime || 0) - new Date(a.endTime || 0));
  const docs = readRepoDocs(root);
  const git = gitState(root);
  const liveHere = liveByRoot.get(root) || [];
  const newest = sess[0];

  const openCont = docs.open.filter((i) => i.doc.startsWith("CONTINUE"));
  const openBack = docs.open.filter((i) => i.doc.startsWith("BACKLOG"));
  const orphanCutoffs = sess.filter((s) => (s.ending === "usage-limit" || s.ending === "rate-limit") && !s.successors.length);
  const salvaged = sess.filter((s) => (s.ending === "usage-limit" || s.ending === "rate-limit") && s.successors.length);

  // ── score ──────────────────────────────────────────────────────────────
  // Additive and auditable: every term appends its own reason string, so the
  // ranking can always be read back rather than trusted.
  let score = 0;
  const why = [], conflicts = [];

  if (openCont.length) {
    const pts = Math.min(15, openCont.length * 3);
    score += pts;
    why.push(`${openCont.length} open item(s) in CONTINUE.md`);
  }
  if (openBack.length) {
    score += Math.min(6, openBack.length * 2);
    why.push(`${openBack.length} open BACKLOG item(s)`);
  }
  if (orphanCutoffs.length) {
    score += 30;
    const c = orphanCutoffs[0];
    why.push(`a session was CUT OFF (${c.ending}) ${ageStr(c.endTime)} with no sign anyone picked it up`);
  }
  if (salvaged.length && !orphanCutoffs.length) {
    score -= 25;
    why.push(`its cut-off session${salvaged.length > 1 ? "s were" : " was"} already ${salvaged[0].successorLabel}`);
  }
  const hAge = (nowMs - new Date(newest.endTime || 0).getTime()) / 3600000;
  if (hAge < 48) { score += 10; why.push(`worked ${ageStr(newest.endTime)} — context is fresh`); }
  else if (hAge < 168) { score += 5; why.push(`last worked ${ageStr(newest.endTime)}`); }
  if (git.ahead > 0) { score += 6; why.push(`${git.ahead} unpushed commit(s)`); }
  if (git.dirty > 0) { score += 4; why.push(`${git.dirty} uncommitted file(s)`); }
  if (docs.blocked.length) why.push(`${docs.blocked.length} item(s) flagged blocked — read before starting`);
  if (!docs.continueDoc.exists) why.push("no CONTINUE.md — state must be re-derived from the code");
  if (!git.exists) why.push("not a git checkout — no branch/ahead/dirty evidence available");

  if (liveHere.length) {
    score -= 40;
    conflicts.push(`a session is ALREADY LIVE here (${liveHere.map((l) => `${l.name}@${l.profile}`).join(", ")})`);
  }
  if (sess.length > 1) score += 3;

  // Evidence that there is OPEN WORK, as opposed to merely recent work. Without
  // this gate a repo someone touched yesterday and finished outranks a repo with
  // six documented open items, because recency is cheap to earn.
  const substance = openCont.length + openBack.length + orphanCutoffs.length
    + (git.dirty > 0 ? 1 : 0) + (git.ahead > 0 ? 1 : 0);

  candidates.push({
    key: basename(root), target: root, score, why, conflicts, substance,
    sessions: sess, docs, git, liveHere, openCont, openBack, orphanCutoffs, salvaged, newest,
  });
}

candidates.sort((a, b) => b.score - a.score);

// Two exclusions, both reported rather than silent — a filtered-out candidate a
// human cannot see is indistinguishable from one the tool never found.
const thin = candidates.filter((c) => !c.substance);
const busy = candidates.filter((c) => c.substance && c.liveHere.length);
const eligible = candidates.filter((c) =>
  (includeThin || c.substance) && (includeLive || !c.liveHere.length));
const shortlist = eligible.slice(0, top);

// ── profile assignment ───────────────────────────────────────────────────────
// Spread a batch across accounts: each candidate gets a DISTINCT profile, so one
// subscription's 5-hour window does not carry the whole fan-out. Profiles that
// already host a live session sort last; --profiles constrains the pool.
function shortName(profileId) {
  // ".claude-andrena_team_5x_4" / "andrena_team_5x_4" → "5x_4" (what spawn -p takes)
  const m = String(profileId).match(/(?:team[_-]?)?([0-9]+x(?:_[0-9]+)?)$/i);
  return m ? m[1] : String(profileId);
}
// A sibling `~/.claude-*` directory is not necessarily an auth profile — measured:
// `.claude-share` is a shared-skills folder and was cheerfully proposed as a
// profile to spawn under. A real profile home has a `projects` dir.
const homes = claudeProfileHomes()
  .filter((h) => existsSync(`${h.dir}\\projects`) || existsSync(`${h.dir}/projects`))
  .map((h) => ({ id: h.id, dir: h.dir }));
const liveCountByProfile = new Map();
for (const s of live) liveCountByProfile.set(s.profile, (liveCountByProfile.get(s.profile) || 0) + 1);
let pool = homes.filter((h) => h.id !== "default");
if (profileFilter.length) {
  pool = homes.filter((h) => profileFilter.some((f) => h.id.includes(f) || shortName(h.id) === f));
}
if (!pool.length) pool = homes;
pool.sort((a, b) => (liveCountByProfile.get(a.id) || 0) - (liveCountByProfile.get(b.id) || 0) || a.id.localeCompare(b.id));
shortlist.forEach((c, i) => {
  const home = pool.length ? pool[i % pool.length] : null;
  c.profile = home ? shortName(home.id) : "";
  c.profileId = home ? home.id : "";
});

// ── capacity (advisory here; spawn-session enforces) ────────────────────────
// `fleet status --json` prints its human table regardless; `snapshot --json` is
// the machine surface. And a .cmd must go through the shell — execFileSync on it
// throws EINVAL on Windows, which looked exactly like "fleet not installed" and
// meant this never reported capacity at all.
function fleetCapacity() {
  const bin = "C:\\projects\\andrena\\claude-pick\\fleet\\fleet.cmd";
  if (!existsSync(bin)) return null;
  try {
    const out = execFileSync(process.env.COMSPEC || "cmd.exe", ["/c", bin, "snapshot", "--json"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    });
    const j = JSON.parse(out);
    const swap = j?.system?.memory?.hardFaultsPerSec || 0;
    return {
      headroomProcesses: j?.system?.headroomProcesses ?? null,
      note: swap ? `machine is SWAPPING (${swap} hard faults/s) — free memory before fanning out` : "",
    };
  } catch { return null; }
}
const capacity = fleetCapacity();

// ── seed message ─────────────────────────────────────────────────────────────
// Built from the repo's OWN open items, so the spawned session is pointed at what
// the repo says is left rather than at a guess. Ends non-committally on purpose:
// a spawned session that starts editing unattended is the worse outcome.
function seedMessage(c) {
  const items = [...c.openCont, ...c.openBack].slice(0, 4);
  const lines = [];
  lines.push(`Continue work on ${c.key}. Read CONTINUE.md, BACKLOG.md and CLAUDE.md first`
    + (c.docs.hasLocal ? " — this checkout also has a CONTINUE.local.md / BACKLOG.local.md layer, read it after the committed files" : "")
    + ".");
  if (items.length) {
    lines.push("");
    lines.push("Open items the repo's own docs list:");
    items.forEach((i, n) => lines.push(`${n + 1}. [${i.doc}] ${i.text}`));
  }
  if (c.orphanCutoffs.length) {
    const o = c.orphanCutoffs[0];
    lines.push("");
    lines.push(`Note: session ${o.sessionId.slice(0, 8)} was cut off here by a ${o.ending} on ${localTime(o.endTime)}`
      + ` after ${o.turns} turns, and nothing on disk suggests anyone picked it up.`
      + ` Its last human instruction was: "${clip(o.lastHuman, 200)}".`
      + ` Check whether its work landed before redoing any of it —`
      + ` node scripts/analyze-claude-session.mjs ${o.sessionId} --handoff will show what it left running.`);
  }
  if (c.git.dirty > 0) {
    lines.push("");
    lines.push(`The checkout has ${c.git.dirty} uncommitted file(s) on branch ${c.git.branch} — establish whose they are before committing anything.`);
  }
  lines.push("");
  lines.push("Start by telling me the current state, separating what is verified from what is merely claimed, and your proposed order of work. Do not edit until I confirm.");
  return lines.join("\n");
}

// ── summary block (what the human reads at the gate) ─────────────────────────
function summaryLines(c, rank) {
  const L = [];
  const gitBits = c.git.exists
    ? [c.git.branch || "?",
      c.git.dirty ? `${c.git.dirty} dirty` : "clean",
      c.git.ahead ? `${c.git.ahead} ahead` : null,
      c.git.behind ? `${c.git.behind} behind` : null].filter(Boolean).join(", ")
    : "not a git checkout";
  L.push(`#${rank}  ${c.key}${" ".repeat(Math.max(1, 34 - c.key.length))}score ${c.score}   → profile ${c.profile || "?"}`);
  L.push(`    repo     ${c.target}  (${gitBits})`);
  L.push(`    why      ${c.why[0] || "recent activity"}`);
  for (const w of c.why.slice(1, 4)) L.push(`             ${w}`);
  const items = [...c.openCont, ...c.openBack].slice(0, 3);
  items.forEach((i, n) => L.push(`    open ${n + 1}   [${i.doc}] ${clip(i.text, 84)}`));
  if (c.newest) {
    L.push(`    last ask "${clip(c.newest.lastHuman || c.newest.goal, 84)}"`);
    L.push(`    evidence ${c.newest.sessionId.slice(0, 8)} · ${localTime(c.newest.endTime)} · ${c.newest.turns} turns · ended ${c.newest.ending} · ${c.newest.prov.label}`);
  }
  for (const s of c.salvaged.slice(0, 2)) L.push(`    already  ${s.sessionId.slice(0, 8)} ${s.successorLabel}`);
  if (c.conflicts.length) for (const x of c.conflicts) L.push(`    CONFLICT ${x}`);
  if (c.docs.blocked.length) L.push(`    blocked  ${clip(c.docs.blocked[0].text, 84)}`);
  return L;
}

// Excluded candidates are ALWAYS reported. A repo left out because a session is
// already working it is exactly the fact a human needs at the gate; silently
// dropping it looks identical to never having found it.
function printExclusions() {
  if (busy.length && !includeLive) {
    console.log(`\nskipped — a session is already live there (--include-live to rank them anyway):`);
    for (const c of busy) {
      console.log(`  · ${c.key.padEnd(28)} ${c.liveHere.map((l) => `${l.name}@${l.profile}`).join(", ")}`);
    }
  }
  if (thin.length && !includeThin) {
    console.log(`\nskipped — recent but no open work found (no docs items, clean tree, nothing cut off): ${thin.map((c) => c.key).join(", ")}`);
    console.log(`  (--include-thin to rank them anyway)`);
  }
}

// ── output ───────────────────────────────────────────────────────────────────
const planCandidates = shortlist.map((c, i) => ({
  key: c.key,
  approved: false,
  rank: i + 1,
  score: c.score,
  target: c.target,
  profile: c.profile,
  profileId: c.profileId,
  message: seedMessage(c),
  summary: summaryLines(c, i + 1),
  why: c.why,
  conflicts: c.conflicts,
  openItems: [...c.openCont, ...c.openBack].slice(0, 6),
  git: c.git,
  evidence: c.sessions.slice(0, 3).map((s) => ({
    sessionId: s.sessionId, when: s.endTime, turns: s.turns, ending: s.ending,
    provenance: s.prov.kind, goal: s.goal, lastHuman: clip(s.lastHuman, 200),
    profile: s.profile, path: s.path,
    successors: s.successors.map((l) => ({ sessionId: l.sessionId, via: l.via })),
  })),
}));

if (planPath) {
  writePlan(planPath, {
    schema: SCHEMA,
    generated: new Date().toISOString(),
    generator: `continuations.mjs --days ${days} --top ${top}`,
    capacity,
    approvedAt: null,
    approvedBy: null,
    candidates: planCandidates,
  });
  console.log(`Wrote ${planCandidates.length} candidate(s) to ${planPath} — ALL UNAPPROVED.`);
  console.log("");
  for (const c of planCandidates) console.log(c.summary.join("\n") + "\n");
  console.log("─".repeat(74));
  console.log("HUMAN GATE — nothing spawns until someone picks. Choose one:");
  console.log(`  interactive : node scripts/continuations.mjs --review "${planPath}"`);
  console.log(`  explicit    : node scripts/continuations.mjs --approve "${planPath}" --pick 1,3`);
  console.log(`  then        : & "C:\\projects\\andrena\\spawn-session\\spawn.cmd" -batch "${planPath}"`);
  if (capacity && capacity.headroomProcesses != null) {
    console.log(`\ncapacity: room for ~${capacity.headroomProcesses} more session(s). ${capacity.note}`);
  }
  printExclusions();
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify({
    generated: new Date().toISOString(),
    window: { days, from: windowStartMs ? new Date(windowStartMs).toISOString() : null },
    scanned: scanned.length, repos: candidates.length, capacity,
    excluded: { live: busy.map((c) => c.key), thin: thin.map((c) => c.key) },
    candidates: planCandidates,
  }, null, 2));
  process.exit(0);
}

console.log("═".repeat(74));
console.log(`CONTINUATION CANDIDATES  —  ${candidates.length} repo(s) from ${scanned.length} session(s), last ${days} day(s)`);
console.log("═".repeat(74));
if (!candidates.length) {
  console.log("\nNothing found. Try --days 30, drop --project, or --all-provenance to include agent sessions.");
  process.exit(0);
}
for (let i = 0; i < shortlist.length; i++) {
  console.log("");
  console.log(summaryLines(shortlist[i], i + 1).join("\n"));
}
if (eligible.length > shortlist.length) {
  console.log(`\n… ${eligible.length - shortlist.length} more eligible repo(s). --top ${eligible.length} for all.`);
}
printExclusions();
if (capacity && capacity.headroomProcesses != null) {
  console.log(`\ncapacity: room for ~${capacity.headroomProcesses} more session(s). ${capacity.note}`);
}
console.log(`\nTo act on these: --plan <file> writes a spawn plan (unapproved), then --review / --approve gates it.`);
