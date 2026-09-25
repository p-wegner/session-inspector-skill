#!/usr/bin/env node
/**
 * cache-health.mjs — is prompt caching WORKING in this session, and if not, why not?
 *
 * Three failure shapes look the same in a cost total and are told apart only per call:
 *
 *   HEALTHY     cache_read tracks the context: on big calls, 85%+ of the tokens are cache
 *               reads, uncached input is a handful, cache_creation is the per-turn delta.
 *   PLATEAU     cache_read stops at a fixed ceiling (the system prompt + tools) while
 *               uncached input grows with the conversation — the history is never written
 *               to the cache. A proxy/gateway that drops or moves `cache_control` inside
 *               messages[], or re-serialises the body so the byte prefix never matches,
 *               produces exactly this. Measured 2026-09-18 through a nexos.ai gateway:
 *               cache_read pinned at 46–57k for 188 calls while input grew to 307k.
 *   TTL-EXPIRY  caching works, but the gap between turns exceeds the cache TTL (5 min or
 *               1 h — a Claude transcript says which in usage.cache_creation.ephemeral_*), so
 *               the prefix is re-written after each pause. Visible as big cache_creation
 *               right after a long gap, and as cache writes that are never read back.
 *
 * Three agents, one verdict (--agent, default claude):
 *
 *   claude    ~/.claude* transcripts (+ CLAUDE_PROJECT_DIRS). Usage counted ONCE PER API CALL
 *             (lib/usage.mjs): Claude Code writes one row per content block, all repeating the
 *             same usage — summing rows over-counts 2–3x. Backend from the message-id prefix.
 *   codex     rollout .jsonl under ~/.codex/sessions, CODEX_HOME and CODEX_HOMES (`;`-list of
 *             further homes — a gateway key's codex home is invisible from ~/.codex). One
 *             `token_count` event per API response; its `last_token_usage.input_tokens`
 *             INCLUDES the cached part (OpenAI semantics), so uncached = input − cached − write.
 *             No TTL field exists; gaps are judged against 5 minutes.
 *   opencode  the SQLite store (~/.local/share/opencode/opencode.db, or OPENCODE_DB). One
 *             assistant message per API call with tokens {input, output, cache:{read,write}}.
 *             Needs Node 22.5+ (node:sqlite). A provider driven by @ai-sdk/openai-compatible
 *             records cache WRITES as 0 (the OpenAI usage shape has no such field), so the
 *             context of a call is under-counted by that turn's delta; reads are exact.
 *
 * Usage:
 *   node scripts/cache-health.mjs --session <id|path>                 # one session, per-call table + verdict
 *   node scripts/cache-health.mjs --days 7 [--project x]              # fleet: one line per session, worst first
 *   node scripts/cache-health.mjs --agent codex --session <id|path>   # a codex rollout (id substring or path)
 *   node scripts/cache-health.mjs --agent opencode --days 3           # every opencode session of three days
 *   ... --min-ctx 20000                                               # what counts as a "big" call (default
 *                                                                      #   100k for claude, 20k for the others)
 *   ... --surface cowork|desktop|cli|sdk                             # only sessions from that surface (claude);
 *                                                                      #   a prefix: cowork also takes cowork-3p
 *   ... --json
 */
import { readFileSync, existsSync } from "fs";
import { basename, dirname, join } from "path";
import { homedir } from "os";
import { discover, extractMeta, projectIdentity, coworkTask, sessionSurface } from "./lib/sessions.mjs";
import { firstRowOf, lateOutput, apiProvider } from "./lib/usage.mjs";
import { priceFor, isPriced } from "./lib/quota.mjs";
import { refuse } from "./lib/harness.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const agent = opt("--agent", "claude").toLowerCase();
refuse("cache-health --session", agent); // a known agent that records no cache tokens: one honest line, exit 3
if (!["claude", "codex", "opencode"].includes(agent)) { console.error(`--agent must be claude, codex or opencode (got ${agent})`); process.exit(2); }
const projectQ = (opt("--project", "") || "").toLowerCase();
const sessionQ = opt("--session", "");
const surfaceQ = (opt("--surface", "") || "").toLowerCase();
const days = parseInt(opt("--days", "0"), 10);
const asJson = flag("--json");
const minCtx = parseInt(opt("--min-ctx", agent === "claude" ? "100000" : "20000"), 10);
const windowStartMs = days > 0 ? Date.now() - days * 86400000 - 86400000 : 0;

