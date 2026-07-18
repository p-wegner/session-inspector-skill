#!/usr/bin/env node
/**
 * COLD-CACHE tax — the money burned when a session's prompt cache goes cold.
 *
 * Agent cost is cache-read dominated: while the cache is WARM, every turn
 * re-bills the whole context as cache_read at 0.1x base input. But the cache is
 * ephemeral — Claude Code uses a 1-hour TTL here (the transcript proves it:
 * usage.cache_creation.ephemeral_1h_input_tokens). If a session sits idle longer
 * than the TTL and is then continued (or a long session is `--resume`d after a
 * break), the NEXT turn finds the cache expired and must RE-WRITE the entire
 * prefix as cache_creation — billed at 2x base input for a 1h write. That single
 * cold turn can cost 20x what a warm turn would: e.g. a 400k-token Opus context
 * refilled cold ≈ 400k × $5/M × 2 = $4.00, versus ≈ $0.20 warm.
 *
 * This script finds those cold turns. For each assistant turn it measures the
 * GAP since the previous turn; when the gap exceeds the TTL and the turn shows a
 * large cache_creation, it records a COLD event and quantifies the AVOIDABLE
 * premium — what the re-write cost minus what a warm cache_read would have cost:
 *     premium ≈ creation_1h × in × (2.0 − 0.1)  +  creation_5m × in × (1.25 − 0.1)
 * The first turn of a session (initial cache build) is never a cold event — it
 * had nothing to keep warm.
 *
 * Companion to context-growth.mjs (the SHAPE that makes each refill expensive)
 * and token-sinks.mjs (the billing total). This one isolates the avoidable slice
 * created purely by idle time / resumes, and tells you which sessions to keep
 * warm, compact, or split.
 *
 * Token counts + gaps come straight from usage/timestamps (exact billed tokens).
 * Claude transcripts only (Codex/Copilot don't expose per-turn cache usage).
 *
 * Usage:
 *   node scripts/cold-cache.mjs --project papershift    # substring: folder / cwd / git remote
 *   node scripts/cold-cache.mjs --cwd                   # only sessions whose cwd is the current dir
 *   node scripts/cold-cache.mjs --days 14               # window (default 14)
 *   node scripts/cold-cache.mjs --gap 60                # idle minutes that count as cold (default 60 = 1h TTL)
 *   node scripts/cold-cache.mjs --session 75895475      # focus ONE session (per-event detail)
 *   node scripts/cold-cache.mjs --min-premium 0.25      # hide events cheaper than $ (default 0.05)
 *   node scripts/cold-cache.mjs --top 20                # rows per table (default 15)
 *   node scripts/cold-cache.mjs --json
 */

import { readFileSync } from "fs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";
import { priceFor, modelLabel } from "./lib/quota.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const projectQ = (opt("--project", "") || "").toLowerCase();
const cwdOnly = flag("--cwd");
const sessionQ = (opt("--session", "") || "").toLowerCase();
const days = parseInt(opt("--days", "14"), 10);
const gapMin = parseFloat(opt("--gap", "60"));
const minPremium = parseFloat(opt("--min-premium", "0.05"));
const top = parseInt(opt("--top", "15"), 10);
const asJson = flag("--json");
const HERE = process.cwd().replace(/\\/g, "/").toLowerCase();
const windowStartMs = days > 0 ? Date.now() - days * 86400000 : 0;
const gapMs = gapMin * 60000;

// 1h cache WRITE = 2x base input; 5m WRITE = 1.25x; cache READ = 0.1x.
const WRITE_1H = 2.0, WRITE_5M = 1.25, READ = 0.1;
const ctxOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

const events = [];           // one per cold turn
const perSession = new Map();
let sessionsScanned = 0, turnsScanned = 0, coldTurns = 0;
let totalPremium = 0, totalColdWrite = 0;

