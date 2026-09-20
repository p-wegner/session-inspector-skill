#!/usr/bin/env node
/**
 * Aggregate token usage across MANY Claude + Codex sessions over a time window
 * and rank the biggest "token sinks" — answers "what burned the most tokens in
 * the last N days" without hand-looping the per-session analyzers.
 *
 * Companion to analyze-{claude,codex}-session.mjs (those debug ONE session);
 * this one fans out over all sessions, tallies tokens, and ranks. It is the
 * cheap path for the session-inspector skill's "biggest token sinks" query:
 * stat-filter by mtime FIRST, parse only the files inside the window.
 *
 * Token accounting (Claude): each assistant turn's usage is a separate billed
 * API call, so we SUM input/output/cache_creation/cache_read across turns.
 * cache_read dominates raw counts but is ~0.1x price — so we also compute an
 * estimated USD cost with per-model pricing, which is the truer "sink" ranking.
 *
 * Pricing $/1M (input / output), cache_read ~0.1x input, cache_write ~1.25x input:
 *   opus  5 / 25   sonnet 3 / 15   haiku 1 / 5   (claude-api skill, 2026-05-26)
 * Codex tokens are counted but not costed (different provider/pricing).
 *
 * Usage:
 *   node scripts/token-sinks.mjs                      # last 7 days, ranked by cost
 *   node scripts/token-sinks.mjs --days 14            # change the window
 *   node scripts/token-sinks.mjs --by project         # group by cwd/project (default: session)
 *   node scripts/token-sinks.mjs --by day             # group by calendar day
 *   node scripts/token-sinks.mjs --by model           # group by model
 *   node scripts/token-sinks.mjs --provider claude    # claude | codex | all (default all)
 *   node scripts/token-sinks.mjs --sort tokens        # cost (default) | tokens | output
 *   node scripts/token-sinks.mjs --top 30             # rows to show (default 20)
 *   node scripts/token-sinks.mjs --json               # machine-readable
 */

import { readFileSync } from "fs";
import { basename, dirname } from "path";
import { discover } from "./lib/sessions.mjs";
import { reach } from "./lib/reach.mjs";
import { refuse, declareUnsupported } from "./lib/harness.mjs";
import { costUsdTotals } from "./lib/quota.mjs";
import { firstRowOf, lateOutput } from "./lib/usage.mjs";
import { padTail } from "./lib/chunk-kind.mjs";

// ── pricing ────────────────────────────────────────────────────────────────
// Pricing lives in lib/quota.mjs (one table for every cost-reporting tool).
const costUsd = costUsdTotals;
const zeroTokens = () => ({ input: 0, output: 0, cacheCreation: 0, cacheCreation1h: 0, cacheRead: 0 });
function addTokens(a, b) {
  a.input += b.input;
  a.output += b.output;
  a.cacheCreation += b.cacheCreation;
  a.cacheCreation1h += b.cacheCreation1h || 0;
  a.cacheRead += b.cacheRead;
}
const rawTotal = (t) => t.input + t.output + t.cacheCreation + t.cacheRead;

// ── parse one Claude transcript (assistant-turn usage) ───────────────────────
function parseClaude(path) {
  const tokens = zeroTokens();
  let model = "";
  let firstTs = "";
  let lastTs = "";
  let assistantTurns = 0;
  const seen = new Set(); // one usage record per API call, not per content-block row
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { reach.badLine(); continue; }
    if (obj.timestamp) {
      if (!firstTs) firstTs = obj.timestamp;
      lastTs = obj.timestamp;
    }
    if (obj.type !== "assistant") continue;
    const msg = obj.message;
    if (!msg) continue;
    if (msg.model && msg.model !== "<synthetic>") model = msg.model;
    const u = msg.usage;
    if (u && !firstRowOf(msg, seen)) { tokens.output += lateOutput(msg, seen); continue; }
    if (u) {
      assistantTurns++;
      tokens.input += u.input_tokens || 0;
      tokens.output += u.output_tokens || 0;
      tokens.cacheCreation += u.cache_creation_input_tokens || 0;
      tokens.cacheCreation1h += u.cache_creation?.ephemeral_1h_input_tokens || 0;
      tokens.cacheRead += u.cache_read_input_tokens || 0;
    }
  }
  return { tokens, model, firstTs, lastTs, assistantTurns };
}