const TTL_MS = { "5m": 5 * 60 * 1000, "1h": 60 * 60 * 1000 };
const k = (n) => (Math.abs(n) >= 1000 ? (n / 1000).toFixed(0) + "k" : String(Math.round(n)));
const pct = (n) => (100 * n).toFixed(0) + "%";
const $ = (n) => "$" + n.toFixed(2);

// ── per-agent readers: each yields { meta, calls[] } with calls of shape
//    { ms, model, provider, sidechain, i (uncached input), cr, cw, cw1h, cw5m, o, ctx } ──

function readClaude(path) {
  const content = readFileSync(path, "utf-8");
  const meta = extractMeta("claude", content);
  const id = projectIdentity(meta.cwd || "");
  const seen = new Set();
  const byId = new Map(); // message id -> call, so a repeat row can add the output it grew by
  const calls = [];
  let sessionId = "", version = "";
  const ctxOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  for (const ln of content.split("\n")) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.sessionId && !sessionId) sessionId = o.sessionId;
    if (o.version) version = o.version;
    if (o.type !== "assistant" || !o.message?.usage) continue;
    if (!firstRowOf(o.message, seen)) {
      // a repeat row: only a subagent's growing output_tokens can differ (lib/usage.mjs)
      const rec = byId.get(o.message.id);
      if (rec) rec.o += lateOutput(o.message, seen);
      continue;
    }
    const u = o.message.usage;
    if (ctxOf(u) <= 0) continue;
    calls.push({
      ms: o.timestamp ? new Date(o.timestamp).getTime() : NaN,
      model: o.message.model || "?", provider: apiProvider(o.message.id), sidechain: !!o.isSidechain,
      i: u.input_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0, o: u.output_tokens || 0,
      cw1h: u.cache_creation?.ephemeral_1h_input_tokens || 0, cw5m: u.cache_creation?.ephemeral_5m_input_tokens || 0,
      ctx: ctxOf(u),
    });
    if (o.message.id) byId.set(o.message.id, calls[calls.length - 1]);
  }
  // A Cowork task's slug is always "session" and its cwd a VM path: name it by the app's title.
  const task = coworkTask(path);
  const project = task ? `cowork: ${task.title || task.id}` : (id.project || basename(dirname(path)));
  return { meta: { id: (sessionId || basename(path, ".jsonl")).slice(0, 8), path, project, surface: sessionSurface(path, meta), version, client: "Claude Code" }, calls };
}

function readCodex(path) {
  const content = readFileSync(path, "utf-8");
  const calls = [];
  let sessionId = "", cwd = "", version = "", model = "", provider = "";
  for (const ln of content.split("\n")) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const p = o.payload || {};
    if (o.type === "session_meta") { sessionId = p.id || ""; cwd = p.cwd || ""; version = p.cli_version || ""; provider = p.model_provider || ""; }
    else if (o.type === "turn_context" && p.model) model = p.model;
    else if (o.type === "event_msg" && p.type === "token_count" && p.info?.last_token_usage) {
      const t = p.info.last_token_usage;
      const input = t.input_tokens || 0, cr = t.cached_input_tokens || 0, cw = t.cache_write_input_tokens || 0;
      if (input <= 0) continue;
      calls.push({
        ms: o.timestamp ? new Date(o.timestamp).getTime() : NaN, model: model || "?", provider: provider || "openai", sidechain: false,
        i: Math.max(0, input - cr - cw), cr, cw, cw1h: 0, cw5m: 0, o: t.output_tokens || 0, ctx: input,
      });
    }
  }
  const id = projectIdentity(cwd);
  return { meta: { id: (sessionId || basename(path, ".jsonl")).slice(0, 8), path, project: id.project || cwd, version, client: "codex" }, calls };
}

