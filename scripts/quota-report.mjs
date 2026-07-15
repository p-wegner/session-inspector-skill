#!/usr/bin/env node
/**
 * QUOTA REPORT — aggregate everything that happened in ONE Claude profile since
 * a wall-clock cutoff (default: the last weekly subscription reset), and answer
 * "what did my subscription do this week?": when it was used, how many tokens /
 * est. USD were consumed, which models, how many tool calls (and failures),
 * per-project / per-day / per-hour / per-session breakdowns.
 *
 * Unlike token-sinks.mjs (which stat-filters whole FILES by mtime), this filters
 * PER TURN by the turn's own timestamp — a session that started before the reset
 * but ran on after it contributes only its post-reset turns. Subagent transcripts
 * (`<session>/subagents/agent-*.jsonl`) ARE included: they hit the API and burn
 * the same quota.
 *
 * Cost model matches token-sinks.mjs: $/1M in/out, cache-read 0.1x in,
 * cache-write 1.25x in. opus 5/25 · sonnet 3/15 · haiku 1/5. Est. USD is what the
 * usage WOULD have cost at API pay-go rates — i.e. the value extracted from the
 * flat subscription.
 *
 * Usage:
 *   node scripts/quota-report.mjs --profile andrena_team_5x_2                 # since last Fri 12:00 Berlin
 *   node scripts/quota-report.mjs --profile <name> --since 2026-07-10T10:00:00Z
 *   node scripts/quota-report.mjs --profile <name> --json                     # full machine-readable blob
 *   node scripts/quota-report.mjs --profile <name> --html report.html         # write a dashboard
 *   node scripts/quota-report.mjs --profile <name> --tz 2                      # UTC offset for hour-of-day (default 2 = CEST)
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { classify } from "./lib/prompts.mjs";
import { toolDisplayName } from "./lib/parse.mjs";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const profile = flag("profile", "");
const configDir = flag("config-dir", "");
const jsonOut = argv.includes("--json");
const htmlPath = flag("html", "");
const tzOffset = parseInt(flag("tz", "2"), 10); // Europe/Berlin summer = UTC+2

// Resolve the profile home → projects dir.
function projectsDir() {
  if (configDir) return join(configDir, "projects");
  if (profile) return join(homedir(), `.claude-${profile}`, "projects");
  if (process.env.CLAUDE_CONFIG_DIR) return join(process.env.CLAUDE_CONFIG_DIR, "projects");
  return join(homedir(), ".claude", "projects");
}

// Default cutoff = most recent Friday 12:00 Europe/Berlin, expressed in UTC.
// Berlin summer (CEST) = UTC+2, so 12:00 local = 10:00Z. We compute the last
// Friday 10:00Z at/before now. (Caller can override with --since.)
function lastWeeklyReset() {
  const now = new Date();
  // walk back day by day to the most recent Friday, set 10:00:00Z
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0));
  // getUTCDay: 0=Sun..5=Fri
  let cursor = new Date(d);
  for (let i = 0; i < 8; i++) {
    if (cursor.getUTCDay() === 5 && cursor.getTime() <= now.getTime()) return cursor;
    cursor = new Date(cursor.getTime() - 24 * 3600 * 1000);
  }
  return d;
}
// Auto-detect a profile's WEEKLY reset schedule from its own limit banners.
// Claude banners read either "resets Jul 17, 12pm (Europe/Berlin)" (>24h out —
// explicit date) or "resets 6am (Europe/Berlin)" (<24h out — clock only). We
// parse the NEXT reset the banner announces, derive the weekly anchor
// (weekday + clock in Berlin), then step in 7-day multiples to the most recent
// boundary at/before now. Different accounts anchor on different weekdays/times,
// so this beats hardcoding. Returns { sinceMs, anchor, evidence } or null.
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
// build a UTC ms from a Berlin wall-clock (tzOffset hours east of UTC)
const berlinToUtcMs = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h - tzOffset, mi || 0, 0);
function parseResetTime(str) { // "12pm" | "6am" | "1:50am" -> {h, mi} in 24h
  const m = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10); const mi = m[2] ? parseInt(m[2], 10) : 0;
  const pm = /pm/i.test(m[3]);
  if (pm && h !== 12) h += 12; if (!pm && h === 12) h = 0;
  return { h, mi };
}
function detectWeeklyReset(baseDir) {
  // gather the LATEST "weekly limit" banner (with its timestamp)
  const files = []; walkJsonl(baseDir, files);
  let latest = null;
  for (const f of files) {
    let lines; try { lines = readFileSync(f, "utf-8").split("\n"); } catch { continue; }
    for (const line of lines) {
      const s = line.trim(); if (!s) continue;
      let o; try { o = JSON.parse(s); } catch { continue; }
      const m = o.message; const texts = [];
      if (m && Array.isArray(m.content)) for (const c of m.content) if (c.type === "text" && c.text) texts.push(c.text);
      if (m && typeof m.content === "string") texts.push(m.content);
      for (const t of texts) {
        if (t.length > 200 || /^<task-notification>|^Base directory/.test(t)) continue;
        if (/hit your weekly limit|weekly limit\b/i.test(t) && /reset/i.test(t) && o.timestamp) {
          if (!latest || o.timestamp > latest.ts) latest = { ts: o.timestamp, text: t.replace(/\s+/g, " ").trim() };
        }
      }
    }
  }
  if (!latest) return null;
  const bannerMs = new Date(latest.ts).getTime();
  const time = parseResetTime(latest.text);
  if (!time) return null;
  // R = the next reset the banner announces, as a UTC ms
  let Rms;
  const dm = latest.text.match(/resets?\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/i); // explicit date
  if (dm && MONTHS[dm[1].toLowerCase()] !== undefined) {
    const bd = new Date(bannerMs); let y = bd.getUTCFullYear();
    const mo = MONTHS[dm[1].toLowerCase()]; const day = parseInt(dm[2], 10);
    if (mo < bd.getUTCMonth()) y += 1; // Dec->Jan rollover
    Rms = berlinToUtcMs(y, mo, day, time.h, time.mi);
  } else {
    // clock only: next occurrence of that Berlin clock time strictly after the banner
    const b = new Date(bannerMs + tzOffset * 3600e3); // banner in Berlin wall-clock
    let cand = berlinToUtcMs(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), time.h, time.mi);
    if (cand <= bannerMs) cand += 24 * 3600e3;
    Rms = cand;
  }
  // step to the most recent boundary at/before now
  const nowMs = Date.now();
  let bnd = Rms;
  while (bnd > nowMs) bnd -= 7 * 24 * 3600e3;
  while (bnd + 7 * 24 * 3600e3 <= nowMs) bnd += 7 * 24 * 3600e3;
  const bWall = new Date(bnd + tzOffset * 3600e3);
  const anchor = { weekday: WD[bWall.getUTCDay()], clock: `${((time.h + 11) % 12) + 1}${time.mi ? ":" + String(time.mi).padStart(2, "0") : ""}${time.h < 12 ? "am" : "pm"}`, tz: "Europe/Berlin" };
  return { sinceMs: bnd, anchor, evidence: latest };
}

const sinceArg = flag("since", "");
const noAuto = argv.includes("--no-auto-reset");
let since, sinceMs, resetInfo = null;
const until = new Date();

// ── pricing (mirror token-sinks.mjs) ──────────────────────────────────────────
const PRICING = [
  { match: /opus/, in: 5, out: 25 },
  { match: /sonnet/, in: 3, out: 15 },
  { match: /haiku/, in: 1, out: 5 },
];
const priceFor = (m) => PRICING.find((p) => p.match.test(m || "")) || { in: 5, out: 25 };
const costUsd = (m, t) =>
  (t.input * priceFor(m).in + t.output * priceFor(m).out +
    t.cacheCreation * priceFor(m).in * 1.25 + t.cacheRead * priceFor(m).in * 0.1) / 1e6;
const zt = () => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
const addT = (a, b) => { a.input += b.input; a.output += b.output; a.cacheCreation += b.cacheCreation; a.cacheRead += b.cacheRead; };
const rawT = (t) => t.input + t.output + t.cacheCreation + t.cacheRead;

// short model label (opus-4.8 etc.)
const modelLabel = (m) => {
  if (!m) return "(unknown)";
  const s = m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[1m\]$/, "");
  return s;
};

// ── walk transcripts ──────────────────────────────────────────────────────────
const base = projectsDir();
if (!existsSync(base)) { console.error(`No projects dir: ${base}`); process.exit(1); }

// Resolve the cutoff: explicit --since wins; else auto-detect this profile's
// weekly reset from its banners; else fall back to the Fri-12:00-Berlin default.
if (sinceArg) {
  since = new Date(sinceArg);
  resetInfo = { mode: "manual" };
} else if (!noAuto && (resetInfo = detectWeeklyReset(base))) {
  since = new Date(resetInfo.sinceMs);
  resetInfo.mode = "auto";
} else {
  since = lastWeeklyReset();
  resetInfo = { mode: "default-fri-12", anchor: { weekday: "Fri", clock: "12pm", tz: "Europe/Berlin" } };
}
sinceMs = since.getTime();

function walkJsonl(dir, acc) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walkJsonl(p, acc); continue; }
    if (e.name.endsWith(".jsonl")) acc.push(p);
  }
}

// per-turn parse of ONE transcript, keeping only turns at/after cutoff
function parseFile(path, project, isSubagent) {
  const tokens = zt();
  let model = "";
  let firstTs = "", lastTs = "";
  let turns = 0, toolCalls = 0, toolErrors = 0, cost = 0;
  const toolCounts = new Map();      // name -> {calls, errors}
  const idToName = new Map();        // tool_use_id -> name (for error attribution)
  const byDay = new Map();           // day -> {tokens, cost, turns, toolCalls}
  const byHour = new Array(24).fill(0).map(() => ({ turns: 0, cost: 0 }));
  let firstPrompt = "";
  const models = new Map();          // model -> {tokens, turns, cost}

  let lines; try { lines = readFileSync(path, "utf-8").split("\n"); } catch { return null; }
  // first pass: build tool_use_id -> name over WHOLE file (results may reference earlier calls)
  for (const line of lines) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (o.type === "assistant" && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) if (c.type === "tool_use") idToName.set(c.id, toolDisplayName(c.name, c.input));
    }
  }
  for (const line of lines) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    const ts = o.timestamp ? new Date(o.timestamp).getTime() : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) continue; // per-turn cutoff

    if (!firstTs) firstTs = o.timestamp;
    lastTs = o.timestamp;
    const day = o.timestamp.slice(0, 10);
    const hourLocal = ((new Date(ts).getUTCHours() + tzOffset) % 24 + 24) % 24;

    // human first prompt (non-subagent only)
    if (!isSubagent && !firstPrompt && o.type === "user" && !o.isMeta && !o.isSidechain && o.toolUseResult === undefined) {
      const c = o.message?.content;
      let raw = typeof c === "string" ? c : Array.isArray(c) && !c.some(b => b.type === "tool_result")
        ? c.filter(b => b.type === "text").map(b => b.text).join("\n") : null;
      const cl = raw ? classify(raw) : null;
      if (cl && cl.kind === "human") firstPrompt = cl.text.slice(0, 160);
    }

    if (o.type === "assistant" && o.message) {
      const m = o.message;
      if (m.model && m.model !== "<synthetic>") model = m.model;
      const u = m.usage;
      if (u) {
        turns++;
        const tt = { input: u.input_tokens || 0, output: u.output_tokens || 0,
          cacheCreation: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
        addT(tokens, tt);
        const c = costUsd(m.model, tt);
        cost += c;
        // per day
        let dg = byDay.get(day); if (!dg) { dg = { tokens: zt(), cost: 0, turns: 0, toolCalls: 0 }; byDay.set(day, dg); }
        addT(dg.tokens, tt); dg.cost += c; dg.turns++;
        // per hour
        byHour[hourLocal].turns++; byHour[hourLocal].cost += c;
        // per model
        let mg = models.get(m.model); if (!mg) { mg = { tokens: zt(), turns: 0, cost: 0 }; models.set(m.model, mg); }
        addT(mg.tokens, tt); mg.turns++; mg.cost += c;
      }
      if (Array.isArray(m.content)) {
        for (const c of m.content) if (c.type === "tool_use") {
          toolCalls++;
          const tname = toolDisplayName(c.name, c.input);
          let tc = toolCounts.get(tname); if (!tc) { tc = { calls: 0, errors: 0 }; toolCounts.set(tname, tc); }
          tc.calls++;
          const dg = byDay.get(day); if (dg) dg.toolCalls++;
        }
      }
    }
    // tool errors: user turn carrying a tool_result with is_error
    if (o.type === "user" && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) if (c.type === "tool_result" && c.is_error) {
        toolErrors++;
        const name = idToName.get(c.tool_use_id) || "(unknown)";
        let tc = toolCounts.get(name); if (!tc) { tc = { calls: 0, errors: 0 }; toolCounts.set(name, tc); }
        tc.errors++;
      }
    }
  }
  if (!firstTs) return null; // nothing in window
  return { path, project, isSubagent, tokens, model, cost, firstTs, lastTs, turns, toolCalls, toolErrors,
    toolCounts, byDay, byHour, models, firstPrompt };
}

// Detect Claude usage/rate/weekly-limit banners (evidence for the quota window).
const LIMIT_RE = /(hit your weekly limit|weekly limit\b|usage limit reached|Claude (AI )?usage limit|limit will reset|resets? (at|on|Jul|Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun)|5-hour limit)/i;
function scanLimits(path) {
  const out = [];
  let lines; try { lines = readFileSync(path, "utf-8").split("\n"); } catch { return out; }
  for (const line of lines) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    const ts = o.timestamp ? new Date(o.timestamp).getTime() : NaN;
    const texts = [];
    const m = o.message;
    if (m && Array.isArray(m.content)) for (const c of m.content) if (c.type === "text" && c.text) texts.push(c.text);
    if (m && typeof m.content === "string") texts.push(m.content);
    for (const t of texts) {
      if (/^<task-notification>/.test(t)) continue;               // harness noise
      if (/^Base directory for this skill:/.test(t)) continue;    // skill preamble (docs mention "limit will reset")
      if (t.length > 400) continue;                               // real banners are short; long text = docs/analysis quoting the phrase
      if (/node scripts\/|SKILL\.md|analyze-.*-session/.test(t)) continue; // this skill's own docs
      if (LIMIT_RE.test(t) && /\blimit\b/i.test(t)) out.push({ ts: o.timestamp, text: t.slice(0, 200).replace(/\s+/g, " ").trim() }); // require "limit" — rejects "resets on teardown" prose
    }
  }
  return out;
}

const files = [];
walkJsonl(base, files);
const parsed = [];
const limitEvents = [];
for (const f of files) {
  const rel = f.slice(base.length + 1);
  const project = rel.split(/[\\/]/)[0];
  const isSubagent = /[\\/]subagents[\\/]/.test(f);
  // cheap mtime prefilter: if file wasn't touched since cutoff it has no in-window turns
  let st; try { st = statSync(f); } catch { continue; }
  if (st.mtimeMs < sinceMs) continue;
  const r = parseFile(f, project, isSubagent);
  if (r) parsed.push(r);
  if (!isSubagent) for (const ev of scanLimits(f)) limitEvents.push(ev);
}
// collapse by distinct message text: keep earliest ts + a repeat count, so the
// timeline shows WHEN each distinct banner first appeared, not 60 repeats of it.
{
  const byText = new Map();
  for (const e of limitEvents.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""))) {
    const k = e.text.replace(/\s+/g, " ").trim();
    const g = byText.get(k);
    if (g) { g.count++; g.lastTs = e.ts; }
    else byText.set(k, { ts: e.ts, lastTs: e.ts, text: k, count: 1 });
  }
  limitEvents.length = 0;
  limitEvents.push(...[...byText.values()].sort((a, b) => (a.ts || "").localeCompare(b.ts || "")));
}

// ── aggregate ──────────────────────────────────────────────────────────────────
const totals = { tokens: zt(), cost: 0, turns: 0, toolCalls: 0, toolErrors: 0,
  sessions: parsed.filter(p => !p.isSubagent).length, subagents: parsed.filter(p => p.isSubagent).length };
const byModel = new Map(), byProject = new Map(), byDay = new Map(), byTool = new Map();
const byHour = new Array(24).fill(0).map(() => ({ turns: 0, cost: 0 }));

for (const p of parsed) {
  addT(totals.tokens, p.tokens); totals.cost += p.cost;
  totals.turns += p.turns; totals.toolCalls += p.toolCalls; totals.toolErrors += p.toolErrors;
  // models
  for (const [m, g] of p.models) {
    let x = byModel.get(m); if (!x) { x = { tokens: zt(), turns: 0, cost: 0 }; byModel.set(m, x); }
    addT(x.tokens, g.tokens); x.turns += g.turns; x.cost += g.cost;
  }
  // project
  let pg = byProject.get(p.project);
  if (!pg) { pg = { tokens: zt(), cost: 0, turns: 0, toolCalls: 0, sessions: 0, subagents: 0 }; byProject.set(p.project, pg); }
  addT(pg.tokens, p.tokens); pg.cost += p.cost; pg.turns += p.turns; pg.toolCalls += p.toolCalls;
  if (p.isSubagent) pg.subagents++; else pg.sessions++;
  // day
  for (const [d, g] of p.byDay) {
    let x = byDay.get(d); if (!x) { x = { tokens: zt(), cost: 0, turns: 0, toolCalls: 0 }; byDay.set(d, x); }
    addT(x.tokens, g.tokens); x.cost += g.cost; x.turns += g.turns; x.toolCalls += g.toolCalls;
  }
  // hour
  for (let h = 0; h < 24; h++) { byHour[h].turns += p.byHour[h].turns; byHour[h].cost += p.byHour[h].cost; }
  // tools
  for (const [name, tc] of p.toolCounts) {
    let x = byTool.get(name); if (!x) { x = { calls: 0, errors: 0 }; byTool.set(name, x); }
    x.calls += tc.calls; x.errors += tc.errors;
  }
}

const sortByCost = (m) => [...m.entries()].map(([k, v]) => ({ key: k, ...v, rawTokens: rawT(v.tokens) })).sort((a, b) => b.cost - a.cost);

const report = {
  meta: {
    profile: profile || configDir || "default",
    projectsDir: base,
    since: since.toISOString(),
    until: until.toISOString(),
    tzOffset,
    generatedAt: until.toISOString(),
    resetInfo,
    limitEvents,
  },
  totals: { ...totals, rawTokens: rawT(totals.tokens) },
  byModel: sortByCost(byModel).map(r => ({ model: modelLabel(r.key), raw: r.key, turns: r.turns, cost: r.cost, tokens: r.tokens, rawTokens: r.rawTokens })),
  byProject: sortByCost(byProject).map(r => ({ project: r.key, sessions: r.sessions, subagents: r.subagents, turns: r.turns, toolCalls: r.toolCalls, cost: r.cost, tokens: r.tokens, rawTokens: r.rawTokens })),
  byDay: [...byDay.entries()].map(([d, v]) => ({ day: d, turns: v.turns, toolCalls: v.toolCalls, cost: v.cost, tokens: v.tokens, rawTokens: rawT(v.tokens) })).sort((a, b) => a.day.localeCompare(b.day)),
  byHour: byHour.map((v, h) => ({ hour: h, turns: v.turns, cost: v.cost })),
  byTool: [...byTool.entries()].map(([name, v]) => ({ tool: name, calls: v.calls, errors: v.errors })).sort((a, b) => b.calls - a.calls),
  sessions: parsed.filter(p => !p.isSubagent).map(p => ({
    id: p.path.split(/[\\/]/).pop().replace(/\.jsonl$/, ""),
    project: p.project, model: modelLabel(p.model),
    firstTs: p.firstTs, lastTs: p.lastTs,
    durationMin: (new Date(p.lastTs) - new Date(p.firstTs)) / 60000,
    turns: p.turns, toolCalls: p.toolCalls, toolErrors: p.toolErrors,
    cost: p.cost, rawTokens: rawT(p.tokens), tokens: p.tokens,
    firstPrompt: p.firstPrompt,
  })).sort((a, b) => b.cost - a.cost),
};

const DASHBOARD_CSS = `<style>
:root{
  --bg:#f6f7f9; --panel:#ffffff; --ink:#1a1d21; --muted:#5b6470; --line:#e3e7ec;
  --accent:#4f7cff; --good:#2f9e6f; --warn:#d98a1f; --bad:#d8493f;
  --c1:#4f7cff; --c2:#8b5cf6; --c3:#e8833a; --c4:#2f9e6f; --c5:#d8493f; --c6:#39b3c6;
  --track:#eef1f5;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#0f1216;--panel:#171b21;--ink:#e8ecf1;--muted:#9aa4b2;--line:#262c35;
    --track:#232a33;--c1:#6b93ff;--c2:#a78bfa;--c3:#f0975a;--c4:#4cc78d;--c5:#f0665c;--c6:#4fc9db;}
}
:root[data-theme=dark]{--bg:#0f1216;--panel:#171b21;--ink:#e8ecf1;--muted:#9aa4b2;--line:#262c35;
  --track:#232a33;--c1:#6b93ff;--c2:#a78bfa;--c3:#f0975a;--c4:#4cc78d;--c5:#f0665c;--c6:#4fc9db;}
:root[data-theme=light]{--bg:#f6f7f9;--panel:#fff;--ink:#1a1d21;--muted:#5b6470;--line:#e3e7ec;
  --track:#eef1f5;--c1:#4f7cff;--c2:#8b5cf6;--c3:#e8833a;--c4:#2f9e6f;--c5:#d8493f;--c6:#39b3c6;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.45;
  -webkit-font-smoothing:antialiased;font-size:14px}
#app{max-width:1180px;margin:0 auto;padding:28px 22px 60px}
h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:0 0 14px;font-weight:600;letter-spacing:.01em}
.sub{color:var(--muted);font-size:13px}
.callout{background:color-mix(in srgb,var(--good) 12%,var(--panel));border:1px solid color-mix(in srgb,var(--good) 40%,var(--line));
  border-radius:12px;padding:14px 16px;margin:18px 0}
.callout b{color:var(--good)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.kpi .v{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi .l{color:var(--muted);font-size:12px;margin-top:2px}
.kpi .h{font-size:11px;color:var(--muted);margin-top:6px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:16px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:820px){.grid2{grid-template-columns:1fr}}
.bar-row{display:grid;grid-template-columns:150px 1fr 88px;align-items:center;gap:10px;margin:7px 0;font-size:13px}
.bar-row .name{color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{background:var(--track);border-radius:6px;height:18px;overflow:hidden}
.bar-fill{height:100%;border-radius:6px}
.bar-row .val{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12px;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.dot{width:10px;height:10px;border-radius:3px;display:inline-block}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:12px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.pill{font-size:11px;padding:1px 7px;border-radius:20px;background:var(--track);color:var(--muted)}
.err{color:var(--bad)} .goal{color:var(--muted);max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stack{display:flex;height:26px;border-radius:7px;overflow:hidden;border:1px solid var(--line)}
.stack>div{height:100%}
svg{display:block;width:100%;height:auto;overflow:visible}
.axis{fill:var(--muted);font-size:10px;font-family:var(--mono)}
.themebtn{position:fixed;top:14px;right:16px;background:var(--panel);border:1px solid var(--line);
  color:var(--muted);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px}
.overflow{overflow-x:auto}
.mono{font-family:var(--mono);font-size:12px}
.tl{border-left:2px solid var(--line);margin-left:6px;padding-left:14px}
.tl .ev{margin:8px 0;font-size:12.5px}
.tl .ev time{color:var(--muted);font-family:var(--mono);font-size:11px;margin-right:8px}
</style>`;

const DASHBOARD_JS = `<button class="themebtn" onclick="(function(){var r=document.documentElement;var d=(r.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'))==='dark';r.setAttribute('data-theme',d?'light':'dark')})()">◐ theme</button>
<script>
const R=DATA, CC=['--c1','--c2','--c3','--c4','--c5','--c6'];
const cvar=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const usd=n=>'$'+(n||0).toLocaleString('en-US',{maximumFractionDigits:n<100?2:0});
const tok=n=>n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(Math.round(n||0));
const num=n=>(n||0).toLocaleString('en-US');
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const dt=s=>{try{return new Date(s).toLocaleString('en-GB',{timeZone:'Europe/Berlin',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}catch(e){return s}};
const dayName=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short'});

function barRows(items,label,valOf,fmt,colorIdx){
  const max=Math.max(...items.map(valOf),1);
  return items.map((it,i)=>{
    const v=valOf(it),w=(v/max*100).toFixed(1);
    const col=cvar(CC[colorIdx!=null?colorIdx:i%CC.length]);
    return '<div class="bar-row"><div class="name" title="'+esc(label(it))+'">'+esc(label(it))+'</div>'+
      '<div class="bar-track"><div class="bar-fill" style="width:'+w+'%;background:'+col+'"></div></div>'+
      '<div class="val">'+fmt(v,it)+'</div></div>';
  }).join('');
}

// daily cost column chart (SVG)
function dailyChart(){
  const d=R.byDay; if(!d.length)return'';
  const W=680,H=200,pad=34,bw=Math.min(70,(W-pad*2)/d.length-10);
  const max=Math.max(...d.map(x=>x.cost),1);
  const gap=(W-pad*2)/d.length;
  let bars='',lbls='';
  d.forEach((x,i)=>{
    const h=(x.cost/max)*(H-pad*2);
    const cx=pad+gap*i+gap/2;
    bars+='<rect x="'+(cx-bw/2)+'" y="'+(H-pad-h)+'" width="'+bw+'" height="'+h+'" rx="4" fill="'+cvar('--c1')+'"><title>'+dayName(x.day)+' — '+usd(x.cost)+' · '+x.turns+' turns · '+x.toolCalls+' tools</title></rect>';
    bars+='<text class="axis" x="'+cx+'" y="'+(H-pad-h-5)+'" text-anchor="middle">'+usd(x.cost)+'</text>';
    lbls+='<text class="axis" x="'+cx+'" y="'+(H-pad+14)+'" text-anchor="middle">'+dayName(x.day).replace(/,.*/,'')+'</text>';
  });
  return '<svg viewBox="0 0 '+W+' '+H+'" role="img">'+bars+lbls+'</svg>';
}
// hour-of-day (Berlin) turns
function hourChart(){
  const h=R.byHour,W=680,H=150,pad=26;
  const max=Math.max(...h.map(x=>x.turns),1),gap=(W-pad*2)/24;
  let bars='',lbls='';
  h.forEach((x,i)=>{
    const bh=(x.turns/max)*(H-pad*2),cx=pad+gap*i+gap/2;
    bars+='<rect x="'+(cx-gap*0.38)+'" y="'+(H-pad-bh)+'" width="'+(gap*0.76)+'" height="'+bh+'" rx="2" fill="'+cvar('--c2')+'"><title>'+String(i).padStart(2,'0')+':00 — '+x.turns+' turns · '+usd(x.cost)+'</title></rect>';
    if(i%3===0)lbls+='<text class="axis" x="'+cx+'" y="'+(H-pad+13)+'" text-anchor="middle">'+String(i).padStart(2,'0')+'</text>';
  });
  return '<svg viewBox="0 0 '+W+' '+H+'" role="img">'+bars+lbls+'</svg>';
}
function tokenStack(){
  const t=R.totals.tokens,total=R.totals.rawTokens||1;
  const parts=[['cache-read',t.cacheRead,'--c1'],['cache-write',t.cacheCreation,'--c2'],['output',t.output,'--c3'],['input',t.input,'--c4']];
  const seg=parts.map(p=>'<div style="width:'+(p[1]/total*100)+'%;background:'+cvar(p[2])+'" title="'+p[0]+': '+tok(p[1])+'"></div>').join('');
  const leg=parts.map(p=>'<span><i class="dot" style="background:'+cvar(p[2])+'"></i>'+p[0]+' '+tok(p[1])+'</span>').join('');
  return '<div class="stack">'+seg+'</div><div class="legend">'+leg+'</div>';
}

