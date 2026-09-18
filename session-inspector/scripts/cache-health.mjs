#!/usr/bin/env node
/**
 * cache-health.mjs — is prompt caching WORKING in this session, and if not, why not?
 *
 * Three failure shapes look the same in a cost total and are told apart only per turn:
 *
 *   HEALTHY     cache_read tracks the context: on calls above 100k, 90%+ of the tokens are
 *               cache reads, input_tokens is a handful, cache_creation is the per-turn delta.
 *   PLATEAU     cache_read stops at a fixed ceiling (the system prompt + tools) while
 *               input_tokens grows with the conversation — the history is never written
 *               to the cache. A proxy/gateway that drops or moves `cache_control` inside
 *               messages[], or re-serialises the body so the byte prefix never matches,
 *               produces exactly this. Measured 2026-09-18 through a nexos.ai gateway:
 *               cache_read pinned at 46–57k for 188 calls while input grew to 307k.
 *   TTL-EXPIRY  caching works, but the gap between turns exceeds the cache TTL (5 min or
 *               1 h — the transcript says which in usage.cache_creation.ephemeral_*), so
 *               the prefix is re-written after each pause. Visible as big cache_creation
 *               right after a long gap, and as cache writes that are never read back.
 *
 * Usage is counted ONCE PER API CALL (lib/usage.mjs): Claude Code writes one row per
 * content block, all repeating the same usage — summing rows over-counts 2–3x.
 *
 * Usage:
 *   node scripts/cache-health.mjs --session <id|path>        # one session, per-turn table + verdict
 *   node scripts/cache-health.mjs --days 7 [--project x]     # fleet: one line per session, worst first
 *   node scripts/cache-health.mjs --session <id> --json
 *
 * --session also accepts a full path, so a transcript outside the ~/.claude* profiles
 * (a gateway profile's own config dir) can be inspected.
 */
import { readFileSync, existsSync } from "fs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";
import { firstRowOf, apiProvider } from "./lib/usage.mjs";
import { priceFor } from "./lib/quota.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const projectQ = (opt("--project", "") || "").toLowerCase();
const sessionQ = opt("--session", "");
const days = parseInt(opt("--days", "0"), 10);
const asJson = flag("--json");
const windowStartMs = days > 0 ? Date.now() - days * 86400000 - 86400000 : 0;

const TTL_MS = { "5m": 5 * 60 * 1000, "1h": 60 * 60 * 1000 };
const ctxOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const k = (n) => (Math.abs(n) >= 1000 ? (n / 1000).toFixed(0) + "k" : String(Math.round(n)));
const pct = (n) => (100 * n).toFixed(0) + "%";
const $ = (n) => "$" + n.toFixed(2);

