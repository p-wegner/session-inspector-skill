#!/usr/bin/env node
/**
 * FLEET STATISTICS — the shape of a whole batch of sessions, and how groups of
 * them COMPARE. This is the first-class entry point for "we just ran N sessions
 * (a build-out, a batch of tickets, a day's work) — how did they behave, which
 * ones are outliers, and which GROUP (stack / project / model / day) was faster,
 * cheaper, cleaner?"
 *
 * Deliberately NOT a cost report. In an agentic workflow the raw token total is
 * dominated by cache-read by construction — every turn re-sends the whole prefix,
 * so "cache-read is the biggest sink" is a tautology, not a finding. token-sinks.mjs
 * gives you the billing number. This tool answers the questions that actually vary
 * between sessions and tell you where to look:
 *   - DISTRIBUTIONS: agent turns, wall-clock duration, peak context, tool-fail rate
 *     (mean / median / p90 / max) — the fleet's central tendency and spread.
 *   - OUTLIERS: the sessions that broke the pattern — sudden context growth (the
 *     single biggest one-turn jump), longest-running context, most turns, worst
 *     fail rate, most command re-runs, and the ones cut off by a usage/rate limit.
 *   - COMPARISON (--by stack|project|model|day|folder): a table with each group's
 *     median turns / median duration / median+total cost / fail rate / cut-offs, so
 *     "taskflow finished in half the turns of shopcart" falls straight out.
 *
 * Stack grouping (--by stack) is the robust axis for parallel build-outs: cleaned
 * worktrees lose their git remote, so projectIdentity can't separate them, but the
 * stack is stamped on every command (see lib/stack.mjs).
 *
 * Context/token metrics come from per-turn message.usage (exact billed tokens).
 * Claude transcripts only (Codex/Copilot don't expose per-turn cache usage).
 *
 * Usage:
 *   node scripts/fleet-stats.mjs --project exp --days 30           # fleet distribution + outliers
 *   node scripts/fleet-stats.mjs --project exp --by stack          # compare the stacks in this build-out
 *   node scripts/fleet-stats.mjs --by project --days 7             # compare projects worked this week
 *   node scripts/fleet-stats.mjs --project exp --top 12 --json     # machine-readable
 */

import { readFileSync } from "fs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";
import { parseClaude } from "./lib/parse.mjs";
import { detectStack, stackLabel } from "./lib/stack.mjs";
import { costUsd } from "./lib/quota.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const projectQ = (opt("--project", "") || "").toLowerCase();
const by = (opt("--by", "") || "").toLowerCase();          // stack|project|model|day|folder
const days = parseInt(opt("--days", "0"), 10);
const top = parseInt(opt("--top", "8"), 10);
const asJson = flag("--json");
const windowStartMs = days > 0 ? Date.now() - days * 86400000 - 86400000 : 0;

// ── per-session collection ───────────────────────────────────────────────────

function ctxOf(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

const rows = [];
for (const s of discover("claude")) {
  if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
  let content; try { content = readFileSync(s.path, "utf-8"); } catch { continue; }
  const folder = basename(dirname(s.path));
  const lines = content.split("\n");

  // Rich stats from the shared parser (tools, commands, tokens, limits, meta).
  const st = parseClaude(lines);
  const id = projectIdentity(st.cwd || "");
  if (projectQ && ![folder, st.cwd, id.project, id.projectKey].join(" ").toLowerCase().includes(projectQ)) continue;
  if (!st.assistantTurns) continue;

  // Second light pass: per-turn context curve (for the biggest single-turn jump)
  // and cache-creation total (parseClaude doesn't track creation, needed for cost).
  let prevCtx = 0, jump = 0, jumpAt = 0, turnIdx = 0, cw = 0, maxCtx = 0;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.type === "assistant" && o.message?.usage) {
      const u = o.message.usage;
      const ctx = ctxOf(u);
      if (ctx <= 0) continue;
      turnIdx++;
      cw += u.cache_creation_input_tokens || 0;
      if (ctx > maxCtx) maxCtx = ctx;
      if (prevCtx && ctx - prevCtx > jump) { jump = ctx - prevCtx; jumpAt = turnIdx; }
      prevCtx = ctx;
    }
  }

  const stack = detectStack(st.commands || [], [...(st.filesRead || []), ...(st.filesEdited || []), ...(st.filesWritten || [])]);
  const reruns = (st.repeatedCommands || []).reduce((a, r) => a + (r.count - 1), 0);
  const cost = costUsd(st.model, { i: st.inputTokens, o: st.outputTokens, cw, cr: st.cacheReadTokens });
  const failRate = st.toolCalls ? st.failedToolCalls / st.toolCalls : 0;

  rows.push({
    id: (st.sessionId || s.sessionId).slice(0, 8),
    folder, project: id.project || folder, stack: stack.id, model: st.model || "?",
    turns: st.assistantTurns, durSec: st.durationSec || 0,
    toolCalls: st.toolCalls, fails: st.failedToolCalls, failRate,
    reruns, out: st.outputTokens, cr: st.cacheReadTokens, cw, cost,
    maxCtx, jump, jumpAt, compactions: st.compactions,
    endedOnLimit: st.endedOnLimit || "", stopReason: st.stopReason || "",
    goal: (st.aiTitle || st.firstPrompt || "").replace(/\s+/g, " ").slice(0, 60),
    startTime: st.startTime || "",
  });
}

