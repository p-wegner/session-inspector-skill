/**
 * Shared quota-accounting core for quota-report.mjs (single profile / window)
 * and quota-multi.mjs (all profiles, all weekly windows, combined total).
 *
 * Parse each transcript ONCE into a compact per-turn event list, then aggregate
 * any [winStart, winEnd) slice of it in memory — so multi-window / multi-profile
 * views never re-read the files. Subagent transcripts are included (they hit the
 * API and burn the same quota). Cost model mirrors token-sinks.mjs.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { classify } from "./prompts.mjs";

// ── pricing ($/1M; cache-read 0.1x in, cache-write 1.25x in) ──────────────────
export const PRICING = [
  { match: /opus/, in: 5, out: 25 },
  { match: /sonnet/, in: 3, out: 15 },
  { match: /haiku/, in: 1, out: 5 },
];
export const priceFor = (m) => PRICING.find((p) => p.match.test(m || "")) || { in: 5, out: 25 };
export const costUsd = (m, t) =>
  (t.i * priceFor(m).in + t.o * priceFor(m).out +
    t.cw * priceFor(m).in * 1.25 + t.cr * priceFor(m).in * 0.1) / 1e6;
export const zt = () => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
export const addT = (a, b) => { a.input += b.input; a.output += b.output; a.cacheCreation += b.cacheCreation; a.cacheRead += b.cacheRead; };
export const rawT = (t) => t.input + t.output + t.cacheCreation + t.cacheRead;
export const modelLabel = (m) => !m ? "(unknown)" : m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[1m\]$/, "");

// ── walk ──────────────────────────────────────────────────────────────────────
export function walkJsonl(dir, acc = []) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, acc);
    else if (e.name.endsWith(".jsonl")) acc.push(p);
  }
  return acc;
}

// ── parse ONE transcript into compact events ──────────────────────────────────
// events: {t:'a',ms,model,tok:{i,o,cw,cr}} | {t:'tc',ms,name} | {t:'te',ms,name} | {t:'p',ms,text}
export function parseFileEvents(path) {
  let lines; try { lines = readFileSync(path, "utf-8").split("\n"); } catch { return null; }
  const idToName = new Map();
  for (const line of lines) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (o.type === "assistant" && Array.isArray(o.message?.content))
      for (const c of o.message.content) if (c.type === "tool_use") idToName.set(c.id, c.name);
  }
  const events = [];
  for (const line of lines) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    const ms = o.timestamp ? new Date(o.timestamp).getTime() : NaN;
    if (!Number.isFinite(ms)) continue;
    if (o.type === "assistant" && o.message) {
      const m = o.message, u = m.usage;
      if (u) events.push({ t: "a", ms, model: m.model || "", tok: {
        i: u.input_tokens || 0, o: u.output_tokens || 0,
        cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0 } });
      if (Array.isArray(m.content)) for (const c of m.content)
        if (c.type === "tool_use") events.push({ t: "tc", ms, name: c.name });
    }
    if (o.type === "user" && Array.isArray(o.message?.content))
      for (const c of o.message.content)
        if (c.type === "tool_result" && c.is_error) events.push({ t: "te", ms, name: idToName.get(c.tool_use_id) || "(unknown)" });
    // human prompts (for per-window session goals)
    if (o.type === "user" && !o.isMeta && !o.isSidechain && o.toolUseResult === undefined) {
      const c = o.message?.content;
      let raw = typeof c === "string" ? c : Array.isArray(c) && !c.some(b => b.type === "tool_result")
        ? c.filter(b => b.type === "text").map(b => b.text).join("\n") : null;
      const cl = raw ? classify(raw) : null;
      if (cl && cl.kind === "human") events.push({ t: "p", ms, text: cl.text.slice(0, 160) });
    }
  }
  return events;
}

// ── usage-limit banner scan (weekly + session) ────────────────────────────────
const LIMIT_RE = /(hit your (weekly|5-hour|usage|session) limit|usage limit reached|Claude (AI )?usage limit|limit will reset|resets? (at|on|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d|Mon|Tue|Wed|Thu|Fri|Sat|Sun))/i;
export function scanLimits(path) {
  const out = [];
  let lines; try { lines = readFileSync(path, "utf-8").split("\n"); } catch { return out; }
  for (const line of lines) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    const m = o.message; const texts = [];
    if (m && Array.isArray(m.content)) for (const c of m.content) if (c.type === "text" && c.text) texts.push(c.text);
    if (m && typeof m.content === "string") texts.push(m.content);
    for (const t of texts) {
      if (/^<task-notification>|^Base directory for this skill:/.test(t)) continue;
      if (t.length > 400 || /node scripts\/|SKILL\.md|analyze-.*-session/.test(t)) continue;
      // genuine banners always contain the word "limit" — this rejects prose like
      // "the fixture auto-resets on teardown" that trips the loose reset alternative
      if (LIMIT_RE.test(t) && /\blimit\b/i.test(t)) out.push({ ms: o.timestamp ? new Date(o.timestamp).getTime() : NaN, ts: o.timestamp, text: t.slice(0, 200).replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}
// collapse a banner list to distinct texts (earliest ts + repeat count), in a window
export function collapseLimits(list, winStart = -Infinity, winEnd = Infinity) {
  const byText = new Map();
  for (const e of list.filter(e => e.ms >= winStart && e.ms < winEnd).sort((a, b) => (a.ts || "").localeCompare(b.ts || ""))) {
    const g = byText.get(e.text);
    if (g) { g.count++; g.lastTs = e.ts; } else byText.set(e.text, { ts: e.ts, lastTs: e.ts, text: e.text, count: 1 });
  }
  return [...byText.values()].sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
}

// ── weekly-reset detection ────────────────────────────────────────────────────
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function parseClock(str) {
  const m = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10); const mi = m[2] ? parseInt(m[2], 10) : 0;
  const pm = /pm/i.test(m[3]);
  if (pm && h !== 12) h += 12; if (!pm && h === 12) h = 0;
  return { h, mi };
}
const clockLabel = (h, mi) => `${((h + 11) % 12) + 1}${mi ? ":" + String(mi).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;

/** Detect a profile's WEEKLY reset boundary (most recent at/before now) from its
 *  own weekly-limit banners. Returns {sinceMs, anchorMs, anchor, evidence} or null. */
