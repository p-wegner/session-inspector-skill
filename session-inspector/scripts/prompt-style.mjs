#!/usr/bin/env node
/**
 * Profile your PROMPTING STYLE across MANY sessions — "how do I talk to the
 * agent in this project?" Aggregates every real human-typed prompt (via the
 * shared classify() filter) into length distribution, tone/format signals,
 * opening-word frequencies, and representative samples. The fleet-level
 * companion to user-prompts.mjs (which LISTS prompts by day); this one
 * CHARACTERIZES them.
 *
 * Scope it to one project, provider, or time window — or run bare for an
 * all-time, all-provider profile.
 *
 * Usage:
 *   node scripts/prompt-style.mjs                       # all projects, all providers, all time
 *   node scripts/prompt-style.mjs --project slidesmith  # substring-match project dir / cwd / git-remote
 *   node scripts/prompt-style.mjs --provider claude     # claude | codex | copilot | all
 *   node scripts/prompt-style.mjs --days 30             # rolling window (by entry timestamp)
 *   node scripts/prompt-style.mjs --samples 30          # how many sample prompts to print (default 20)
 *   node scripts/prompt-style.mjs --full                # don't truncate sample prompts
 *   node scripts/prompt-style.mjs --all                 # include automated/noise prompts (tagged), not just human
 *   node scripts/prompt-style.mjs --json                # machine-readable profile
 *
 * Notes
 *   - "human" prompts only by default; automated launch/handoff/board traffic
 *     and bare UI slash-commands are excluded (pass --all to fold them in).
 *   - --project matches case-insensitively against the Claude projects-dir
 *     folder name, the session cwd, and the normalized git remote — so
 *     "slidesmith", "agentic-kanban", or "p-wegner/acp" all work.
 *   - Reasoning/length stats use raw char + whitespace-word counts; the median
 *     is the honest "typical" prompt (the mean is skewed by the occasional
 *     long vision dump).
 */

import { readFileSync, statSync } from "fs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";
import { extractPrompts } from "./lib/prompts.mjs";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const provider = opt("--provider", "all");
const projectQ = (opt("--project", "") || "").toLowerCase();
const days = parseInt(opt("--days", "0"), 10);
const sampleN = parseInt(opt("--samples", "20"), 10);
const full = flag("--full");
const showAll = flag("--all");
const asJson = flag("--json");

const windowStartMs = days > 0 ? Date.now() - days * 86400000 - 86400000 : 0;
const windowStartTs = days > 0 ? Date.now() - days * 86400000 : 0;

// ── collect prompts across sessions ──────────────────────────────────────────
const sessions = discover(provider === "all" ? "all" : provider);
const prompts = [];           // { text, kind, ts, project }
const sessionIds = new Set();
const projectCounts = new Map();

for (const s of sessions) {
  if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
  let content;
  try { content = readFileSync(s.path, "utf-8"); } catch { continue; }

  const meta = extractMeta(s.provider, content);
  const id = projectIdentity(meta.cwd || "");
  // Claude: the projects-dir folder name is a reliable project alias even w/o cwd
  const folder = s.provider === "claude" ? basename(dirname(s.path)) : "";
  const haystack = [folder, meta.cwd, id.project, id.projectKey].join(" ").toLowerCase();
  if (projectQ && !haystack.includes(projectQ)) continue;
  const projectLabel = id.project !== "unknown" ? id.project : (folder || meta.cwd || "(unknown)");

  const found = extractPrompts(s.provider, content);
  let kept = 0;
  for (const p of found) {
    if (!showAll && p.kind !== "human") continue;
    if (windowStartTs && p.ts) { const t = Date.parse(p.ts); if (t && t < windowStartTs) continue; }
    prompts.push({ ...p, project: projectLabel, provider: s.provider });
    kept++;
  }
  if (kept) {
    sessionIds.add(s.path);
    projectCounts.set(projectLabel, (projectCounts.get(projectLabel) || 0) + kept);
  }
}

// ── compute profile ──────────────────────────────────────────────────────────
function pctl(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0; }
const n = prompts.length;

const APPROVALS = /^(y|ya|yes|yep|yup|yes pls|yes please|sure|ok|okay|k|jo|do it|you do it|go|go ahead|go on|continue|proceed|ship it|lgtm|perfect|nice|great|thanks|thx|np|good)\b/i;
const GERMAN = /\b(der|die|das|und|ist|nicht|mach|machen|bitte|soll|sollen|kann|können|wir|ich|du|noch|auch|wie|den|dem|ein|eine|für|mit|auf|aber|schon|jetzt|mal|gibt|sind|nochmal|wieder|gerne|kein|keine|über|unsere|unser)\b/i;
const PROFANITY = /\b(fuck|fucking|shit|damn|wtf|crap|hell)\b/i;
const POLITE = /\b(please|pls|bitte|thanks|thank you|thx|danke|could you|would you|can you|kannst du)\b/i;

const lens = [], words = [], openers = new Map();
let lower = 0, question = 0, exclaim = 0, umlaut = 0, german = 0, profanity = 0, polite = 0,
    terse = 0, approval = 0, multiline = 0, codeblocky = 0, hasPath = 0;
const buckets = { "1-5w": 0, "6-15w": 0, "16-40w": 0, "41-100w": 0, "100w+": 0 };