// ── stats helpers ────────────────────────────────────────────────────────────

const sortNum = (a) => [...a].sort((x, y) => x - y);
const median = (a) => { if (!a.length) return 0; const s = sortNum(a); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const pct = (a, p) => { if (!a.length) return 0; const s = sortNum(a); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const maxOf = (a) => a.length ? Math.max(...a) : 0;
const k = (n) => (Math.abs(n) >= 1000 ? (n / 1000).toFixed(0) + "k" : String(Math.round(n)));
const money = (n) => "$" + n.toFixed(2);
const mins = (sec) => (sec / 60).toFixed(0) + "m";

function dist(label, arr, fmt = (x) => x.toFixed(1)) {
  return `  ${label.padEnd(16)} mean ${fmt(mean(arr)).padStart(7)}   median ${fmt(median(arr)).padStart(7)}   p90 ${fmt(pct(arr, .9)).padStart(7)}   max ${fmt(maxOf(arr)).padStart(7)}`;
}

// ── grouping (comparison mode) ────────────────────────────────────────────────

function groupKey(r) {
  if (by === "stack") return r.stack;
  if (by === "project") return r.project;
  if (by === "model") return r.model;
  if (by === "folder") return r.folder;
  if (by === "day") return (r.startTime || "").slice(0, 10) || "?";
  return null;
}

function buildGroups() {
  const g = new Map();
  for (const r of rows) {
    const key = groupKey(r);
    if (!g.has(key)) g.set(key, []);
    g.get(key).push(r);
  }
  const out = [];
  for (const [key, rs] of g) {
    const calls = rs.reduce((a, r) => a + r.toolCalls, 0);
    const fails = rs.reduce((a, r) => a + r.fails, 0);
    out.push({
      key, sessions: rs.length,
      medTurns: median(rs.map((r) => r.turns)),
      medDurSec: median(rs.map((r) => r.durSec)),
      medCost: median(rs.map((r) => r.cost)),
      totalCost: rs.reduce((a, r) => a + r.cost, 0),
      totalOut: rs.reduce((a, r) => a + r.out, 0),
      failRate: calls ? fails / calls : 0,
      reruns: rs.reduce((a, r) => a + r.reruns, 0),
      cutoffs: rs.filter((r) => r.endedOnLimit).length,
      medMaxCtx: median(rs.map((r) => r.maxCtx)),
    });
  }
  return out.sort((a, b) => b.totalCost - a.totalCost);
}

// ── output ─────────────────────────────────────────────────────────────────────

if (asJson) {
  const payload = { scope: { project: projectQ || null, days: days || null, by: by || null }, sessions: rows.length };
  if (by) payload.groups = buildGroups();
  payload.distribution = {
    turns: { mean: mean(rows.map(r => r.turns)), median: median(rows.map(r => r.turns)), p90: pct(rows.map(r => r.turns), .9), max: maxOf(rows.map(r => r.turns)) },
    durationSec: { mean: mean(rows.map(r => r.durSec)), median: median(rows.map(r => r.durSec)), p90: pct(rows.map(r => r.durSec), .9), max: maxOf(rows.map(r => r.durSec)) },
    maxCtx: { mean: mean(rows.map(r => r.maxCtx)), median: median(rows.map(r => r.maxCtx)), p90: pct(rows.map(r => r.maxCtx), .9), max: maxOf(rows.map(r => r.maxCtx)) },
    failRatePct: { mean: 100 * mean(rows.map(r => r.failRate)), median: 100 * median(rows.map(r => r.failRate)), p90: 100 * pct(rows.map(r => r.failRate), .9), max: 100 * maxOf(rows.map(r => r.failRate)) },
  };
  payload.outliers = {
    suddenGrowth: [...rows].sort((a, b) => b.jump - a.jump).slice(0, top),
    longestContext: [...rows].sort((a, b) => b.maxCtx - a.maxCtx).slice(0, top),
    mostTurns: [...rows].sort((a, b) => b.turns - a.turns).slice(0, top),
    worstFailRate: rows.filter(r => r.toolCalls >= 10).sort((a, b) => b.failRate - a.failRate).slice(0, top),
    mostReruns: [...rows].sort((a, b) => b.reruns - a.reruns).slice(0, top),
    cutOff: rows.filter(r => r.endedOnLimit),
  };
  console.log(JSON.stringify(payload, null, 2));
} else if (!rows.length) {
  console.log(`No Claude sessions matched${projectQ ? ` project~${projectQ}` : ""}${days ? ` in the last ${days}d` : ""}.`);
} else {
  const scope = [projectQ && `project~${projectQ}`, days && `${days}d`].filter(Boolean).join("  ");
  console.log("═".repeat(80));
  console.log(`FLEET STATISTICS — ${rows.length} Claude sessions${scope ? "  ·  " + scope : ""}`);
  console.log("═".repeat(80));

  // ---- comparison table (when --by given) ----
  if (by) {
    const groups = buildGroups();
    console.log(`\nCOMPARISON — grouped by ${by}  (sorted by total cost)\n`);
    const kw = Math.max(by.length, ...groups.map((g) => String(g.key).length), 8);
    console.log("  " + "group".padEnd(kw) + "  sess  medTurns  medDur   medCtx   fail%  reruns  cutoff   medCost   totalCost");
    console.log("  " + "─".repeat(kw + 74));
    for (const g of groups) {
      console.log("  " +
        String(g.key).padEnd(kw) + "  " +
        String(g.sessions).padStart(4) + "  " +
        median([g.medTurns]).toFixed(0).padStart(8) + "  " +
        mins(g.medDurSec).padStart(6) + "  " +
        k(g.medMaxCtx).padStart(6) + "  " +
        (100 * g.failRate).toFixed(0).padStart(5) + "%  " +
        String(g.reruns).padStart(5) + "  " +
        String(g.cutoffs).padStart(5) + "  " +
        money(g.medCost).padStart(8) + "  " +
        money(g.totalCost).padStart(9));
    }
    console.log(`\n  Read as: which ${by} finished in fewer turns / less wall-clock, with a lower`);
    console.log(`  fail rate and fewer re-runs, for less cost. Big gaps = a stack/board lever.`);
  }

  // ---- distributions ----
  console.log(`\nDISTRIBUTIONS (per session)`);
  console.log(dist("agent turns", rows.map(r => r.turns), (x) => x.toFixed(0)));
  console.log(dist("duration", rows.map(r => r.durSec), mins));
  console.log(dist("peak context", rows.map(r => r.maxCtx), k));
  console.log(dist("tool-fail %", rows.map(r => 100 * r.failRate), (x) => x.toFixed(0) + "%"));
  console.log(dist("cost", rows.map(r => r.cost), money));

  // ---- outliers ----
  const showList = (title, list, fmt) => {
    if (!list.length) return;
    console.log(`\n${title}`);
    for (const r of list) console.log("  " + fmt(r));
  };
  showList(`SUDDEN CONTEXT GROWTH (biggest single-turn jump — a spike worth explaining)`,
    [...rows].sort((a, b) => b.jump - a.jump).slice(0, top),
    (r) => `+${k(r.jump).padStart(5)} at turn ${String(r.jumpAt).padStart(3)}/${String(r.turns).padEnd(3)}  ${r.id} [${r.stack}]  ${r.goal}`);
  showList(`LONGEST CONTEXT (ran closest to the window — /compact or trim candidates)`,
    [...rows].sort((a, b) => b.maxCtx - a.maxCtx).slice(0, top),
    (r) => `${k(r.maxCtx).padStart(6)}  ${String(r.turns).padStart(3)} turns  ${r.compactions ? r.compactions + " compact" : ""}  ${r.id} [${r.stack}]  ${r.goal}`);
  showList(`MOST TURNS (longest agent loops)`,
    [...rows].sort((a, b) => b.turns - a.turns).slice(0, top),
    (r) => `${String(r.turns).padStart(4)} turns  ${mins(r.durSec).padStart(5)}  ${r.id} [${r.stack}]  ${r.goal}`);
  showList(`WORST TOOL-FAIL RATE (≥10 calls — where the tooling fought the agent)`,
    rows.filter(r => r.toolCalls >= 10).sort((a, b) => b.failRate - a.failRate).slice(0, top),
    (r) => `${(100 * r.failRate).toFixed(0).padStart(3)}%  ${String(r.fails).padStart(3)}/${String(r.toolCalls).padEnd(4)}  ${r.id} [${r.stack}]  ${r.goal}`);
  showList(`MOST COMMAND RE-RUNS (retry-loop signal)`,
    [...rows].sort((a, b) => b.reruns - a.reruns).slice(0, top).filter(r => r.reruns > 0),
    (r) => `${String(r.reruns).padStart(3)}×  ${r.id} [${r.stack}]  ${r.goal}`);
  const cut = rows.filter(r => r.endedOnLimit);
  if (cut.length) showList(`CUT OFF by a usage/rate limit (resumable — see resumable.mjs)`, cut,
    (r) => `${r.endedOnLimit}  ${r.id} [${r.stack}]  ${r.goal}`);

  console.log("\n" + "─".repeat(80));
  console.log("Claude only (per-turn cache usage). Cache-read is the baseline volume in every");
  console.log("agentic session — look at the SHAPE (turns, peak ctx, spikes) and the group deltas,");
  console.log("not the raw token total. Compare groups with --by stack|project|model|day.");
  console.log("Suggestion taxonomy + how to turn these into fixes: references/fleet-inspection.md");
}