function analyse(path) {
  const content = readFileSync(path, "utf-8");
  const meta = extractMeta("claude", content);
  const id = projectIdentity(meta.cwd || "");
  const seen = new Set();
  const calls = [];
  let sessionId = "", version = "";
  for (const ln of content.split("\n")) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.sessionId && !sessionId) sessionId = o.sessionId;
    if (o.version) version = o.version;
    if (o.type !== "assistant" || !o.message?.usage) continue;
    if (!firstRowOf(o.message, seen)) continue;
    const u = o.message.usage;
    if (ctxOf(u) <= 0) continue;
    calls.push({
      ms: o.timestamp ? new Date(o.timestamp).getTime() : NaN,
      model: o.message.model || "?", provider: apiProvider(o.message.id), sidechain: !!o.isSidechain,
      i: u.input_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0, o: u.output_tokens || 0,
      cw1h: u.cache_creation?.ephemeral_1h_input_tokens || 0, cw5m: u.cache_creation?.ephemeral_5m_input_tokens || 0,
      ctx: ctxOf(u),
    });
  }
  if (!calls.length) return null;

  const tot = calls.reduce((a, c) => ({ i: a.i + c.i, cr: a.cr + c.cr, cw: a.cw + c.cw, o: a.o + c.o, cw1h: a.cw1h + c.cw1h, cw5m: a.cw5m + c.cw5m, ctx: a.ctx + c.ctx }),
    { i: 0, cr: 0, cw: 0, o: 0, cw1h: 0, cw5m: 0, ctx: 0 });
  const ttl = tot.cw1h > tot.cw5m ? "1h" : tot.cw5m > 0 ? "5m" : "?";
  const ttlMs = TTL_MS[ttl] || TTL_MS["5m"];
  const maxCtx = Math.max(...calls.map((c) => c.ctx));
  const maxCr = Math.max(...calls.map((c) => c.cr));
  const big = calls.filter((c) => c.ctx > 100000);
  const crShare = big.length ? big.reduce((a, c) => a + c.cr / c.ctx, 0) / big.length : NaN;
  const inShare = big.length ? big.reduce((a, c) => a + c.i / c.ctx, 0) / big.length : NaN;

  // gaps and TTL effects
  let gapsOverTtl = 0, coldRewrites = 0, coldWriteTokens = 0, expiredWriteTokens = 0, maxGapMs = 0;
  for (let n = 1; n < calls.length; n++) {
    const gap = calls[n].ms - calls[n - 1].ms;
    if (!Number.isFinite(gap)) continue;
    if (gap > maxGapMs) maxGapMs = gap;
    if (gap > ttlMs) {
      gapsOverTtl++;
      // a write on the call BEFORE the gap could not have been read back after it
      expiredWriteTokens += calls[n - 1].cw;
      if (calls[n].cw >= 5000) { coldRewrites++; coldWriteTokens += calls[n].cw; }
    }
  }

  // verdict
  let verdict;
  if (big.length >= 5 && inShare > 0.5 && maxCr < 0.4 * maxCtx) verdict = "PLATEAU";
  else if (coldRewrites >= 2 && coldWriteTokens > 0.2 * tot.cw) verdict = "TTL-EXPIRY";
  else if (big.length < 3) verdict = "SHORT"; // one or two big calls say nothing about caching
  else if (crShare >= 0.85) verdict = "HEALTHY";
  else verdict = "MIXED";

  // cost, list price, per dominant model; counterfactual = same context as 97% reads / 3% writes at this TTL
  const model = calls.map((c) => c.model).sort((a, b) => calls.filter((c) => c.model === b).length - calls.filter((c) => c.model === a).length)[0];
  const p = priceFor(model);
  const wMult = ttl === "1h" ? 2 : 1.25;
  const actual = (tot.i * p.in + tot.cr * p.in * p.cr + tot.cw1h * p.in * 2 + (tot.cw - tot.cw1h) * p.in * 1.25 + tot.o * p.out) / 1e6;
  // never above the actual bill: a session that already caches better than the 97/3 model keeps its own number
  const healthy = Math.min(actual, (tot.ctx * 0.97 * p.in * p.cr + tot.ctx * 0.03 * p.in * wMult + tot.o * p.out) / 1e6);

  return {
    id: (sessionId || basename(path, ".jsonl")).slice(0, 8), path, project: id.project || basename(dirname(path)),
    model, provider: calls[calls.length - 1].provider, version, calls: calls.length, subagentCalls: calls.filter((c) => c.sidechain).length,
    start: Number.isFinite(calls[0].ms) ? new Date(calls[0].ms).toISOString() : "", durationMin: Number.isFinite(calls[0].ms) ? (calls[calls.length - 1].ms - calls[0].ms) / 60000 : 0,
    tot, ttl, maxCtx, maxCr, callsAbove100k: big.length, crShare, inShare,
    gapsOverTtl, maxGapMin: maxGapMs / 60000, coldRewrites, coldWriteTokens, expiredWriteTokens,
    verdict, costList: actual, costHealthy: healthy, curve: sessionQ ? calls : undefined,
  };
}

// ── collect ───────────────────────────────────────────────────────────────────
const results = [];
if (sessionQ && existsSync(sessionQ)) {
  const r = analyse(sessionQ); if (r) results.push(r);
} else {
  for (const s of discover("claude")) {
    if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
    const folder = basename(dirname(s.path));
    if (sessionQ && !s.sessionId.toLowerCase().includes(sessionQ.toLowerCase())) continue;
    if (projectQ && !folder.toLowerCase().includes(projectQ)) {
      // cheap folder filter first; fall through to the cwd check only when the folder misses
      let content; try { content = readFileSync(s.path, "utf-8"); } catch { continue; }
      const meta = extractMeta("claude", content); const id = projectIdentity(meta.cwd || "");
      if (![meta.cwd, id.project, id.projectKey].join(" ").toLowerCase().includes(projectQ)) continue;
    }
    let r; try { r = analyse(s.path); } catch { continue; }
    if (r) results.push(r);
  }
}
const rank = { PLATEAU: 0, "TTL-EXPIRY": 1, MIXED: 2, HEALTHY: 3, SHORT: 4 };
results.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.costList - a.costList);

// ── output ────────────────────────────────────────────────────────────────────
if (asJson) { console.log(JSON.stringify({ scope: { session: sessionQ || null, project: projectQ || null, days: days || null }, sessions: results }, null, 2)); process.exit(0); }
if (!results.length) { console.log("No Claude sessions matched."); process.exit(0); }