// ── parse one Codex transcript (token_count events = cumulative; take last) ──
function parseCodex(path) {
  const tokens = zeroTokens();
  let model = "";
  let firstTs = "";
  let lastTs = "";
  let cwd = "";
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { reach.badLine(); continue; }
    if (obj.timestamp) {
      if (!firstTs) firstTs = obj.timestamp;
      lastTs = obj.timestamp;
    }
    const p = obj.payload;
    if (!p) continue;
    if (obj.type === "session_meta" && p.cwd) cwd = p.cwd;
    if (obj.type === "turn_context" && p.model) model = p.model;
    if (obj.type === "event_msg" && p.type === "token_count" && p.info?.total_token_usage) {
      const t = p.info.total_token_usage;
      // cumulative — overwrite (last wins)
      tokens.input = t.input_tokens || 0;
      tokens.output = t.output_tokens || 0;
      tokens.cacheRead = t.cached_input_tokens || 0;
    }
  }
  return { tokens, model: model || "codex", firstTs, lastTs, cwd };
}

// ── collect sessions in the window ───────────────────────────────────────────
// Discovery is lib/sessions.mjs's, the same one sync uses: every profile, every
// codex home (CODEX_HOME / CODEX_HOMES), and the nested subagent and workflow
// transcripts. Those nested files carry their own API usage, which is billed and
// never appears in the parent's transcript; this tool used to walk the top level
// only, so its total left out subagent spend while quota-report included it.
// A nested transcript is attributed to its parent session.
// The project dir a Claude transcript sits under: <base>/<slug>/<uuid>.jsonl for a
// main transcript, <base>/<slug>/<uuid>/subagents/... for a nested one.
function slugOf(d) {
  const p = d.kind === "main" ? d.path : d.path.slice(0, d.path.indexOf(d.parentSessionId) + d.parentSessionId.length);
  return basename(dirname(p));
}

function collect(provider, cutoffMs) {
  const out = [];
  for (const d of discover(provider)) {
    if (d.provider === "copilot") continue; // no usage records - the reach line names it (lib/harness.mjs)
    reach.found(d.provider, d.profile, d.kind === "main" ? d.sessionId : d.parentSessionId);
    if (d.mtime.getTime() < cutoffMs) { reach.exclude(`outside --days ${days}`); continue; }
    reach.file(d.path);
    const parsed = d.provider === "claude" ? parseClaude(d.path) : parseCodex(d.path);
    const sessionId = d.kind === "main" ? d.sessionId : d.parentSessionId;
    out.push({
      provider: d.provider,
      sessionId,
      kind: d.kind,
      project: d.provider === "claude" ? slugOf(d) : (parsed.cwd || "(unknown)"),
      path: d.path,
      modified: d.mtime,
      ...parsed,
    });
  }
  return out;
}