async function openOpencode() {
  const dbPath = process.env.OPENCODE_DB || join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) { console.error(`no opencode store at ${dbPath} (set OPENCODE_DB)`); process.exit(1); }
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { console.error(`--agent opencode needs node:sqlite (Node 22.5+); this is ${process.version}`); process.exit(1); }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function readOpencode(db, s) {
  const rows = db.prepare("select time_created, data from message where session_id = ? order by time_created").all(s.id);
  const calls = [];
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    if (d.role !== "assistant" || !d.tokens) continue;
    const i = d.tokens.input || 0, cr = d.tokens.cache?.read || 0, cw = d.tokens.cache?.write || 0;
    if (i + cr + cw <= 0) continue;
    calls.push({ ms: r.time_created, model: d.modelID || "?", provider: d.providerID || "?", sidechain: false, i, cr, cw, cw1h: 0, cw5m: 0, o: d.tokens.output || 0, ctx: i + cr + cw });
  }
  const id = projectIdentity(s.directory || "");
  return { meta: { id: s.id.slice(0, 12), path: `opencode.db session ${s.id}`, project: id.project || s.directory || "", version: s.version || "", client: "opencode", title: s.title }, calls };
}

// ── the verdict, agent-independent ────────────────────────────────────────────
function assess({ meta, calls }) {
  if (!calls.length) return null;
  const tot = calls.reduce((a, c) => ({ i: a.i + c.i, cr: a.cr + c.cr, cw: a.cw + c.cw, o: a.o + c.o, cw1h: a.cw1h + c.cw1h, cw5m: a.cw5m + c.cw5m, ctx: a.ctx + c.ctx }),
    { i: 0, cr: 0, cw: 0, o: 0, cw1h: 0, cw5m: 0, ctx: 0 });
  const ttl = tot.cw1h > tot.cw5m ? "1h" : tot.cw5m > 0 ? "5m" : agent === "claude" ? "?" : "n/a";
  const ttlMs = TTL_MS[ttl] || TTL_MS["5m"];
  const maxCtx = Math.max(...calls.map((c) => c.ctx));
  const maxCr = Math.max(...calls.map((c) => c.cr));
  const big = calls.filter((c) => c.ctx > minCtx);
  const crShare = big.length ? big.reduce((a, c) => a + c.cr / c.ctx, 0) / big.length : NaN;
  const inShare = big.length ? big.reduce((a, c) => a + c.i / c.ctx, 0) / big.length : NaN;

  let gapsOverTtl = 0, coldRewrites = 0, coldWriteTokens = 0, expiredWriteTokens = 0, maxGapMs = 0;
  for (let n = 1; n < calls.length; n++) {
    const gap = calls[n].ms - calls[n - 1].ms;
    if (!Number.isFinite(gap)) continue;
    if (gap > maxGapMs) maxGapMs = gap;
    if (gap > ttlMs) {
      gapsOverTtl++;
      expiredWriteTokens += calls[n - 1].cw; // a write on the call BEFORE the gap could not have been read back after it
      if (calls[n].cw >= 5000) { coldRewrites++; coldWriteTokens += calls[n].cw; }
    }
  }

  let verdict;
  if (big.length >= 5 && inShare > 0.5 && maxCr < 0.4 * maxCtx) verdict = "PLATEAU";
  else if (coldRewrites >= 2 && coldWriteTokens > 0.2 * tot.cw) verdict = "TTL-EXPIRY";
  else if (big.length < 3) verdict = "SHORT";
  else if (crShare >= 0.85) verdict = "HEALTHY";
  else verdict = "MIXED";

  const model = calls.map((c) => c.model).sort((a, b) => calls.filter((c) => c.model === b).length - calls.filter((c) => c.model === a).length)[0];
  let costList = null, costHealthy = null;
  if (isPriced(model)) {
    const p = priceFor(model);
    const wMult = ttl === "1h" ? 2 : 1.25;
    costList = (tot.i * p.in + tot.cr * p.in * p.cr + tot.cw1h * p.in * 2 + (tot.cw - tot.cw1h) * p.in * 1.25 + tot.o * p.out) / 1e6;
    // never above the actual bill: a session that already caches better than the 97/3 model keeps its own number
    costHealthy = Math.min(costList, (tot.ctx * 0.97 * p.in * p.cr + tot.ctx * 0.03 * p.in * wMult + tot.o * p.out) / 1e6);
  }

  return {
    ...meta, agent,
    model, provider: calls[calls.length - 1].provider, calls: calls.length, subagentCalls: calls.filter((c) => c.sidechain).length,
    start: Number.isFinite(calls[0].ms) ? new Date(calls[0].ms).toISOString() : "", durationMin: Number.isFinite(calls[0].ms) ? (calls[calls.length - 1].ms - calls[0].ms) / 60000 : 0,
    tot, ttl, maxCtx, maxCr, minCtx, callsAboveMin: big.length, crShare, inShare,
    gapsOverTtl, maxGapMin: maxGapMs / 60000, coldRewrites, coldWriteTokens, expiredWriteTokens,
    verdict, costList, costHealthy, curve: sessionQ ? calls : undefined,
  };
}

