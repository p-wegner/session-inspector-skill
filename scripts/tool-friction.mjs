#!/usr/bin/env node
/**
 * Detect repeated MULTI-STEP command sequences across sessions — the "the agent
 * always runs these 3 commands in this order" pattern — and rank them as
 * candidates for tooling improvement: a combined CLI verb, a changed default,
 * a new script, or a wrapper that bakes the sequence in.
 *
 * Different from `repeatedCommands` (in lib/parse.mjs, surfaced by the
 * per-session analyzers and incidents.mjs): that flags one exact command
 * re-run N times *within* a session (a retry/rerun signal — friction from
 * failure). This flags an ORDERED CHAIN of distinct commands that recurs
 * across many sessions (a friction signal from the CLI's own shape — the
 * agent is manually gluing together steps a single verb should do).
 *
 * Method: normalize each Bash-like command to a signature (first token +
 * subcommand, args stripped), then slide an n-gram window (default 2 and 3)
 * over each session's command list, counting how often each ordered n-gram of
 * signatures recurs — within a session (immediate rerun of a workflow) and
 * across sessions (a structural pattern, not a one-off). Ranked by
 * sessions-that-used-it × total occurrences, since "3 different sessions each
 * did this twice" is a stronger tooling signal than "1 session did it 20
 * times in a retry loop."
 *
 * Usage:
 *   node scripts/tool-friction.mjs                       # last 30d, n=2,3, all projects
 *   node scripts/tool-friction.mjs --project refactor-skill
 *   node scripts/tool-friction.mjs --provider claude      # claude | codex | copilot | all
 *   node scripts/tool-friction.mjs --days 90
 *   node scripts/tool-friction.mjs --n 2,3,4              # n-gram sizes to scan
 *   node scripts/tool-friction.mjs --min-sessions 2        # drop chains seen in <N sessions
 *   node scripts/tool-friction.mjs --grep rb-refactor      # only chains mentioning this substring
 *   node scripts/tool-friction.mjs --top 20
 *   node scripts/tool-friction.mjs --json
 *
 * Then read the strategy catalog in references/tooling-improvement.md to turn
 * a hit into an actual change (combined verb, new default, preflight check, …).
 */

import { readFileSync } from "fs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";
import { summarize } from "./lib/parse.mjs";

// ── normalize a shell command to a clusterable signature ────────────────────
// "node rb-refactor.mjs rename --kind method --apply --file x.rb" -> "node rb-refactor.mjs rename"
// "git commit -m 'fix: ...'"                                       -> "git commit"
// "npm run test -- --watch"                                        -> "npm run test"
function signature(cmd) {
  let s = String(cmd || "").trim();
  if (!s) return "";
  // first pipeline segment only — the chain is about invocations, not shell plumbing
  s = s.split(/\s*(?:&&|;|\|)\s*/)[0];
  const tokens = s.split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  // drop path noise from the leading interpreter/script token
  let head = tokens[0].replace(/^\.\/|^\.\\/, "");
  head = basename(head.replace(/\\/g, "/"));
  const parts = [head];
  // keep up to 2 more bare-word tokens (subcommand/verb), stop at first flag or path-like arg
  for (let i = 1; i < tokens.length && parts.length < 3; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) break;
    if (/[\\/]/.test(t) || /\.\w{1,4}$/.test(t)) break; // looks like a path/file arg
    parts.push(t);
  }
  return parts.join(" ");
}

// ── n-grams of consecutive signatures within one session's command list ────
function ngrams(sigs, n) {
  const out = [];
  for (let i = 0; i + n <= sigs.length; i++) {
    const window = sigs.slice(i, i + n);
    if (window.some((s) => !s)) continue;
    if (new Set(window).size === 1) continue; // A,A,A is a rerun loop, not a chain — see repeatedCommands
    out.push(window.join(" → "));
  }
  return out;
}

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const provider = opt("--provider", "all");
const projectQ = (opt("--project", "") || "").toLowerCase();
const grepQ = (opt("--grep", "") || "").toLowerCase();
const days = parseInt(opt("--days", "30"), 10);
const ns = (opt("--n", "2,3") || "2,3").split(",").map((x) => parseInt(x, 10)).filter((x) => x >= 2);
const minSessions = parseInt(opt("--min-sessions", "2"), 10);
const top = parseInt(opt("--top", "25"), 10);
const asJson = flag("--json");
const windowStartMs = days > 0 ? Date.now() - days * 86400000 : 0;

