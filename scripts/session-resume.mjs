#!/usr/bin/env node
/**
 * session-resume.mjs — plan (and optionally launch) the resumption of Claude
 * sessions that were interrupted (crash / hard reboot), parked waiting on a
 * now-dead background job, or cut off by a Claude usage/rate limit.
 *
 * It answers the practical post-crash questions the plain analyzer doesn't:
 *   • WHICH sessions were live when things died?  (--reboot auto-clusters by end-time)
 *   • For each, RESUME in place or START FRESH with a brief?  (age + size rule)
 *   • Give me the exact command / open a dedicated terminal per session.
 *   • For rate-limited ones, a concise handoff so a fresh run continues cleanly.
 *
 * Decision rule:
 *   rate-limited                      -> FRESH     (HAND OFF — see below)
 *   cache still warm (< 60m idle)     -> RESUME    (context re-reads at 0.1x)
 *   short session (few turns/short)   -> RESUME    (cheap to reload even if old)
 *   old AND long                      -> FRESH     (a brief beats a cold reload)
 *   cleanly completed                 -> DONE      (skip unless --include-completed)
 *
 * RESUME IS NOT THE DEFAULT FOR A RATE-LIMITED SESSION, which is the opposite of
 * what this tool used to do — and it was wrong in the worst case. Such a session
 * has by definition the LARGEST context (it ran until the account gave out), you
 * come back to it hours later so the 1-hour prompt cache is long dead, and
 * `--resume` is pinned to the one account that is out of quota. Measured on this
 * box's five real cut-offs: resuming them cold costs $11.24 against $0.56 warm,
 * a 20x multiplier paid before any new work. A brief is cents and runs anywhere.
 * The rule lives in lib/resume-economics.mjs; `--fresh-age` still tunes it.
 *
 * Reads transcripts from a chosen Claude profile dir (default ~/.claude), so it
 * works with non-default auth profiles like ~/.claude-andrena_team_5x.
 *
 * Node builtins only. Reuses lib/parse.mjs so a session reads the same here as
 * in analyze-claude-session.mjs.
 *
 * Usage:
 *   node session-resume.mjs [selectors] [output]
 *
 * Profile / where to read:
 *   --profile <name>       ~/.claude-<name>   (e.g. --profile andrena_team_5x)
 *   --config-dir <path>    explicit config dir; else $CLAUDE_CONFIG_DIR; else ~/.claude
 *
 * Which sessions (selectors; combine freely):
 *   --project <substr>     match session dir name OR recorded cwd (default: all)
 *   --reboot               auto-detect the most recent crash cluster (>=2 sessions
 *                          whose end-times fall within --gap min of each other)
 *   --gap <min>            cluster gap for --reboot (default 15)
 *   --between HH:MM-HH:MM  keep sessions whose LAST activity is in today's window
 *   --since <HH:MM|Nm|Nh>  keep sessions with last activity at/after this
 *   --interrupted          keep only interrupted/parked (drop cleanly-completed)
 *   --rate-limited         keep only sessions ended by a Claude usage/rate limit
 *   --include-completed    keep cleanly-completed sessions too
 *   --limit <N>            cap number of sessions (newest first)
 *
 * Tuning:
 *   --launch-profile <name>     launch under ~/.claude-<name> instead of each
 *   --launch-config-dir <path>  session's OWN profile. Use ONLY if you explicitly
 *                          want a different account — resume fails if the session
 *                          isn't in that profile. Default & safe: same profile.
 *   --skip-perms           force --dangerously-skip-permissions on every relaunch
 *   --safe-perms           force default perms (ignore the session's inferred mode)
 *                          (default: infer each session's mode from its transcript —
 *                           bypassPermissions → --dangerously-skip-permissions, etc.)
 *   --fresh-age <min>      age over which long sessions go FRESH (default 60)
 *   --short-turns <N>      <= this many assistant turns counts as short (default 180)
 *   --short-min <min>      AND <= this many minutes duration counts as short (default 35)
 *   --now <ISO>            override "now" (testing)
 *
 * Output:
 *   (default)              a per-session report card + the exact launch command
 *   --json                 machine-readable plan
 *   --write-briefs [dir]   write <id8>.brief.md handoff files (default: ./resume-briefs)
 *   --print-commands       print only the launch commands, one per line
 *   --launch [resume|all]  actually spawn one Windows Terminal tab per session
 *                          (resume = only RESUME/CONTINUE; all = also FRESH). Writes
 *                          briefs first. No-op with a warning off-Windows / no wt.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir, tmpdir } from "os";
import { spawnSync } from "child_process";
import { parseClaude } from "./lib/parse.mjs";
import { recommendMode } from "./lib/resume-economics.mjs";

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const num = (f, d) => { const v = val(f); return v == null ? d : Number(v); };

function resolveConfigDir() {
  if (has("--config-dir") && val("--config-dir")) return val("--config-dir");
  if (has("--profile") && val("--profile")) return join(homedir(), `.claude-${val("--profile")}`);
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return join(homedir(), ".claude");
}

const CONFIG_DIR = resolveConfigDir();
const PROJECTS = join(CONFIG_DIR, "projects");

// VITAL: a session must relaunch under the SAME auth profile it originally ran
// under (else `claude --resume <id>` can't find it). By default the launch
// profile is each session's OWN profile (derived from its file path), never a
// guessed global. The user can deliberately override to a different profile with
// --launch-profile <name> / --launch-config-dir <path> ("unless the user prompts
// for other profiles") — which prints a loud warning since resume may then fail.
const LAUNCH_CFG_OVERRIDE = has("--launch-config-dir") ? val("--launch-config-dir")
  : has("--launch-profile") ? join(homedir(), `.claude-${val("--launch-profile")}`)
  : null;
const NOW = val("--now") ? new Date(val("--now")) : new Date();
const FRESH_AGE = num("--fresh-age", 60);
const SHORT_TURNS = num("--short-turns", 180);
const SHORT_MIN = num("--short-min", 35);
const GAP_MIN = num("--gap", 15);
const LIMIT = num("--limit", 0);

if (!existsSync(PROJECTS)) {
  console.error(`No projects dir at ${PROJECTS}. Check --profile/--config-dir.`);
  process.exit(1);
}

// ── discovery ───────────────────────────────────────────────────────────────
// Enumerate top-level session files (skip agent-*.jsonl subagent transcripts and
// non-jsonl). Stat first; parse only files that survive the cheap selectors.
function enumerateFiles() {
  const projSub = val("--project");
  const out = [];
  for (const dir of readdirSync(PROJECTS)) {
    if (projSub && !dir.toLowerCase().includes(projSub.toLowerCase())) {
      // dir name didn't match; may still match on cwd — defer, but only read such
      // dirs if no project filter would exclude everything. Cheapest: keep, filter on cwd later.
    }
    const dirPath = join(PROJECTS, dir);
    let files;
    try { files = readdirSync(dirPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
      const p = join(dirPath, f);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.size < 200) continue; // empty/stub sessions
      // profileDir is derived from the file's OWN location, NOT the global scan
      // dir: a transcript lives at <profile>/projects/<projdir>/<id>.jsonl, so its
      // profile == two levels up from its project subdir. This makes "relaunch
      // under the same profile" a LOCAL, provable property — correct even if a
      // future change scans multiple profiles at once. VITAL: claude --resume
      // resolves the session from CLAUDE_CONFIG_DIR/projects, so a wrong profile
      // silently fails to find the session.
      const profileDir = resolve(dirname(p), "..", "..");
      out.push({ path: p, dir, id: f.replace(/\.jsonl$/, ""), mtime: st.mtime, size: st.size, profileDir });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ── rate-limit detection ──────────────────────────────────────────────────────
// Claude-side usage/rate limits, NOT an app's own rate-limit domain code. Scope
// the match to the LAST agent message + tool errors only — a session's Read/Grep
// results routinely contain source/docs that mention "rate limit", so scanning
// raw text self-matches (e.g. this skill's own docs). The genuine end-of-session
// limit shows up as the final assistant notice or a synthetic API error.
const RATE_LIMIT_RE = /claude (ai )?usage limit reached|(^|[^a-z])usage limit reached|approaching your usage limit|rate_limit_error|usage limit will reset/i;
function detectRateLimit(lastAsst, errors) {
  const scope = [lastAsst || "", ...(errors || []).slice(-3)].join("\n");
  const m = scope.match(RATE_LIMIT_RE);
  return m ? m[0].trim() : null;
}

// ── permission-mode inference ──────────────────────────────────────────────────
// Claude records "permissionMode":"default|acceptEdits|bypassPermissions|plan" on
// entries. Take the LAST value (mode in effect when the session stopped; a user
// can toggle it mid-run) and map it back to the CLI flag so the relaunch inherits
// the same setting — notably --dangerously-skip-permissions (bypassPermissions).
function detectPermMode(raw) {
  let last = null;
  for (const m of raw.matchAll(/"permissionMode":"([a-zA-Z]+)"/g)) last = m[1];
  return last;
}
function permFlagFor(mode) {
  if (mode === "bypassPermissions") return "--dangerously-skip-permissions";
  if (mode === "acceptEdits") return "--permission-mode acceptEdits";
  if (mode === "plan") return "--permission-mode plan";
  return ""; // default / unknown → no flag
}
// Global override: --skip-perms forces bypass, --safe-perms/--no-skip-perms forces
// default, otherwise infer per session.
const PERM_OVERRIDE = has("--skip-perms") ? "--dangerously-skip-permissions"
  : (has("--safe-perms") || has("--no-skip-perms")) ? ""
  : null;

// ── background-wait / parked detection ─────────────────────────────────────────
const WAIT_RE = /\b(wait(ing)? (for|on)|in the background|background (run|job|task)|notification|i'?ll (wait|be notified)|still (running|in progress|in globalsetup))\b/i;

// ── todo / pending extraction ──────────────────────────────────────────────────
// Pull the last TodoWrite / Task* tool_use so the brief can list what was open.
function extractPending(lines) {
  let todos = null;
  const tasks = new Map(); // id/label -> status
  for (const line of lines) {
    const t = line.trim(); if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.type !== "assistant" || !o.message?.content) continue;
    for (const b of o.message.content) {
      if (b.type !== "tool_use") continue;
      if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) todos = b.input.todos;
      else if (b.name === "TaskCreate" || b.name === "TaskUpdate") {
        const id = b.input?.taskId || b.input?.id || b.input?.description || b.input?.prompt?.slice(0, 40);
        const status = b.input?.status || (b.name === "TaskCreate" ? "pending" : "");
        const desc = b.input?.description || b.input?.prompt?.slice(0, 80) || id;
        if (id) tasks.set(id, { desc, status });
      }
    }
  }
  const open = [];
  if (todos) for (const td of todos) if (td.status !== "completed") open.push(`${td.status === "in_progress" ? "▸" : "•"} ${td.content || td.activeForm || ""}`.trim());
  for (const [, v] of tasks) if (v.status && v.status !== "completed") open.push(`• ${v.desc}${v.status ? ` (${v.status})` : ""}`);
  return open.slice(0, 8);
}

// ── classify one session ────────────────────────────────────────────────────
function classify(entry) {
  const raw = readFileSync(entry.path, "utf-8");
  const lines = raw.split("\n");
  const s = parseClaude(lines);
  const endTs = s.endTime ? new Date(s.endTime) : entry.mtime;
  const ageMin = Math.round((NOW - endTs) / 60000);
  const durMin = Math.round((s.durationSec || 0) / 60);
  const turns = s.assistantTurns || 0;
  const lastAsst = (s.assistantTexts[s.assistantTexts.length - 1] || "").trim();
  const firstUser = (s.userMessages.find((m) => m && m.trim().length > 8) || s.userMessages[0] || "").trim();
  const lastUser = (s.userMessages[s.userMessages.length - 1] || "").trim();

  const rateLimit = detectRateLimit(lastAsst, s.errors);
  const permMode = detectPermMode(raw);
  const permFlag = PERM_OVERRIDE !== null ? PERM_OVERRIDE : permFlagFor(permMode);
  const parked = WAIT_RE.test(lastAsst);
  const completedPhrase = /\b(done|complete|pushed|committed|finished|all set|ready for review|✅)\b/i.test(lastAsst.slice(0, 200));

  let state;
  if (rateLimit) state = "rate-limited";
  else if (s.stopReason === "tool_use") state = "interrupted";
  else if (parked) state = "parked";
  else if (s.stopReason === "end_turn" && completedPhrase) state = "completed";
  else if (s.stopReason === "end_turn") state = "idle"; // ended cleanly, not obviously done or parked
  else state = "interrupted";

  const short = turns <= SHORT_TURNS && durMin <= SHORT_MIN;

  // Resume or hand off? Priced rather than assumed — lib/resume-economics.mjs.
  const rec = recommendMode({
    idleMin: ageMin,
    contextTokens: s.maxContextTokens || 0,
    model: s.model,
    sessionProfile: entry.profileDir || "",
    targetProfile: LAUNCH_CFG_OVERRIDE || "",
  });

  let decision, why;
  if (state === "completed") { decision = "DONE"; why = "ended cleanly ('done/pushed') — nothing to resume"; }
  // A rate-limited session used to be classified CONTINUE, i.e. "resume it". That
  // was backwards, and it was backwards in the single worst case: such a session
  // is by definition the LARGEST context (it ran until the account gave out), you
  // come back to it hours later so the 1h cache is long dead, and `--resume` is
  // pinned to the very account that is out of quota. Handing it off is both
  // cheaper (measured 20x on this box's five real cut-offs) and the only option
  // that can run somewhere with headroom.
  else if (state === "rate-limited") {
    decision = "FRESH";
    why = `cut off by a usage limit — hand off, don't resume: ${rec.why[0]}`;
  }
  // When the refill CAN be priced, the price decides. `short` (few turns, short
  // duration) was only ever a proxy for "small context, cheap to reload", and it
  // is the worse measure now that the actual context size is in hand — a 2-turn
  // session that read a lot carries 75k, and reloading it cold is not cheap.
  else if (rec.priced) {
    decision = rec.mode === "resume" ? "RESUME" : "FRESH";
    why = rec.why[0];
  }
  else if (short) { decision = "RESUME"; why = `short session (${turns} turns / ${durMin}m) — cheap to reload; ${rec.why[0]}`; }
  else { decision = "FRESH"; why = `old (${ageMin}m) & long (${turns} turns) — a brief beats reloading stale ctx`; }

  return {
    ...entry, sessionId: s.sessionId || entry.id, cwd: s.cwd || "",
    model: s.model, stopReason: s.stopReason, endTs, ageMin, durMin, turns,
    outTokens: s.outputTokens, state, short, decision, why, rateLimit,
    contextTokens: s.maxContextTokens || 0, recommend: rec.mode, coldRefillUsd: Number(rec.cost.cold.toFixed(2)),
    permMode, permFlag, parked, firstUser, lastUser, lastAsst,
    pending: extractPending(lines),
    lastError: (s.errors[s.errors.length - 1] || "").replace(/\s+/g, " ").slice(0, 160),
  };
}

// ── selectors ─────────────────────────────────────────────────────────────────
function parseSince(v) {
  if (!v) return null;
  let m;
  if ((m = v.match(/^(\d+)m$/))) return new Date(NOW - m[1] * 60000);
  if ((m = v.match(/^(\d+)h$/))) return new Date(NOW - m[1] * 3600000);
  if ((m = v.match(/^(\d{1,2}):(\d{2})$/))) { const d = new Date(NOW); d.setHours(+m[1], +m[2], 0, 0); return d; }
  return null;
}
function parseBetween(v) {
  const m = v && v.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const a = new Date(NOW); a.setHours(+m[1], +m[2], 0, 0);
  const b = new Date(NOW); b.setHours(+m[3], +m[4], 59, 999);
  return [a, b];
}

// Auto-detect the crash: a hard reboot kills several live sessions within seconds,
// so their end-times bunch far tighter than the normal spacing between sessions.
// "Most recent cluster" is WRONG when work resumed after the crash (those later
// sessions are newer but isolated). Instead: for every session, grow the maximal
// set of OTHER sessions whose end-times are within GAP_MIN, then pick the cluster
// with the most members (tiebreak: smallest internal time-spread = tightest = the
// simultaneous kill). Requires >=2 members. If --between/--since scoped the input,
// this just clusters within that window.
function rebootCluster(sessions) {
  const sorted = [...sessions].sort((a, b) => b.endTs - a.endTs);
  let best = null;
  for (let i = 0; i < sorted.length; i++) {
    const cluster = [sorted[i]];
    for (let j = 0; j < sorted.length; j++) {
      if (j === i) continue;
      if (Math.abs(sorted[i].endTs - sorted[j].endTs) / 60000 <= GAP_MIN) cluster.push(sorted[j]);
    }
    if (cluster.length < 2) continue;
    const spread = (Math.max(...cluster.map((c) => +c.endTs)) - Math.min(...cluster.map((c) => +c.endTs))) / 60000;
    if (!best || cluster.length > best.cluster.length || (cluster.length === best.cluster.length && spread < best.spread)) {
      best = { cluster, spread };
    }
  }
  // Dedupe (each member appears once) and return newest-first.
  if (!best) return [];
  const seen = new Set();
  return best.cluster.filter((c) => !seen.has(c.sessionId) && seen.add(c.sessionId)).sort((a, b) => b.endTs - a.endTs);
}

// ── build plan ────────────────────────────────────────────────────────────────
let entries = enumerateFiles();
const projSub = val("--project");
// classify (parse) — but to stay cheap, if a plain time selector is present, prefilter by mtime.
const since = parseSince(val("--since"));
const between = parseBetween(val("--between"));
if (since) entries = entries.filter((e) => e.mtime >= since);
if (between) entries = entries.filter((e) => e.mtime >= between[0] && e.mtime <= between[1]);

let sessions = entries.map(classify);
if (projSub) sessions = sessions.filter((s) => s.dir.toLowerCase().includes(projSub.toLowerCase()) || s.cwd.toLowerCase().includes(projSub.toLowerCase()));
// Drop the currently-live session (active within the last minute) so the crash
// cluster and "resume" list aren't polluted by the session doing the planning.
if (!has("--include-live")) sessions = sessions.filter((s) => s.ageMin >= 1);
if (has("--reboot")) sessions = rebootCluster(sessions);
if (has("--rate-limited")) sessions = sessions.filter((s) => s.state === "rate-limited");
if (has("--interrupted")) sessions = sessions.filter((s) => ["interrupted", "parked", "rate-limited"].includes(s.state));
if (!has("--include-completed") && !has("--rate-limited")) sessions = sessions.filter((s) => s.state !== "completed" && s.state !== "idle");
sessions.sort((a, b) => b.endTs - a.endTs);
if (LIMIT) sessions = sessions.slice(0, LIMIT);

// ── profile-integrity guard (VITAL) ───────────────────────────────────────────
// Assert every session will relaunch under the profile it actually ran in. With
// the default (no override) this is guaranteed by construction (launch dir =
// file's own profileDir); we still verify and shout on any drift or override so
// a wrong-account resume can never happen silently.
function pbase(p) { return (p || "").split(/[\\/]/).filter(Boolean).pop() || p; }
for (const s of sessions) {
  s.launchCfg = launchCfgFor(s);
  s.profileMismatch = resolve(s.launchCfg).toLowerCase() !== resolve(s.profileDir).toLowerCase();
}
if (LAUNCH_CFG_OVERRIDE) {
  const bad = sessions.filter((s) => s.profileMismatch);
  console.error(`\x1b[33m⚠ --launch override in effect: launching under ${pbase(LAUNCH_CFG_OVERRIDE)} instead of each session's own profile.`);
  if (bad.length) console.error(`  ${bad.length} session(s) did NOT run under that profile — 'claude --resume' will fail to find them. IDs: ${bad.map((s) => s.sessionId.slice(0, 8)).join(", ")}\x1b[0m`);
  else console.error(`  (all selected sessions happen to belong to that profile)\x1b[0m`);
} else {
  const drift = sessions.filter((s) => s.profileMismatch);
  if (drift.length) console.error(`\x1b[31m✗ BUG: ${drift.length} session(s) have a launch/profile mismatch without an override — refusing to guess. IDs: ${drift.map((s) => s.sessionId.slice(0, 8)).join(", ")}\x1b[0m`);
}

// ── brief text ──────────────────────────────────────────────────────────────
function clip(s, n) { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; }
function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function briefMarkdown(s) {
  const rebootNote = (s.parked || s.state === "parked")
    ? "\n> ⚠ This session was **parked waiting on a background job** (test/e2e run) that the reboot **killed**. Do not wait for a notification — re-check / re-run that job as the first step.\n"
    : "";
  const rl = s.rateLimit ? `\n> ⛔ Ended by a **Claude usage/rate limit** (\`${clip(s.rateLimit, 60)}\`). Pick up exactly where it stopped.\n` : "";
  return `# Handoff brief — session ${s.sessionId.slice(0, 8)}

- **Repo/cwd:** \`${s.cwd}\`
- **Model:** ${s.model}   **Ended:** ${fmtLocal(s.endTs)} (${s.ageMin}m ago)
- **Size:** ${s.turns} turns / ${s.durMin}m   **Stop:** ${s.stopReason || "—"}   **State:** ${s.state}
- **Full transcript:** \`${s.path}\`
${rl}${rebootNote}
## Original goal
${clip(s.firstUser, 700) || "(none captured)"}

## Last instruction from you
${clip(s.lastUser, 500) || "(none)"}

## Where it left off (last agent message)
${clip(s.lastAsst, 900) || "(none)"}
${s.pending.length ? `\n## Open items\n${s.pending.join("\n")}\n` : ""}${s.lastError ? `\n## Last error seen\n\`${s.lastError}\`\n` : ""}
## Next action
Re-establish state (git status, check any background job above), then continue the goal. Read the full transcript above if you need deeper context.
`;
}

// ── launch command ────────────────────────────────────────────────────────────
// Windows Terminal parses `;` in its command line as a tab/command separator, so
// piping `$env:X='...'; claude ...` straight into `wt … powershell -Command`
// gets split and mangled. We sidestep it entirely: write a tiny per-session .cmd
// launcher (sets CLAUDE_CONFIG_DIR, cd's, runs claude) and have wt just run that
// script — no semicolons, no quoting hell. Bonus: the .cmd is re-runnable later
// (double-click) to relaunch that exact session.
function briefDir() {
  return val("--write-briefs") || join(tmpdir(), "resume-briefs");
}
function launchCfgFor(s) {
  // Each session's own profile by default; global override only if the user asked.
  return LAUNCH_CFG_OVERRIDE || s.profileDir || CONFIG_DIR;
}
// ── delegate to spawn-session ────────────────────────────────────────────────
// This used to write its own per-session .cmd launcher, which set
// CLAUDE_CONFIG_DIR, cd'd, and ran claude — and nothing else. That is the defect:
// wt.exe hands the LAUNCHING process's environment to the new tab, so every
// session relaunched from inside a Claude session inherited
// CLAUDE_CODE_CHILD_SESSION=1, which turns transcript saving OFF. A resumed
// session that saves no transcript cannot be resumed again — silently defeating
// the entire point of this tool. spawn-session already scrubs those markers (and
// CLAUDECODE, the parent's messaging socket/token), pre-accepts the trust dialog
// and supplies TERM, so there is now ONE launcher on this machine instead of two,
// and the better one wins.
const SPLIT_LINES = /\r?\n/;
const SPAWN_CMD = "C:\\projects\\andrena\\spawn-session\\spawn.cmd";
const haveSpawn = existsSync(SPAWN_CMD);

// A FRESH session is seeded with a pointer to its brief. The seed goes in a FILE
// (`-mf`): prompt text on a command line is torn apart by wt's ';' handling and by
// cmd's parentheses, and no amount of quoting closes that class.
function seedFileFor(s, briefPath) {
  const sp = join(briefDir(), `seed-${s.sessionId.slice(0, 8)}.txt`);
  writeFileSync(sp, `Resume prior work. Read the handoff brief at ${briefPath} for context, then continue with its Next action.\n`, "utf-8");
  return sp;
}

function spawnArgsFor(s, briefPath) {
  const args = [s.cwd || process.cwd()];
  const cfg = launchCfgFor(s);
  if (cfg) args.push("-p", cfg);
  if (s.decision === "RESUME" || s.decision === "CONTINUE") {
    args.push("-resume", s.sessionId);
  } else {
    args.push("-mf", seedFileFor(s, briefPath));
  }
  // The permission mode comes from THIS session's transcript, so the inherited
  // mode of whoever is running the tool must not leak in: -safe means "do not
  // inherit", and -dsp re-applies bypass only when the session actually had it.
  if (s.permFlag === "--dangerously-skip-permissions") args.push("-dsp");
  else args.push("-safe");
  return args;
}

function fmtCmd(s, briefPath) {
  if (!haveSpawn) return `(spawn-session not installed at ${SPAWN_CMD} — resume by hand: claude --resume ${s.sessionId})`;
  return `& "${SPAWN_CMD}" ` + spawnArgsFor(s, briefPath).map((a) => /\s/.test(a) ? `"${a}"` : a).join(" ");
}

// ── output ──────────────────────────────────────────────────────────────────
const DEC_COLOR = { RESUME: "\x1b[32m", CONTINUE: "\x1b[36m", FRESH: "\x1b[33m", DONE: "\x1b[90m" };
const R = "\x1b[0m";

if (!sessions.length) {
  console.log(`No matching sessions in ${PROJECTS}${projSub ? ` (project~="${projSub}")` : ""}.`);
  process.exit(0);
}

// Always materialize a brief + a .cmd launcher per actionable session into the
// brief dir (default %TEMP%/resume-briefs). Cheap, and it makes every printed
// `run:` command immediately runnable (and re-runnable) rather than referencing
// files that don't exist yet.
const dir = briefDir();
mkdirSync(dir, { recursive: true });
const briefPaths = new Map();
for (const s of sessions) {
  if (s.decision === "DONE") continue;
  const bp = join(dir, `${s.sessionId.slice(0, 8)}.brief.md`);
  writeFileSync(bp, briefMarkdown(s), "utf-8");
  briefPaths.set(s.sessionId, bp);
}

if (has("--json")) {
  console.log(JSON.stringify({
    configDir: CONFIG_DIR, now: NOW.toISOString(),
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId, cwd: s.cwd, model: s.model, endTs: s.endTs.toISOString(),
      ageMin: s.ageMin, turns: s.turns, durMin: s.durMin, state: s.state, short: s.short,
      permMode: s.permMode, permFlag: s.permFlag,
      profileDir: s.profileDir, launchCfg: s.launchCfg, profileMismatch: s.profileMismatch,
      decision: s.decision, why: s.why, rateLimit: s.rateLimit, pending: s.pending,
      contextTokens: s.contextTokens, recommend: s.recommend, coldRefillUsd: s.coldRefillUsd,
      firstUser: clip(s.firstUser, 300), lastAsst: clip(s.lastAsst, 300),
      briefPath: briefPaths.get(s.sessionId) || null,
      command: s.decision === "DONE" ? null : fmtCmd(s, briefPaths.get(s.sessionId)),
    })),
  }, null, 2));
  process.exit(0);
}

if (has("--print-commands")) {
  for (const s of sessions) {
    if (s.decision === "DONE") continue;
    console.log(fmtCmd(s, briefPaths.get(s.sessionId)));
  }
  process.exit(0);
}

// human report
console.log(`\n${"═".repeat(72)}`);
console.log(`RESUME PLAN — ${sessions.length} session(s)   profile: ${CONFIG_DIR}`);
console.log(`now ${fmtLocal(NOW)}   rule: <${FRESH_AGE}m→resume · short→resume · old+long→fresh`);
console.log("═".repeat(72));
for (const s of sessions) {
  const c = DEC_COLOR[s.decision] || "";
  const permLabel = s.permFlag === "--dangerously-skip-permissions" ? "skip-perms" : (s.permMode || "default");
  const profLabel = s.profileMismatch ? `\x1b[31mprofile:${pbase(s.launchCfg)}!=${pbase(s.profileDir)}\x1b[0m` : `profile:${pbase(s.launchCfg)}`;
  console.log(`\n${c}● ${s.decision}${R}  ${s.sessionId.slice(0, 8)}  [${s.state}]  ${s.ageMin}m ago · ${s.turns} turns · ${s.durMin}m · ${permLabel} · ${profLabel}`);
  console.log(`  why:   ${s.why}`);
  console.log(`  goal:  ${clip(s.firstUser, 90) || "—"}`);
  console.log(`  last:  ${clip(s.lastAsst, 90) || "—"}`);
  if (s.pending.length) console.log(`  open:  ${s.pending.slice(0, 3).map((p) => clip(p, 50)).join(" | ")}`);
  const bp = briefPaths.get(s.sessionId);
  if (bp) console.log(`  brief: ${bp}`);
  if (s.decision !== "DONE") {
    console.log(`  run:   \x1b[90m${fmtCmd(s, briefPaths.get(s.sessionId))}${R}`);
  }
}
console.log(`\n${"─".repeat(72)}`);
const nR = sessions.filter((s) => s.decision === "RESUME").length;
const nC = sessions.filter((s) => s.decision === "CONTINUE").length;
const nF = sessions.filter((s) => s.decision === "FRESH").length;
console.log(`${nR} resume · ${nC} continue · ${nF} fresh · ${sessions.filter((s) => s.decision === "DONE").length} done`);
console.log(`Launch all in dedicated WT tabs:  node session-resume.mjs ${argv.filter((a) => !["--launch"].includes(a)).join(" ")} --launch all`);
console.log("─".repeat(72));

// ── actually launch ───────────────────────────────────────────────────────────
if (has("--launch")) {
  const mode = val("--launch") || "resume"; // resume | fresh | all
  const isWin = process.platform === "win32";
  const launchable = sessions.filter((s) => s.decision !== "DONE" && (
    mode === "all" ||
    (mode === "fresh" && s.decision === "FRESH") ||
    (mode === "resume" && (s.decision === "RESUME" || s.decision === "CONTINUE"))
  ));
  if (!isWin) { console.log("\n(--launch spawns Windows Terminal tabs; not on Windows — use --print-commands.)"); process.exit(0); }
  console.log(`\nLaunching ${launchable.length} tab(s) [mode=${mode}]…`);
  if (!haveSpawn) {
    console.log(`
spawn-session is not installed at ${SPAWN_CMD}.`);
    console.log("Nothing launched — see --print-commands for the per-session lines.");
    process.exit(2);
  }
  for (const s of launchable) {
    const args = spawnArgsFor(s, briefPaths.get(s.sessionId));
    // Synchronous, and its output is surfaced: spawn-session runs a preflight that
    // can REFUSE (a live session already in that checkout, no RAM headroom), and a
    // refusal the caller cannot see is worse than no check at all.
    const res = spawnSync(process.env.COMSPEC || "cmd.exe", ["/c", SPAWN_CMD, ...args], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 240000,
    });
    const out = `${res.stdout || ""}${res.stderr || ""}`;
    const refused = /\[preflight\] REFUSE/.test(out);
    console.log(`  ${s.decision} ${s.sessionId.slice(0, 8)} → ${refused ? "REFUSED by preflight" : res.status === 0 ? "tab opened" : `failed (exit ${res.status})`}`);
    for (const line of out.split(SPLIT_LINES).filter((l) => /REFUSE|not launching/.test(l))) console.log(`      ${line.trim()}`);
  }
  console.log("Done. Each session is in its own titled tab (▶ resume · ✦ fresh).");
}
