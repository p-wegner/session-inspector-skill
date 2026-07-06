#!/usr/bin/env node
/**
 * How big does the CONTEXT get, and does auto-compact ever rein it in?
 *
 * Agent cost is cache-read dominated: every turn re-bills the ENTIRE current
 * context as cache-read, so a session's spend is roughly the AREA UNDER its
 * context-growth curve — turns × context-size. A session that grows to 700k
 * and never compacts pays for that 700k on every remaining turn. This script
 * makes that curve visible.
 *
 * For each session it reads per-turn `message.usage` and reconstructs the
 * context size at that turn (input + cache_read + cache_creation). It then
 * reports, across the selected scope:
 *   - AUTO-COMPACTS: how many `isCompactSummary` boundaries fired (the safety
 *     valve). Few compacts + huge maxCtx = the valve never tripped — often
 *     because a large context window (e.g. the 1M variant) pushed the compact
 *     threshold up near the window size.
 *   - CONTEXT DISTRIBUTION: a histogram + percentiles of per-turn context size.
 *     The 200k line matters: turns above it run in the long-context premium
 *     pricing tier (~2x on Anthropic).
 *   - LONG-CONTEXT TAX: what share of turns and of cache-read tokens sit above
 *     200k — this is the price-independent signal for "where the money went".
 *   - POINT OF NO RETURN: the turn at which context first crossed 200k and
 *     never came back down (no compaction) — everything after is premium-tier.
 *
 * Companion to token-sinks.mjs (billing total) and waste.mjs (what fills the
 * context). This one explains the SHAPE of the growth that multiplies both.
 *
 * Token counts come straight from usage (exact billed tokens), not estimated.
 * Claude transcripts only (Codex/Copilot don't expose per-turn cache usage).
 *
 * Usage:
 *   node scripts/context-growth.mjs --project papershift      # substring: folder / cwd / git remote
 *   node scripts/context-growth.mjs --session 75895475        # focus ONE session (per-turn curve)
 *   node scripts/context-growth.mjs --days 30
 *   node scripts/context-growth.mjs --threshold 200000        # premium-tier line (default 200k)
 *   node scripts/context-growth.mjs --json
 */

import { readFileSync } from "fs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const projectQ = (opt("--project", "") || "").toLowerCase();
const sessionQ = (opt("--session", "") || "").toLowerCase();
const days = parseInt(opt("--days", "0"), 10);
const THRESH = parseInt(opt("--threshold", "200000"), 10);
const asJson = flag("--json");
const windowStartMs = days > 0 ? Date.now() - days * 86400000 - 86400000 : 0;

const BUCKETS = [0, 20000, 50000, 100000, 150000, 180000, 200000, Infinity];
const BLABEL = ["<20k", "20-50k", "50-100k", "100-150k", "150-180k", "180-200k", ">200k"];

function ctxOf(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

const perSession = [];
const allCtx = [];
const bcount = new Array(BLABEL.length).fill(0);
let totalCompacts = 0, totalTurns = 0, totalCacheRead = 0, cacheReadAbove = 0, turnsAbove = 0;

const sessions = discover("claude");
for (const s of sessions) {
  if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
  let content; try { content = readFileSync(s.path, "utf-8"); } catch { continue; }
  const meta = extractMeta("claude", content);
  const id = projectIdentity(meta.cwd || "");
  const folder = basename(dirname(s.path));
  if (projectQ && ![folder, meta.cwd, id.project, id.projectKey].join(" ").toLowerCase().includes(projectQ)) continue;
  if (sessionQ && !s.sessionId.toLowerCase().includes(sessionQ) && !folder.toLowerCase().includes(sessionQ)) continue;

  let compacts = 0, turns = 0, maxCtx = 0, model = "?", version = "?";
  let crTot = 0, crAbove = 0, nAbove = 0, crossIdx = -1;
  const curve = [];
  for (const ln of content.split("\n")) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.version) version = o.version;
    if (o.isCompactSummary) { compacts++; totalCompacts++; }
    if (o.type === "assistant" && o.message) {
      if (o.message.model) model = o.message.model;
      const u = o.message.usage; if (!u) continue;
      const ctx = ctxOf(u), cr = u.cache_read_input_tokens || 0;
      if (ctx <= 0) continue;
      turns++; totalTurns++; maxCtx = Math.max(maxCtx, ctx);
      crTot += cr; totalCacheRead += cr;
      allCtx.push(ctx); curve.push(ctx);
      for (let i = 0; i < BUCKETS.length - 1; i++) if (ctx >= BUCKETS[i] && ctx < BUCKETS[i + 1]) { bcount[i]++; break; }
      if (ctx > THRESH) { nAbove++; turnsAbove++; crAbove += cr; cacheReadAbove += cr; if (crossIdx < 0) crossIdx = turns; }
    }
  }
  if (!turns) continue;
  perSession.push({
    id: s.sessionId.slice(0, 8), project: id.project || folder, model, version,
    turns, compacts, maxCtx, crTot, crAbove, nAbove, crossIdx,
    curve: sessionQ ? curve : undefined,
  });
}