export function detectWeeklyReset(limitEvents, tzOffset, nowMs) {
  const berlinToUtc = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h - tzOffset, mi || 0, 0);
  let latest = null;
  for (const e of limitEvents) {
    if (!/hit your weekly limit|weekly limit\b/i.test(e.text)) continue;
    if (!/reset/i.test(e.text) || !e.ts) continue;
    if (!latest || e.ts > latest.ts) latest = e;
  }
  if (!latest) return null;
  const bannerMs = latest.ms;
  const clock = parseClock(latest.text);
  if (!clock) return null;
  let Rms;
  const dm = latest.text.match(/resets?\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/i);
  if (dm && MONTHS[dm[1].toLowerCase()] !== undefined) {
    const bd = new Date(bannerMs); let y = bd.getUTCFullYear();
    const mo = MONTHS[dm[1].toLowerCase()], day = parseInt(dm[2], 10);
    if (mo < bd.getUTCMonth()) y += 1;
    Rms = berlinToUtc(y, mo, day, clock.h, clock.mi);
  } else {
    const b = new Date(bannerMs + tzOffset * 3600e3);
    let cand = berlinToUtc(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), clock.h, clock.mi);
    if (cand <= bannerMs) cand += 24 * 3600e3;
    Rms = cand;
  }
  let bnd = Rms;
  while (bnd > nowMs) bnd -= 7 * 24 * 3600e3;
  while (bnd + 7 * 24 * 3600e3 <= nowMs) bnd += 7 * 24 * 3600e3;
  const bWall = new Date(bnd + tzOffset * 3600e3);
  return { sinceMs: bnd, anchorMs: bnd, anchor: { weekday: WD[bWall.getUTCDay()], clock: clockLabel(clock.h, clock.mi), tz: "Europe/Berlin" }, evidence: latest };
}

/** Generate weekly window boundaries [ {start,end,current} ] covering [dataMinMs, nowMs]
 *  for a given anchor boundary ms. Newest first. Caps to `max` windows. */
export function weeklyWindows(anchorMs, dataMinMs, nowMs, max = 8) {
  const wk = 7 * 24 * 3600e3;
  // slide anchor back to <= dataMin
  let b = anchorMs;
  while (b > dataMinMs) b -= wk;
  const wins = [];
  for (let s = b; s <= nowMs; s += wk) {
    const e = s + wk;
    wins.push({ start: s, end: Math.min(e, nowMs), current: s <= nowMs && nowMs < e });
  }
  return wins.reverse().slice(0, max);
}