// ── collect ──────────────────────────────────────────────────────────────────
const sessions = discover(provider === "all" ? "all" : provider);
// chain-signature -> { count, sessions:Set, sample: raw command chain, projects:Set }
const chains = new Map();

for (const s of sessions) {
  if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
  let content;
  try { content = readFileSync(s.path, "utf-8"); } catch { continue; }

  const meta = extractMeta(s.provider, content);
  const id = projectIdentity(meta.cwd || "");
  const folder = s.provider === "claude" ? basename(dirname(s.path)) : "";
  const haystack = [folder, meta.cwd, id.project, id.projectKey].join(" ").toLowerCase();
  if (projectQ && !haystack.includes(projectQ)) continue;

  const sum = summarize(s.provider, content);
  if (!sum) continue;
  const cmds = sum.commandsRun || [];
  if (cmds.length < 2) continue;

  const sigs = cmds.map(signature);
  const sid = sum.sessionId || basename(s.path).replace(/\.jsonl$/, "");
  const project = id.project !== "unknown" ? id.project : (folder || meta.cwd || "?");

  for (const n of ns) {
    for (const g of ngrams(sigs, n)) {
      if (grepQ && !g.toLowerCase().includes(grepQ)) continue;
      let e = chains.get(g);
      if (!e) { e = { chain: g, n, count: 0, sessions: new Set(), projects: new Set() }; chains.set(g, e); }
      e.count++;
      e.sessions.add(sid);
      e.projects.add(project);
    }
  }
}

let rows = [...chains.values()]
  .map((e) => ({ ...e, nSessions: e.sessions.size, nProjects: e.projects.size }))
  .filter((e) => e.nSessions >= minSessions)
  .sort((a, b) => (b.nSessions * b.count) - (a.nSessions * a.count) || b.count - a.count);

if (asJson) {
  console.log(JSON.stringify({
    scope: { provider, project: projectQ || "(all)", days: days || "all", n: ns, minSessions },
    sessionsScanned: sessions.length,
    chains: rows.slice(0, top).map((r) => ({ chain: r.chain, n: r.n, occurrences: r.count, sessions: r.nSessions, projects: [...r.projects] })),
  }, null, 2));
  process.exit(0);
}

console.log("═".repeat(78));
console.log(`REPEATED COMMAND CHAINS — last ${days || "all"}d · n=${ns.join(",")} · provider=${provider} · project=${projectQ || "(all)"}`);
console.log("═".repeat(78));
console.log(`Sessions scanned: ${sessions.length}   Distinct chains (≥${minSessions} sessions): ${rows.length}`);
console.log("─".repeat(78));

if (!rows.length) {
  console.log("(none — widen --days, lower --min-sessions, or drop --project/--grep)");
} else {
  const padL = (s, w) => String(s).padStart(w);
  console.log(`${padL("occ", 5)} ${padL("sess", 5)} chain`);
  console.log("─".repeat(78));
  for (const r of rows.slice(0, top)) {
    console.log(`${padL(r.count, 5)} ${padL(r.nSessions, 5)}  ${r.chain}`);
  }
}
console.log("═".repeat(78));
console.log(
  "A chain recurring across MANY sessions (not just repeated inside one) is a\n" +
  "candidate for fusion: one CLI verb / script / hook replacing the manual chain.\n" +
  "Strategy catalog + how to turn a hit into a change: references/tooling-improvement.md\n" +
  "Note: n-gram of A,A,A is excluded here (that's a rerun loop — see repeatedCommands\n" +
  "in analyze-*-session.mjs / incidents.mjs, a different friction signal).",
);