function render(){
  const t=R.totals,m=R.meta;
  const errRate=t.toolCalls?(t.toolErrors/t.toolCalls*100):0;
  const days=Math.max(1,(new Date(m.until)-new Date(m.since))/864e5);
  // reset evidence
  const ri=m.resetInfo||{};
  const anchor=ri.anchor?(ri.anchor.weekday+' '+ri.anchor.clock+' ('+ri.anchor.tz+')'):'Friday 12:00 (Europe/Berlin)';
  const ev=ri.evidence||(m.limitEvents||[]).filter(e=>/weekly/i.test(e.text)).pop();
  const auto=ri.mode==='auto';
  let resetHtml='<div class="callout"><b>'+(ri.mode==='manual'?'Window (manual --since).':'✓ Weekly quota window '+(auto?'auto-detected':'verified')+'.')+'</b> '+
    'Analysed: <b>'+dt(m.since)+'</b> → now ('+days.toFixed(1)+' days). '+
    (ri.mode==='manual'?'':'This profile\\'s weekly limit resets <b>'+esc(anchor)+'</b>'+
      (ev?' — '+(auto?'derived from':'confirmed by')+' an in-transcript banner: <span class="mono">“'+esc(ev.text)+'”</span> ('+dt(ev.ts)+').':'.'))+'</div>';

  const kpi=(v,l,h)=>'<div class="kpi"><div class="v">'+v+'</div><div class="l">'+l+'</div>'+(h?'<div class="h">'+h+'</div>':'')+'</div>';
  const kpis='<div class="kpis">'+
    kpi(usd(t.cost),'Est. subscription value','pay-go equivalent of this week')+
    kpi(tok(t.rawTokens),'Raw tokens',tok(t.tokens.output)+' generated')+
    kpi(num(t.sessions),'Sessions',num(t.subagents)+' subagents')+
    kpi(num(t.turns),'Assistant turns','API calls billed')+
    kpi(num(t.toolCalls),'Tool calls',t.toolErrors+' errors · '+errRate.toFixed(1)+'%')+
    kpi((t.cost/days).toFixed(0).replace(/^/, '$'),'per day avg',(t.turns/days|0)+' turns/day')+
  '</div>';

  const modelBars=barRows(R.byModel.filter(x=>x.cost>0),x=>x.model,x=>x.cost,(v,it)=>usd(v)+' · '+(v/t.cost*100).toFixed(0)+'%');
  const projBars=barRows(R.byProject,x=>x.project.replace('C--projects-papershift-','').replace('C--',''),x=>x.cost,(v)=>usd(v));

  const toolRows=R.byTool.slice(0,14).map(x=>{
    const rate=x.calls?(x.errors/x.calls*100):0;
    return '<tr><td>'+esc(x.tool)+'</td><td class="n">'+num(x.calls)+'</td><td class="n '+(x.errors?'err':'')+'">'+(x.errors||'')+'</td>'+
      '<td class="n">'+(x.errors?rate.toFixed(1)+'%':'')+'</td></tr>';
  }).join('');

  const sessRows=R.sessions.slice(0,20).map(s=>'<tr>'+
    '<td class="goal" title="'+esc(s.firstPrompt||s.id)+'">'+esc(s.firstPrompt||'(no prompt)')+'</td>'+
    '<td><span class="pill">'+esc(s.project.replace('C--projects-papershift-','').replace('C--',''))+'</span></td>'+
    '<td>'+esc(s.model)+'</td>'+
    '<td class="n">'+usd(s.cost)+'</td><td class="n">'+num(s.turns)+'</td>'+
    '<td class="n">'+num(s.toolCalls)+'</td><td class="n">'+(s.durationMin>60?(s.durationMin/60).toFixed(1)+'h':Math.round(s.durationMin)+'m')+'</td></tr>').join('');

  const tl=(m.limitEvents||[]).slice(0,14).map(e=>'<div class="ev"><time>'+dt(e.ts)+'</time>'+esc(e.text)+(e.count>1?' <span class="pill">×'+e.count+'</span>':'')+'</div>').join('')||'<div class="sub">No limit banners in window.</div>';

  document.getElementById('app').innerHTML=
    '<h1>Subscription Quota Report</h1>'+
    '<div class="sub">Profile <b>'+esc(m.profile)+'</b> · generated '+dt(m.generatedAt)+' · per-turn cutoff (subagents included)</div>'+
    resetHtml+kpis+
    '<div class="panel"><h2>Token composition</h2>'+tokenStack()+
      '<div class="sub" style="margin-top:10px">Cache-read dominates volume but is billed ~0.1× — cost is weighted accordingly.</div></div>'+
    '<div class="panel"><h2>Estimated value by day</h2>'+dailyChart()+'</div>'+
    '<div class="panel"><h2>When it was used — activity by hour (Berlin)</h2>'+hourChart()+'</div>'+
    '<div class="grid2">'+
      '<div class="panel"><h2>By model</h2>'+modelBars+'</div>'+
      '<div class="panel"><h2>By project</h2>'+projBars+'</div>'+
    '</div>'+
    '<div class="grid2">'+
      '<div class="panel"><h2>Tool calls</h2><div class="overflow"><table><thead><tr><th>Tool</th><th class="n">Calls</th><th class="n">Errors</th><th class="n">Rate</th></tr></thead><tbody>'+toolRows+'</tbody></table></div></div>'+
      '<div class="panel"><h2>Usage-limit timeline</h2><div class="tl">'+tl+'</div></div>'+
    '</div>'+
    '<div class="panel"><h2>Top sessions by est. value</h2><div class="overflow"><table><thead><tr><th>Goal (first prompt)</th><th>Project</th><th>Model</th><th class="n">Value</th><th class="n">Turns</th><th class="n">Tools</th><th class="n">Dur</th></tr></thead><tbody>'+sessRows+'</tbody></table></div></div>'+
    '<div class="sub" style="margin-top:18px">Est. value = pay-go API cost of the same tokens (opus 5/25, sonnet 3/15, haiku 1/5 $/1M; cache-read 0.1×, cache-write 1.25×). This is the leverage you got from a flat subscription, not a bill.</div>';
}
render();
</script>`;

if (htmlPath) {
  const html = renderHtml(report);
  writeFileSync(htmlPath, html);
  console.error(`Wrote dashboard → ${htmlPath}`);
}
if (jsonOut) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
if (htmlPath) process.exit(0);

// ── terminal summary ────────────────────────────────────────────────────────────
const fmtTok = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
const usd = (n) => `$${n.toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n);
const t = report.totals;
console.log("═".repeat(76));
console.log(`QUOTA REPORT — profile=${report.meta.profile}`);
console.log(`Window: ${report.meta.since}  →  ${report.meta.until}  (per-turn cutoff)`);
console.log("═".repeat(76));
console.log(`Sessions ${t.sessions} · subagents ${t.subagents} · assistant turns ${t.turns} · tool calls ${t.toolCalls} (${t.toolErrors} errors)`);
console.log(`Raw tokens ${fmtTok(t.rawTokens)}   Est. subscription value ${usd(t.cost)}`);
console.log(`  in ${fmtTok(t.tokens.input)} · out ${fmtTok(t.tokens.output)} · cache-write ${fmtTok(t.tokens.cacheCreation)} · cache-read ${fmtTok(t.tokens.cacheRead)}`);
console.log("─".repeat(76));
console.log("BY MODEL");
for (const m of report.byModel) console.log(`  ${pad(m.model, 26)} ${padL(usd(m.cost), 10)} ${padL(fmtTok(m.rawTokens), 9)} ${padL(m.turns + " turns", 12)}`);
console.log("BY PROJECT");
for (const p of report.byProject) console.log(`  ${pad(p.project, 40)} ${padL(usd(p.cost), 10)} ${padL(p.sessions + "s/" + p.subagents + "a", 9)} ${padL(p.toolCalls + " tc", 9)}`);
console.log("BY DAY");
for (const d of report.byDay) console.log(`  ${pad(d.day, 12)} ${padL(usd(d.cost), 10)} ${padL(fmtTok(d.rawTokens), 9)} ${padL(d.turns + " turns", 12)} ${padL(d.toolCalls + " tc", 9)}`);
console.log("TOP TOOLS");
for (const tl of report.byTool.slice(0, 12)) console.log(`  ${pad(tl.tool, 26)} ${padL(tl.calls, 6)} calls ${tl.errors ? `(${tl.errors} err)` : ""}`);
console.log("═".repeat(76));

// ── HTML dashboard ────────────────────────────────────────────────────────────
function renderHtml(r) {
  const data = JSON.stringify(r);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quota Report — ${r.meta.profile}</title>
${DASHBOARD_CSS}
</head><body>
<div id="app"></div>
<script>const DATA = ${data};</script>
${DASHBOARD_JS}
</body></html>`;
}