// ── aggregate a [winStart,winEnd) slice over file records ─────────────────────
// records: [{ id, profile?, project, isSubagent, events }]
export function aggregate(records, winStart, winEnd, tzOffset, { topSessions = 20 } = {}) {
  const totals = { tokens: zt(), cost: 0, turns: 0, toolCalls: 0, toolErrors: 0, sessions: 0, subagents: 0 };
  const byModel = new Map(), byProject = new Map(), byProfile = new Map(), byDay = new Map(), byTool = new Map();
  const byHour = Array.from({ length: 24 }, () => ({ turns: 0, cost: 0 }));
  const sessions = [];
  const bump = (map, key, init) => { let g = map.get(key); if (!g) { g = init(); map.set(key, g); } return g; };

  for (const r of records) {
    let s = { tokens: zt(), cost: 0, turns: 0, tools: 0, errs: 0, model: "", first: "", last: "", prompt: "" };
    for (const ev of r.events) {
      if (ev.ms < winStart || ev.ms >= winEnd) continue;
      const iso = new Date(ev.ms).toISOString();
      if (!s.first) s.first = iso; s.last = iso;
      if (ev.t === "a") {
        const tt = { input: ev.tok.i, output: ev.tok.o, cacheCreation: ev.tok.cw, cacheRead: ev.tok.cr };
        const c = costUsd(ev.model, ev.tok);
        s.turns++; addT(s.tokens, tt); s.cost += c; if (ev.model && ev.model !== "<synthetic>") s.model = ev.model;
        totals.turns++; addT(totals.tokens, tt); totals.cost += c;
        const day = iso.slice(0, 10);
        const hr = ((new Date(ev.ms).getUTCHours() + tzOffset) % 24 + 24) % 24;
        byHour[hr].turns++; byHour[hr].cost += c;
        const mg = bump(byModel, ev.model, () => ({ tokens: zt(), turns: 0, cost: 0 })); addT(mg.tokens, tt); mg.turns++; mg.cost += c;
        const dg = bump(byDay, day, () => ({ tokens: zt(), cost: 0, turns: 0, toolCalls: 0 })); addT(dg.tokens, tt); dg.cost += c; dg.turns++;
        if (r.profile) { const pf = bump(byProfile, r.profile, () => ({ tokens: zt(), cost: 0, turns: 0, toolCalls: 0, sessions: 0, subagents: 0 })); addT(pf.tokens, tt); pf.cost += c; pf.turns++; }
        const pg = bump(byProject, r.project, () => ({ tokens: zt(), cost: 0, turns: 0, toolCalls: 0, sessions: 0, subagents: 0 })); addT(pg.tokens, tt); pg.cost += c; pg.turns++;
      } else if (ev.t === "tc") {
        s.tools++; totals.toolCalls++;
        bump(byTool, ev.name, () => ({ calls: 0, errors: 0 })).calls++;
        const day = iso.slice(0, 10);
        const dg = byDay.get(day); if (dg) dg.toolCalls++;
        const pg = byProject.get(r.project); if (pg) pg.toolCalls++;
        if (r.profile) { const pf = byProfile.get(r.profile); if (pf) pf.toolCalls++; }
      } else if (ev.t === "te") {
        s.errs++; totals.toolErrors++;
        bump(byTool, ev.name, () => ({ calls: 0, errors: 0 })).errors++;
      } else if (ev.t === "p") {
        if (!s.prompt) s.prompt = ev.text;
      }
    }
    const active = s.first && (s.turns > 0 || s.tools > 0);
    if (!active) continue;
    if (r.isSubagent) { totals.subagents++; const pg = byProject.get(r.project); if (pg) pg.subagents++; if (r.profile) { const pf = byProfile.get(r.profile); if (pf) pf.subagents++; } }
    else {
      totals.sessions++; const pg = byProject.get(r.project); if (pg) pg.sessions++; if (r.profile) { const pf = byProfile.get(r.profile); if (pf) pf.sessions++; }
      sessions.push({ id: r.id, profile: r.profile, project: r.project, model: modelLabel(s.model),
        firstTs: s.first, lastTs: s.last, durationMin: (new Date(s.last) - new Date(s.first)) / 60000,
        turns: s.turns, toolCalls: s.tools, toolErrors: s.errs, cost: s.cost, rawTokens: rawT(s.tokens), firstPrompt: s.prompt });
    }
  }
  const sortCost = (map, extra = () => ({})) => [...map.entries()].map(([k, v]) => ({ key: k, ...v, rawTokens: rawT(v.tokens), ...extra(k, v) })).sort((a, b) => b.cost - a.cost);
  return {
    totals: { ...totals, rawTokens: rawT(totals.tokens) },
    byModel: sortCost(byModel).map(r => ({ model: modelLabel(r.key), turns: r.turns, cost: r.cost, rawTokens: r.rawTokens })),
    byProject: sortCost(byProject).map(r => ({ project: r.key, sessions: r.sessions, subagents: r.subagents, turns: r.turns, toolCalls: r.toolCalls, cost: r.cost, rawTokens: r.rawTokens })),
    byProfile: sortCost(byProfile).map(r => ({ profile: r.key, sessions: r.sessions, subagents: r.subagents, turns: r.turns, toolCalls: r.toolCalls, cost: r.cost, rawTokens: r.rawTokens })),
    byDay: [...byDay.entries()].map(([d, v]) => ({ day: d, turns: v.turns, toolCalls: v.toolCalls, cost: v.cost, rawTokens: rawT(v.tokens) })).sort((a, b) => a.day.localeCompare(b.day)),
    byHour: byHour.map((v, h) => ({ hour: h, turns: v.turns, cost: v.cost })),
    byTool: [...byTool.entries()].map(([name, v]) => ({ tool: name, calls: v.calls, errors: v.errors })).sort((a, b) => b.calls - a.calls),
    sessions: sessions.sort((a, b) => b.cost - a.cost).slice(0, topSessions),
    tokens: totals.tokens,
  };
}