const all = discover("claude");
for (const s of all) {
  if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
  let content; try { content = readFileSync(s.path, "utf-8"); } catch { continue; }
  const meta = extractMeta("claude", content);
  const id = projectIdentity(meta.cwd || "");
  const folder = basename(dirname(s.path));
  const cwdNorm = (meta.cwd || "").replace(/\\/g, "/").toLowerCase();
  if (cwdOnly && cwdNorm !== HERE) continue;
  if (projectQ && ![folder, meta.cwd, id.project, id.projectKey].join(" ").toLowerCase().includes(projectQ)) continue;
  if (sessionQ && !s.sessionId.toLowerCase().includes(sessionQ) && !folder.toLowerCase().includes(sessionQ)) continue;

  let prevMs = 0, turn = 0, model = "?";
  const sid = s.sessionId.slice(0, 8);
  let scanned = false;
  for (const ln of content.split("\n")) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.type !== "assistant" || !o.message?.usage) continue;
    const u = o.message.usage;
    const ms = o.timestamp ? new Date(o.timestamp).getTime() : NaN;
    if (!Number.isFinite(ms)) continue;
    if (windowStartMs && ms < windowStartMs) { prevMs = ms; turn++; continue; }
    if (o.message.model) model = o.message.model;
    scanned = true;
    turn++; turnsScanned++;
    const ctx = ctxOf(u);
    const create = u.cache_creation_input_tokens || 0;
    const c1h = u.cache_creation?.ephemeral_1h_input_tokens ?? create;
    const c5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const gap = prevMs ? ms - prevMs : 0;
    // COLD event: not the first turn, idle longer than TTL, and a real re-write.
    if (prevMs && gap >= gapMs && create >= 5000) {
      const inP = priceFor(model).in;
      const coldWriteCost = (c1h * inP * WRITE_1H + c5m * inP * WRITE_5M) / 1e6;
      const warmReadCost = (create * inP * READ) / 1e6;
      const premium = coldWriteCost - warmReadCost;
      coldTurns++; totalPremium += premium; totalColdWrite += coldWriteCost;
      events.push({ sid, project: id.project || folder, model: modelLabel(model), turn,
        gapMin: +(gap / 60000).toFixed(1), ctx, create, c1h, c5m,
        coldWriteCost, premium, ts: o.timestamp });
      const g = perSession.get(sid) || { sid, project: id.project || folder, model: modelLabel(model), events: 0, premium: 0, coldWrite: 0, maxGapMin: 0, maxCtx: 0 };
      g.events++; g.premium += premium; g.coldWrite += coldWriteCost;
      g.maxGapMin = Math.max(g.maxGapMin, gap / 60000); g.maxCtx = Math.max(g.maxCtx, ctx);
      perSession.set(sid, g);
    }
    prevMs = ms;
  }
  if (scanned) sessionsScanned++;
}

events.sort((a, b) => b.premium - a.premium);
const shown = events.filter((e) => e.premium >= minPremium);
const sessionRows = [...perSession.values()].sort((a, b) => b.premium - a.premium);

const usd = (n) => "$" + n.toFixed(2);
const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n));
const dur = (m) => m >= 1440 ? (m / 1440).toFixed(1) + "d" : m >= 60 ? (m / 60).toFixed(1) + "h" : Math.round(m) + "m";

if (asJson) {
  console.log(JSON.stringify({
    scope: { project: projectQ || (cwdOnly ? HERE : "(all)"), days: days || "all", gapMin, minPremium },
    totals: { sessionsScanned, turnsScanned, coldTurns, coldSessions: sessionRows.length,
      avoidablePremiumUsd: +totalPremium.toFixed(2), coldWriteCostUsd: +totalColdWrite.toFixed(2) },
    sessions: sessionRows.map((s) => ({ ...s, premium: +s.premium.toFixed(2), coldWrite: +s.coldWrite.toFixed(2), maxGapMin: +s.maxGapMin.toFixed(0) })),
    events: (sessionQ ? events : shown).slice(0, sessionQ ? 1e9 : 200),
  }, null, 2));
  process.exit(0);
}

console.log(`\nCold-cache tax — project:${projectQ || (cwdOnly ? "(cwd)" : "(all)")}  window:${days || "all"}d  ttl:${gapMin}m  (Claude)`);
if (!sessionsScanned) { console.log("No matching Claude sessions in window.\n"); process.exit(0); }
console.log(`${sessionsScanned} sessions · ${turnsScanned} turns scanned · ${coldTurns} cold-refill turns across ${sessionRows.length} sessions`);
console.log(`AVOIDABLE cold-cache premium ≈ ${usd(totalPremium)}  (of ${usd(totalColdWrite)} spent re-writing cold prefixes)\n`);

if (sessionQ && perSession.size <= 1) {
  console.log(`COLD EVENTS in ${sessionQ} (idle ≥ ${gapMin}m before the turn)`);
  console.log("  turn   idle     ctx    rewrote   premium   when");
  for (const e of events)
    console.log(`  ${String(e.turn).padStart(4)}  ${dur(e.gapMin).padStart(6)}  ${k(e.ctx).padStart(6)}  ${k(e.create).padStart(7)}  ${usd(e.premium).padStart(7)}   ${(e.ts || "").slice(0, 16).replace("T", " ")}`);
  console.log("");
  process.exit(0);
}

console.log(`WORST SESSIONS (by avoidable premium)`);
console.log("  session   events  maxGap   maxCtx   coldWrite   premium   model");
for (const s of sessionRows.slice(0, top))
  console.log(`  ${s.sid}  ${String(s.events).padStart(5)}  ${dur(s.maxGapMin).padStart(6)}  ${k(s.maxCtx).padStart(6)}  ${usd(s.coldWrite).padStart(8)}  ${usd(s.premium).padStart(8)}   ${s.model}`);

console.log(`\nWORST SINGLE COLD REFILLS (premium ≥ ${usd(minPremium)})`);
console.log("  session   turn   idle     ctx    rewrote   premium   model");
for (const e of shown.slice(0, top))
  console.log(`  ${e.sid}  ${String(e.turn).padStart(4)}  ${dur(e.gapMin).padStart(6)}  ${k(e.ctx).padStart(6)}  ${k(e.create).padStart(7)}  ${usd(e.premium).padStart(7)}   ${e.model}`);

console.log(`\n→ Fix: keep long sessions warm (avoid >${gapMin}m idle mid-task), /compact or split before a break,`);
console.log(`  and prefer finishing a big-context session in one sitting over resuming it cold.\n`);
