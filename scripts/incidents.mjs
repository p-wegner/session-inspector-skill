#!/usr/bin/env node
/**
 * Rank sessions by FRICTION — "which sessions are worth investigating / learning
 * from?" Surfaces the incidents (struggles, retry loops, rework) hiding in a
 * fleet, so you deep-dive the few that teach something instead of reading them
 * all. The discovery companion to the single-session analyzers: this picks the
 * targets, analyze-*-session.mjs --events explains them.
 *
 * Per session it scores:
 *   - corrections  human prompts matching a DEFECT lexicon (rework signal)
 *   - frustration  short negative/stall prompts ("still broken", "stuck again")
 *   - failed tools tool_result errors (+ rate)
 *   - reruns       wasted re-runs of identical commands (struggle signal)
 *   - regen churn  same generation re-run on the same target N× (--lens image)
 *   - cost-ish     duration + output tokens (effort, lightly weighted)
 * into one composite (tunable). Repeated near-identical corrections ("stuck
 * again" ×7) are the strongest "this session hit a wall" signal and dominate.
 *
 * Usage:
 *   node scripts/incidents.mjs                      # all projects/providers, all time
 *   node scripts/incidents.mjs --project slidesmith # substring: folder / cwd / git remote
 *   node scripts/incidents.mjs --provider claude    # claude | codex | copilot | all
 *   node scripts/incidents.mjs --days 30            # mtime-prefilter to a window
 *   node scripts/incidents.mjs --lens visual        # defect lexicon: general(default)|visual|image
 *   node scripts/incidents.mjs --grep "<substr>"    # extra: only sessions whose text/cmds match
 *   node scripts/incidents.mjs --top 20             # how many to print (default 16)
 *   node scripts/incidents.mjs --json
 *
 * Then deep-dive a hit:
 *   node scripts/analyze-claude-session.mjs <path> --events --grep "<defect-word>" -v
 */

import { readFileSync } from "fs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";
import { summarize } from "./lib/parse.mjs";
import { extractPrompts } from "./lib/prompts.mjs";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const provider = opt("--provider", "all");
const projectQ = (opt("--project", "") || "").toLowerCase();
const grepQ = (opt("--grep", "") || "").toLowerCase();
const days = parseInt(opt("--days", "0"), 10);
const top = parseInt(opt("--top", "16"), 10);
const lens = opt("--lens", "general");
const asJson = flag("--json");
const windowStartMs = days > 0 ? Date.now() - days * 86400000 - 86400000 : 0;