// ── collect ───────────────────────────────────────────────────────────────────
const results = [];
const push = (r) => { if (r && (!surfaceQ || String(r.surface || "").startsWith(surfaceQ))) results.push(r); };
if (agent === "opencode") {
  const db = await openOpencode();
  const sessions = db.prepare("select id, title, directory, version, time_created from session order by time_created desc").all();
  for (const s of sessions) {
    if (sessionQ && !s.id.toLowerCase().includes(sessionQ.toLowerCase())) continue;
    if (windowStartMs && s.time_created < windowStartMs) continue;
    if (projectQ && !`${s.directory} ${s.title}`.toLowerCase().includes(projectQ)) continue;
    try { push(assess(readOpencode(db, s))); } catch { /* skip a malformed session */ }
  }
} else if (sessionQ && existsSync(sessionQ)) {
  push(assess(agent === "codex" ? readCodex(sessionQ) : readClaude(sessionQ)));
} else {
  for (const s of discover(agent)) {
    if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
    if (sessionQ && !s.sessionId.toLowerCase().includes(sessionQ.toLowerCase()) && !s.path.toLowerCase().includes(sessionQ.toLowerCase())) continue;
    if (projectQ) {
      const folder = basename(dirname(s.path));
      let hit = agent === "claude" && folder.toLowerCase().includes(projectQ);
      if (!hit) {
        let content; try { content = readFileSync(s.path, "utf-8"); } catch { continue; }
        const meta = extractMeta(agent, content); const id = projectIdentity(meta.cwd || "");
        hit = [meta.cwd, id.project, id.projectKey].join(" ").toLowerCase().includes(projectQ);
      }
      if (!hit) continue;
    }
    let r; try { r = assess(agent === "codex" ? readCodex(s.path) : readClaude(s.path)); } catch { continue; }
    push(r);
  }
}
const rank = { PLATEAU: 0, "TTL-EXPIRY": 1, MIXED: 2, HEALTHY: 3, SHORT: 4 };
results.sort((a, b) => rank[a.verdict] - rank[b.verdict] || (b.costList ?? b.tot.ctx / 1e6) - (a.costList ?? a.tot.ctx / 1e6));

// ── output ────────────────────────────────────────────────────────────────────
if (asJson) { console.log(JSON.stringify({ scope: { agent, session: sessionQ || null, project: projectQ || null, days: days || null, minCtx }, sessions: results }, null, 2)); process.exit(0); }
if (!results.length) { console.log(`No ${agent} sessions matched.`); process.exit(0); }

const cost = (r) => (r.costList === null ? "n/a (no list price for this model)" : `${$(r.costList)} · same context with healthy caching: ${$(r.costHealthy)} · ratio ${(r.costList / Math.max(r.costHealthy, 0.01)).toFixed(1)}x`);
const cost$ = (r, key) => (r[key] === null ? "n/a" : r[key].toFixed(0));
const writesNote = (r) => (r.agent === "opencode" && r.tot.cw === 0 && r.tot.cr > 0 ? "\n  note: cache writes are recorded as 0 by this provider (OpenAI usage shape); the context per call is under-counted by that turn's delta" : "");