// ── formatting ───────────────────────────────────────────────────────────────
function fmtTok(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
const fmtUsd = (n) => `$${n.toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n);

// ── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const days = parseInt(flag("days", "7"), 10);
const by = flag("by", "session"); // session | project | day | model | provider
const provider = flag("provider", "all"); // claude | codex | all
const sort = flag("sort", "cost"); // cost | tokens | output
const top = parseInt(flag("top", "20"), 10);
const jsonOut = args.includes("--json");

const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

if (provider !== "all") refuse("token-sinks", provider);
reach.begin("token-sinks", { days, provider, by, project: undefined });
if (provider === "all") declareUnsupported("token-sinks", reach);
const sessions = collect(provider === "all" ? "all" : provider, cutoffMs);

// attach per-session cost (codex left at 0 — different provider/pricing)
for (const s of sessions) {
  s.cost = s.provider === "claude" ? costUsd(s.model, s.tokens) : 0;
  s.rawTokens = rawTotal(s.tokens);
}

// group
const keyOf = (s) => {
  switch (by) {
    case "project": return s.project;
    case "day": return (s.lastTs || s.modified.toISOString()).slice(0, 10);
    case "model": return s.model || "(unknown)";
    case "provider": return s.provider;
    default: return `${s.provider}:${s.sessionId.slice(0, 8)}`;
  }
};
const groups = new Map();
for (const s of sessions) {
  const k = keyOf(s);
  let g = groups.get(k);
  if (!g) {
    g = { key: k, tokens: zeroTokens(), cost: 0, sessionIds: new Set(), transcripts: 0, provider: s.provider, model: s.model, project: s.project };
    groups.set(k, g);
  }
  addTokens(g.tokens, s.tokens);
  g.cost += s.cost;
  g.sessionIds.add(`${s.provider}:${s.sessionId}`);
  g.transcripts++;
  if (g.provider !== s.provider) g.provider = "mixed";
};

let rows = [...groups.values()].map(({ sessionIds, ...g }) => ({ ...g, sessions: sessionIds.size, rawTokens: rawTotal(g.tokens) }));
const sortKey = sort === "tokens" ? (r) => r.rawTokens : sort === "output" ? (r) => r.tokens.output : (r) => r.cost;
rows.sort((a, b) => sortKey(b) - sortKey(a));

// totals
const totals = {
  tokens: zeroTokens(), cost: 0,
  sessions: new Set(sessions.map((s) => `${s.provider}:${s.sessionId}`)).size,
  transcripts: sessions.length,
  nestedTranscripts: sessions.filter((s) => s.kind !== "main").length,
};
for (const s of sessions) { addTokens(totals.tokens, s.tokens); totals.cost += s.cost; }

if (jsonOut) {
  reach.shown(Math.min(top, rows.length), rows.length);
  console.log(JSON.stringify({ contract: "session-inspector/token-sinks/1", days, by, provider, sort, totals, rows: rows.slice(0, top), reach: reach.toJSON() }, null, 2));
  process.exit(0);
}

console.log("═".repeat(78));
console.log(`TOKEN SINKS — last ${days}d · grouped by ${by} · sorted by ${sort} · provider=${provider}`);
console.log("═".repeat(78));
console.log(
  `Sessions in window: ${totals.sessions} (+${totals.nestedTranscripts} subagent/workflow transcripts, costed to their parent; ${provider === "all" ? "Claude + Codex" : provider}, transcript mtime within ${days}d)   ` +
  `Raw tokens: ${fmtTok(rawTotal(totals.tokens))}   ` +
  `Est. cost (claude): ${fmtUsd(totals.cost)}`,
);
console.log(
  `  in ${fmtTok(totals.tokens.input)} · out ${fmtTok(totals.tokens.output)} · ` +
  `cache-write ${fmtTok(totals.tokens.cacheCreation)} · cache-read ${fmtTok(totals.tokens.cacheRead)}`,
);
reach.shown(Math.min(top, rows.length), rows.length);
console.log(reach.line());
console.log("─".repeat(78));
const keyW = by === "project" ? 48 : 22;
console.log(
  `${pad(by, keyW)} ${padL("cost", 9)} ${padL("out", 8)} ${padL("in", 8)} ` +
  `${padL("cWrite", 8)} ${padL("cRead", 9)} ${padL("sess", 5)}`,
);
console.log("─".repeat(78));
for (const r of rows.slice(0, top)) {
  let label = r.key;
  if (by === "session") label = `${r.provider === "codex" ? "cx" : "cc"}:${r.key.split(":")[1]} ${(r.project.match(/ak-(\d+)/) || [, ""])[1] ? "#" + r.project.match(/ak-(\d+)/)[1] : ""}`.trim();
  console.log(
    `${by === "project" ? padTail(label, keyW) : pad(label, keyW)} ${padL(fmtUsd(r.cost), 9)} ${padL(fmtTok(r.tokens.output), 8)} ` +
    `${padL(fmtTok(r.tokens.input), 8)} ${padL(fmtTok(r.tokens.cacheCreation), 8)} ` +
    `${padL(fmtTok(r.tokens.cacheRead), 9)} ${padL(r.sessions, 5)}`,
  );
}
console.log("═".repeat(78));
console.log(
  "Note: cost = est. USD from per-model pricing (list prices in lib/quota.mjs; cache-read 0.1x, 0.025x on Fable 5.1; cache-write 2x for 1h-cache turns, 1.25x otherwise).\n" +
  "      Codex sessions counted in raw tokens but not costed (different pricing).",
);