// ── defect lexicons (the "rework happened" vocabulary) ───────────────────────
const LEX = {
  general: /\b(still|again|nope|wrong|broken|doesn'?t|does not|isn'?t|not working|revert|undo|fix|missing|redo|regenerate|stuck|fails?|failing|error|crash|hang|why (isn'?t|does|won'?t)|that'?s not|not what)\b/i,
  visual: /\b(overlap(ping)?|cropped|clipped|cut off|rectangle|footer|chrome|misaligned|off-?brand|too (big|small|dark|light)|blank|empty|garbled|distorted|grey|gray|render|squished|stretched|aspect|letterbox)\b/i,
  image: /\b(crop|aspect|ratio|portrait|landscape|regenerate|re-?gen|stuck|download|garbl|distort|echo|clone|duplicat|minimal|umlaut|refus|blank|too (plain|minimal)|wrong image|same image)\b/i,
};
const CORRECTION = LEX[lens] || LEX.general;
const FRUSTRATION = /\b(stuck again|still (broken|stuck|wrong|the same)|again|nope|ugh|argh|come on|seriously|wtf|that'?s wrong)\b/i;
const GEN_CMD = /\b(gen|batch|reslide|split-grid|brand-grab)\.(c?js|mjs)\b|chatgpt:image|image:generate|\/api\/generate|gpt-image/i;

// ── collect ──────────────────────────────────────────────────────────────────
const sessions = discover(provider === "all" ? "all" : provider);
const rows = [];

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

  const cmds = (sum.commandsRun || []);
  const text = [...(sum.userMessages || []), ...(sum.assistantMessages || [])].join("\n");
  if (grepQ && !(`${haystack} ${cmds.join("\n")} ${text}`.toLowerCase().includes(grepQ))) continue;

  const prompts = extractPrompts(s.provider, content).filter((p) => p.kind === "human");
  let corrections = 0, frustration = 0;
  const sampleCorr = [];
  for (const p of prompts) {
    if (CORRECTION.test(p.text)) { corrections++; if (sampleCorr.length < 3) sampleCorr.push(p.text.replace(/\s+/g, " ").slice(0, 70)); }
    if (FRUSTRATION.test(p.text)) frustration++;
  }

  const reruns = (sum.repeatedCommands || []).reduce((a, r) => a + (r.count - 1), 0);
  const regen = (sum.repeatedCommands || []).filter((r) => GEN_CMD.test(r.command)).reduce((a, r) => a + (r.count - 1), 0);
  const failed = sum.failedToolCalls || 0;
  const tools = sum.toolCalls || 0;
  const durMin = Math.round((sum.durationSec || 0) / 60);
  const outK = Math.round((sum.outputTokens || 0) / 1000);

  const score =
    corrections * 6 + frustration * 4 + failed * 1.2 +
    reruns * 1.0 + regen * 2.0 +
    Math.min(durMin, 240) * 0.08 + Math.min(outK, 800) * 0.03;

  if (score < 1) continue;
  rows.push({
    score: +score.toFixed(1), provider: s.provider,
    project: id.project !== "unknown" ? id.project : (folder || meta.cwd || "?"),
    sid: (sum.sessionId || basename(s.path).replace(/\.jsonl$/, "")),
    date: (sum.startTime || "").slice(0, 10),
    prompts: prompts.length, corrections, frustration, failed, tools,
    failRate: tools ? Math.round((100 * failed) / tools) : 0,
    reruns, regen, durMin, outK,
    topLoop: (sum.repeatedCommands || [])[0] ? `${sum.repeatedCommands[0].count}× ${sum.repeatedCommands[0].command.slice(0, 46)}` : "",
    sampleCorr, first: (sum.firstUser || "").replace(/\s+/g, " ").slice(0, 88),
    path: s.path,
  });
}

rows.sort((a, b) => b.score - a.score);
const out = rows.slice(0, top);

if (asJson) { console.log(JSON.stringify({ scope: { provider, project: projectQ || "(all)", days: days || "all", lens }, count: rows.length, sessions: out }, null, 2)); process.exit(0); }

const pad = (s, w) => String(s).padEnd(w);
console.log(`\nIncident ranking — project:${projectQ || "(all)"}  provider:${provider}  lens:${lens}  window:${days || "all"}`);
console.log(`${rows.length} sessions with friction. Top ${out.length}:\n`);
if (!out.length) { console.log("(none)\n"); process.exit(0); }
for (const r of out) {
  console.log(`■ ${pad(r.score, 6)} [${r.provider}] ${r.date}  ${r.project}`);
  const why = [];
  if (r.corrections) why.push(`corrections ${r.corrections}`);
  if (r.frustration) why.push(`frustration ${r.frustration}`);
  if (r.failed) why.push(`failTools ${r.failed}/${r.tools} (${r.failRate}%)`);
  if (r.regen) why.push(`regen-churn ${r.regen}`);
  if (r.reruns) why.push(`reruns ${r.reruns}`);
  why.push(`${r.durMin}min`, `${r.outK}K out`);
  console.log(`   ${why.join("  ·  ")}`);
  if (r.topLoop) console.log(`   loop: ${r.topLoop}`);
  for (const c of r.sampleCorr) console.log(`   ↳ "${c}"`);
  console.log(`   topic: "${r.first}"`);
  console.log(`   ${r.sid}`);
  console.log("");
}
console.log(`Deep-dive a hit:  node scripts/analyze-${out[0].provider}-session.mjs "${out[0].path}" --events --grep "<word>" -v\n`);