if (sessionQ) {
  for (const r of results) {
    console.log("═".repeat(96));
    console.log(`CACHE HEALTH — ${r.id}  ${r.project}  ·  ${r.model} via ${r.provider}  ·  ${r.client} ${r.version}${r.surface ? `  ·  ${r.surface}` : ""}`);
    console.log("═".repeat(96));
    console.log(`verdict: ${r.verdict}`);
    console.log(`API calls ${r.calls}${r.subagentCalls ? ` (${r.subagentCalls} subagent)` : ""} · ${r.start.slice(0, 16)}Z · ${r.durationMin.toFixed(0)} min · cache TTL ${r.ttl}`);
    console.log(`tokens: uncached input ${k(r.tot.i)} · cache read ${k(r.tot.cr)} · cache write ${k(r.tot.cw)}${r.agent === "claude" ? ` (1h ${k(r.tot.cw1h)} / 5m ${k(r.tot.cw5m)})` : ""} · output ${k(r.tot.o)}`);
    console.log(`peak context ${k(r.maxCtx)} · peak cache read ${k(r.maxCr)} (${pct(r.maxCr / r.maxCtx)} of peak) · calls >${k(r.minCtx)}: ${r.callsAboveMin}`);
    if (r.callsAboveMin) console.log(`on calls >${k(r.minCtx)}: cache read ${pct(r.crShare)} of context, uncached input ${pct(r.inShare)}`);
    console.log(`gaps > TTL: ${r.gapsOverTtl} (longest ${r.maxGapMin.toFixed(0)} min) · cold re-writes after a gap: ${r.coldRewrites} (${k(r.coldWriteTokens)} tokens) · writes expired unread: ${k(r.expiredWriteTokens)}`);
    console.log(`cost at list: ${cost(r)}${writesNote(r)}`);
    const explain = {
      PLATEAU: "the conversation history is never cached — only the fixed prefix hits. Look at the proxy/gateway between the client and the API, not at the TTL.",
      "TTL-EXPIRY": "caching works but idle gaps outlive the TTL, so the prefix is re-written after each pause. Shorter pauses would fix it; so would the 1h TTL if the session is on 5m.",
      HEALTHY: "cache read tracks the context; nothing to fix here.",
      MIXED: "partially cached — inspect the per-call table for where reads drop.",
      SHORT: `never above ${k(r.minCtx)} context on three calls; too small to judge (lower --min-ctx to force a verdict).`,
    };
    console.log(`→ ${explain[r.verdict]}`);
    console.log(`\n  call   gap  uncached  cache_read  cache_write   total  (sampled; every call after a gap > TTL is shown)`);
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
  console.log(`CACHE HEALTH — ${results.length} ${agent} sessions${days ? `  ·  ${days}d` : ""}${projectQ ? `  ·  project~${projectQ}` : ""}${surfaceQ ? `  ·  surface~${surfaceQ}` : ""}  ·  big call = >${k(minCtx)} context  ·  worst first`);
  console.log("═".repeat(110));
  const counts = {}; for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(Object.entries(counts).map(([v, n]) => `${v} ${n}`).join("  ·  "));
  console.log(`\nverdict     session       calls  peakCtx  cacheRead%  ttl  gaps>ttl  cold  cost$   healthy$  model/provider           project`);
  for (const r of results.filter((r) => r.verdict !== "SHORT").slice(0, 40)) {
    console.log(`${r.verdict.padEnd(11)} ${r.id.padEnd(12)}  ${String(r.calls).padStart(5)}  ${k(r.maxCtx).padStart(7)}  ${(r.callsAboveMin ? pct(r.crShare) : "-").padStart(10)}  ${r.ttl.padStart(3)}  ${String(r.gapsOverTtl).padStart(8)}  ${String(r.coldRewrites).padStart(4)}  ${cost$(r, "costList").padStart(5)}  ${cost$(r, "costHealthy").padStart(8)}  ${(r.model.replace(/^claude-/, "") + "/" + r.provider).slice(0, 24).padEnd(24)} ${(r.surface && r.surface !== "cli" ? `[${r.surface}] ` : "") + String(r.project).slice(0, 30)}`);
  }
  console.log(`\nSHORT sessions (never above ${k(minCtx)}) are hidden: ${counts.SHORT || 0}. Details: --session <id>.`);
}