if (sessionQ) {
  for (const r of results) {
    console.log("═".repeat(96));
    console.log(`CACHE HEALTH — ${r.id}  ${r.project}  ·  ${r.model} via ${r.provider}  ·  Claude Code ${r.version}`);
    console.log("═".repeat(96));
    console.log(`verdict: ${r.verdict}`);
    console.log(`API calls ${r.calls} (${r.subagentCalls} subagent) · ${r.start.slice(0, 16)}Z · ${r.durationMin.toFixed(0)} min · cache TTL ${r.ttl}`);
    console.log(`tokens: input ${k(r.tot.i)} · cache read ${k(r.tot.cr)} · cache write ${k(r.tot.cw)} (1h ${k(r.tot.cw1h)} / 5m ${k(r.tot.cw5m)}) · output ${k(r.tot.o)}`);
    console.log(`peak context ${k(r.maxCtx)} · peak cache read ${k(r.maxCr)} (${pct(r.maxCr / r.maxCtx)} of peak) · calls >100k: ${r.callsAbove100k}`);
    if (r.callsAbove100k) console.log(`on calls >100k: cache read ${pct(r.crShare)} of context, uncached input ${pct(r.inShare)}`);
    console.log(`gaps > TTL: ${r.gapsOverTtl} (longest ${r.maxGapMin.toFixed(0)} min) · cold re-writes after a gap: ${r.coldRewrites} (${k(r.coldWriteTokens)} tokens) · writes expired unread: ${k(r.expiredWriteTokens)}`);
    console.log(`cost at list: ${$(r.costList)} · same context with healthy caching: ${$(r.costHealthy)} · ratio ${(r.costList / Math.max(r.costHealthy, 0.01)).toFixed(1)}x`);
    const explain = {
      PLATEAU: "the conversation history is never cached — only the fixed prefix hits. Look at the proxy/gateway between the client and the API, not at the TTL.",
      "TTL-EXPIRY": "caching works but idle gaps outlive the TTL, so the prefix is re-written after each pause. Shorter pauses would fix it; so would the 1h TTL if the session is on 5m.",
      HEALTHY: "cache read tracks the context; nothing to fix here.",
      MIXED: "partially cached — inspect the per-call table for where reads drop.",
      SHORT: "never above 100k context; too small to judge.",
    };
    console.log(`→ ${explain[r.verdict]}`);
    console.log(`\n  call   gap     input  cache_read  cache_write   total  (sampled; every call after a gap > TTL is shown)`);
    const c = r.curve, step = Math.max(1, Math.floor(c.length / 14));
    const ttlMs = TTL_MS[r.ttl] || TTL_MS["5m"];
    for (let n = 0; n < c.length; n++) {
      const gap = n ? c[n].ms - c[n - 1].ms : 0;
      if (n % step && gap <= ttlMs && n !== c.length - 1) continue;
      const g = gap > ttlMs ? `${(gap / 60000).toFixed(0)}m!` : gap ? `${(gap / 1000).toFixed(0)}s` : "-";
      console.log(`  ${String(n + 1).padStart(4)} ${g.padStart(5)} ${String(c[n].i).padStart(9)} ${String(c[n].cr).padStart(11)} ${String(c[n].cw).padStart(12)} ${String(c[n].ctx).padStart(7)}`);
    }
    console.log(`  ${r.path}`);
  }
} else {
  console.log("═".repeat(110));
  console.log(`CACHE HEALTH — ${results.length} Claude sessions${days ? `  ·  ${days}d` : ""}${projectQ ? `  ·  project~${projectQ}` : ""}  ·  worst first`);
  console.log("═".repeat(110));
  const counts = {}; for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(Object.entries(counts).map(([v, n]) => `${v} ${n}`).join("  ·  "));
  console.log(`\nverdict     session   calls  peakCtx  cacheRead%  ttl  gaps>ttl  cold  cost$   healthy$  model/provider           project`);
  for (const r of results.filter((r) => r.verdict !== "SHORT").slice(0, 40)) {
    console.log(`${r.verdict.padEnd(11)} ${r.id}  ${String(r.calls).padStart(5)}  ${k(r.maxCtx).padStart(7)}  ${(r.callsAbove100k ? pct(r.crShare) : "-").padStart(10)}  ${r.ttl.padStart(3)}  ${String(r.gapsOverTtl).padStart(8)}  ${String(r.coldRewrites).padStart(4)}  ${r.costList.toFixed(0).padStart(5)}  ${r.costHealthy.toFixed(0).padStart(8)}  ${(r.model.replace(/^claude-/, "") + "/" + r.provider).padEnd(24)} ${r.project.slice(0, 30)}`);
  }
  console.log(`\nSHORT sessions (never above 100k) are hidden: ${counts.SHORT || 0}. Details: --session <id>.`);
}