const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };

if (asJson) {
  console.log(JSON.stringify({
    scope: { project: projectQ || null, session: sessionQ || null, days: days || null, threshold: THRESH },
    totals: { turns: totalTurns, compacts: totalCompacts, cacheRead: totalCacheRead, cacheReadAbove, turnsAbove,
      pctTurnsAbove: totalTurns ? +(100 * turnsAbove / totalTurns).toFixed(1) : 0,
      pctCacheReadAbove: totalCacheRead ? +(100 * cacheReadAbove / totalCacheRead).toFixed(1) : 0 },
    percentiles: { p50: pct(allCtx, .5), p75: pct(allCtx, .75), p90: pct(allCtx, .9), p99: pct(allCtx, .99), max: allCtx.length ? Math.max(...allCtx) : 0 },
    histogram: BLABEL.map((l, i) => ({ bucket: l, turns: bcount[i] })),
    sessions: perSession.sort((a, b) => b.maxCtx - a.maxCtx),
  }, null, 2));
} else {
  const k = (n) => (n / 1000).toFixed(0) + "k";
  console.log("=== SCOPE ===");
  console.log(`sessions=${perSession.length}  turns=${totalTurns}  threshold=${k(THRESH)}` +
    (projectQ ? `  project~${projectQ}` : "") + (sessionQ ? `  session~${sessionQ}` : "") + (days ? `  days=${days}` : ""));

  console.log("\n=== AUTO-COMPACTS (the safety valve) ===");
  console.log(`total compact boundaries: ${totalCompacts} across ${perSession.length} sessions`);
  const compacted = perSession.filter(s => s.compacts > 0 || s.maxCtx > THRESH)
    .sort((a, b) => b.maxCtx - a.maxCtx).slice(0, 15);
  console.log("session   compacts  turns  maxCtx   model");
  for (const s of compacted)
    console.log(`  ${s.id}  ${String(s.compacts).padStart(4)}   ${String(s.turns).padStart(5)}  ${k(s.maxCtx).padStart(6)}   ${s.model}`);

  console.log(`\n=== CONTEXT DISTRIBUTION (per turn) ===`);
  console.log(`percentiles:  p50=${k(pct(allCtx, .5))}  p75=${k(pct(allCtx, .75))}  p90=${k(pct(allCtx, .9))}  p99=${k(pct(allCtx, .99))}  max=${allCtx.length ? k(Math.max(...allCtx)) : 0}`);
  const maxb = Math.max(1, ...bcount);
  BLABEL.forEach((lb, i) => console.log("  " + lb.padEnd(9) + String(bcount[i]).padStart(6) + "  " + "█".repeat(Math.round(40 * bcount[i] / maxb))));

  console.log(`\n=== LONG-CONTEXT TAX (turns above ${k(THRESH)} = premium pricing tier) ===`);
  console.log(`turns above:      ${turnsAbove}/${totalTurns} (${totalTurns ? (100 * turnsAbove / totalTurns).toFixed(0) : 0}%)`);
  console.log(`cache-read above: ${(cacheReadAbove / 1e6).toFixed(0)}M/${(totalCacheRead / 1e6).toFixed(0)}M (${totalCacheRead ? (100 * cacheReadAbove / totalCacheRead).toFixed(0) : 0}%)  <- price-independent 'where money went' signal`);

  const por = perSession.filter(s => s.crossIdx > 0).sort((a, b) => b.maxCtx - a.maxCtx).slice(0, 10);
  if (por.length) {
    console.log(`\n=== POINT OF NO RETURN (turn context first crossed ${k(THRESH)}) ===`);
    for (const s of por)
      console.log(`  ${s.id}  crossed at turn ${s.crossIdx}/${s.turns}  ->  ${s.turns - s.crossIdx + 1} turns in premium tier  (maxCtx ${k(s.maxCtx)})`);
  }

  if (sessionQ && perSession.length === 1 && perSession[0].curve) {
    const c = perSession[0].curve;
    console.log(`\n=== CONTEXT CURVE (${perSession[0].id}, ${c.length} turns, sampled) ===`);
    const step = Math.max(1, Math.floor(c.length / 30));
    for (let i = 0; i < c.length; i += step)
      console.log(`  t${String(i).padStart(4)}  ${k(c[i]).padStart(6)}  ${"▓".repeat(Math.round(40 * c[i] / Math.max(...c)))}`);
  }
}