for (const p of prompts) {
  const t = p.text;
  lens.push(t.length);
  const w = t.trim().split(/\s+/).filter(Boolean);
  words.push(w.length);
  if (w.length <= 5) buckets["1-5w"]++; else if (w.length <= 15) buckets["6-15w"]++;
  else if (w.length <= 40) buckets["16-40w"]++; else if (w.length <= 100) buckets["41-100w"]++;
  else buckets["100w+"]++;

  if (/^[a-zäöü]/.test(t)) lower++;
  if (t.includes("?")) question++;
  if (t.includes("!")) exclaim++;
  if (/[äöüßÄÖÜ]/.test(t)) umlaut++;
  if (GERMAN.test(t)) german++;
  if (PROFANITY.test(t)) profanity++;
  if (POLITE.test(t)) polite++;
  if (w.length <= 4) terse++;
  if (APPROVALS.test(t.trim())) approval++;
  if (t.includes("\n")) multiline++;
  if (t.includes("```") || /\b(function|const|=>|import )\b/.test(t)) codeblocky++;
  if (/[A-Za-z]:\\|\/[a-z]+\/|\.\w{2,4}\b/.test(t)) hasPath++;

  const first = (w[0] || "").toLowerCase().replace(/[^a-zäöü/!]/g, "");
  if (first) openers.set(first, (openers.get(first) || 0) + 1);
}

lens.sort((a, b) => a - b); const wsort = words.slice().sort((a, b) => a - b);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const topOpeners = [...openers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
const topProjects = [...projectCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

const profile = {
  scope: { provider, project: projectQ || "(all)", days: days || "all", kinds: showAll ? "all" : "human" },
  totals: { prompts: n, sessions: sessionIds.size, promptsPerSession: sessionIds.size ? +(n / sessionIds.size).toFixed(1) : 0 },
  length: {
    chars: { mean: n ? Math.round(sum(lens) / n) : 0, median: pctl(lens, .5), p25: pctl(lens, .25), p75: pctl(lens, .75), p90: pctl(lens, .9), max: lens[lens.length - 1] || 0 },
    words: { mean: n ? Math.round(sum(words) / n) : 0, median: wsort[Math.floor(wsort.length / 2)] || 0 },
    buckets,
  },
  signals: {},
  topOpeners,
  topProjects,
};
const sig = (c) => ({ count: c, pct: n ? Math.round((100 * c) / n) : 0 });
profile.signals = {
  lowercase_start: sig(lower), question: sig(question), exclaim: sig(exclaim),
  terse_le4w: sig(terse), approval_only: sig(approval), multiline: sig(multiline),
  has_code: sig(codeblocky), has_path: sig(hasPath),
  polite: sig(polite), german: sig(german), umlaut: sig(umlaut), profanity: sig(profanity),
};

// samples: shortest few + an even spread across length
const byLen = prompts.slice().sort((a, b) => a.text.length - b.text.length);
const shortest = byLen.slice(0, Math.min(sampleN, Math.ceil(sampleN / 2)));
const spread = [];
if (n) { const step = Math.max(1, Math.floor(n / sampleN)); for (let i = 0; i < n && spread.length < sampleN; i += step) spread.push(prompts[i]); }
profile.samples = { shortest: shortest.map((p) => p.text), spread: spread.map((p) => p.text) };

// ── output ───────────────────────────────────────────────────────────────────
if (asJson) { console.log(JSON.stringify(profile, null, 2)); process.exit(0); }

const clip = (t, m = 180) => { const o = t.replace(/\s+/g, " ").trim(); return full ? t.trim() : o.length > m ? o.slice(0, m - 1) + "…" : o; };
const pad = (s, w) => String(s).padEnd(w);
const sc = profile.scope;
console.log(`\nPrompting-style profile — project:${sc.project}  provider:${sc.provider}  window:${sc.days}  kinds:${sc.kinds}`);
if (!n) { console.log("\nNo matching prompts found.\n"); process.exit(0); }
console.log(`\n${n} prompts · ${profile.totals.sessions} sessions · ${profile.totals.promptsPerSession} prompts/session`);

const L = profile.length;
console.log(`\nLENGTH  chars: median ${L.chars.median}  (p25 ${L.chars.p25} · p75 ${L.chars.p75} · p90 ${L.chars.p90} · max ${L.chars.max} · mean ${L.chars.mean})`);
console.log(`        words: median ${L.words.median}  mean ${L.words.mean}`);
console.log(`        ${Object.entries(L.buckets).map(([k, v]) => `${k}:${v}(${Math.round(100 * v / n)}%)`).join("  ")}`);

console.log(`\nSIGNALS`);
for (const [k, v] of Object.entries(profile.signals)) console.log(`  ${pad(k, 16)} ${pad(v.pct + "%", 5)} (${v.count})`);

console.log(`\nTOP OPENING WORDS`);
console.log("  " + topOpeners.map(([w, c]) => `${w}·${c}`).join("   "));

if (!projectQ && topProjects.length > 1) {
  console.log(`\nBUSIEST PROJECTS`);
  for (const [p, c] of topProjects) console.log(`  ${pad(c, 5)} ${p}`);
}

console.log(`\nSHORTEST PROMPTS`);
for (const t of profile.samples.shortest) console.log(`  • ${clip(t)}`);
console.log(`\nSPREAD (every ~${Math.max(1, Math.floor(n / sampleN))}th by chronology)`);
for (const t of profile.samples.spread) console.log(`  • ${clip(t)}`);
console.log("");
