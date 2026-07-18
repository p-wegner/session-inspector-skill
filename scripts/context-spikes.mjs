#!/usr/bin/env node
/**
 * CONTEXT SPIKES — the single injections that suddenly bloat the context, and
 * WHY each one is inefficient (so you can fix the source, not just observe it).
 *
 * Agent cost is cache-read dominated: a big chunk that lands EARLY is re-billed
 * on every later turn (tokens × turns-survived = its persistence weight). Most
 * such chunks are one tool_result — a huge file Read, a verbose command dump, a
 * blob of JSON, node_modules noise, a log wall. This script finds them, sizes
 * them, weights them by persistence, and CLASSIFIES the likely reason it was
 * expensive, each with a concrete remediation:
 *
 *   huge-file        Read a large file whole            → read a range / grep first
 *   verbose-output   noisy command dump                 → quiet flag / head / redirect
 *   node-modules     dependency dir leaked into output  → exclude node_modules from the glob/read
 *   log-wall         many repeated log lines             → raise log level / filter
 *   long-lines       minified / few newlines / huge      → don't inline; point at the file
 *   json-blob        large JSON payload                 → jq-select the fields you need
 *   repeated         same read/output already in context → reuse; don't re-fetch
 *   big-tool-result  large result, no clearer class      → paginate / narrow the query
 *   user-paste       large pasted block from the human   → attach a file / trim
 *
 * Companion to waste.mjs (which buckets ALL content by kind) and
 * context-growth.mjs (the growth curve). This one is spike-first: it names the
 * few concrete injections whose source you can change to cut the most tokens.
 *
 * chars/4 o200k token estimate (~1.5% of exact tiktoken); fine for ranking.
 * Claude transcripts only.
 *
 * Usage:
 *   node scripts/context-spikes.mjs --project papershift   # substring: folder / cwd / git remote
 *   node scripts/context-spikes.mjs --cwd                  # only sessions whose cwd is the current dir
 *   node scripts/context-spikes.mjs --days 14              # window (default 14)
 *   node scripts/context-spikes.mjs --min 5000             # min tokens to count as a spike (default 5000)
 *   node scripts/context-spikes.mjs --session 75895475     # focus ONE session
 *   node scripts/context-spikes.mjs --by class|tool|file   # aggregate view (default: ranked spikes)
 *   node scripts/context-spikes.mjs --top 25
 *   node scripts/context-spikes.mjs --json
 */

import { readFileSync } from "fs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const projectQ = (opt("--project", "") || "").toLowerCase();
const cwdOnly = flag("--cwd");
const sessionQ = (opt("--session", "") || "").toLowerCase();
const days = parseInt(opt("--days", "14"), 10);
const minTok = parseInt(opt("--min", "5000"), 10);
const by = opt("--by", "");
const top = parseInt(opt("--top", "20"), 10);
const asJson = flag("--json");
const HERE = process.cwd().replace(/\\/g, "/").toLowerCase();
const windowStartMs = days > 0 ? Date.now() - days * 86400000 : 0;

const TOK = (s) => Math.ceil((s || "").length / 4);

/** Classify why a large injection is expensive + how to fix it. */
function classify(text, toolName, where, seenBefore) {
  const lines = text.split("\n");
  const nl = lines.length;
  const avgLine = nl ? text.length / nl : text.length;
  const lc = text.toLowerCase();
  if (seenBefore) return { cls: "repeated", fix: "reuse the copy already in context; don't re-fetch" };
  if (/node_modules|\.venv|site-packages|vendor\/bundle|dist\//.test(lc))
    return { cls: "node-modules", fix: "exclude dependency dirs from the glob/read" };
  // log wall: many lines, lots repeat a timestamp/level token
  const logHits = (text.match(/\b(DEBUG|INFO|WARN|ERROR|TRACE)\b|\d{2}:\d{2}:\d{2}[.,]\d+|\[\d{4}-\d{2}-\d{2}/g) || []).length;
  if (nl > 80 && logHits > nl * 0.3)
    return { cls: "log-wall", fix: "raise the log level / grep for the lines you need" };
  if (toolName === "Read") return { cls: "huge-file", fix: "Read a line range, or grep the file first" };
  if (toolName === "Bash") return { cls: "verbose-output", fix: "add a quiet flag / pipe to head / redirect noise" };
  if ((toolName === "Glob" || toolName === "Grep") && nl > 200)
    return { cls: "verbose-output", fix: "narrow the pattern / add a path filter / head the results" };
  // representation smells (any tool)
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && text.length > 4000)
    return { cls: "json-blob", fix: "select only the fields you need (jq / --format)" };
  if (avgLine > 400 && nl < 30)
    return { cls: "long-lines", fix: "minified/one-line blob — point at the file, don't inline it" };
  return { cls: "big-tool-result", fix: "paginate / narrow the query so less lands in context" };
}

const spikes = [];
const byClass = new Map(), byTool = new Map(), byFile = new Map(), bySession = new Map();
let sessionsScanned = 0, totalSpikeTok = 0, totalSpikeWtok = 0;

const bump = (m, k, tok, wtok) => { const g = m.get(k) || { n: 0, tok: 0, wtok: 0 }; g.n++; g.tok += tok; g.wtok += wtok; m.set(k, g); };

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

  const lines = content.split("\n");
  let N = 0;
  for (const ln of lines) { if (!ln.trim()) continue; let o; try { o = JSON.parse(ln); } catch { continue; } if (o.type === "assistant") N++; }
  if (N < 2) continue;
  sessionsScanned++;
  const sid = s.sessionId.slice(0, 8);
  let turn = 0; const toolById = new Map(); const seen = new Set();
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const remain = Math.max(1, N - turn);
    const msg = o.message;
    if (o.type === "assistant") {
      turn++;
      for (const b of msg?.content || [])
        if (b.type === "tool_use")
          toolById.set(b.id, { name: b.name, where: b.input?.file_path || b.input?.path || b.input?.pattern || b.input?.command || "" });
    } else if (o.type === "user") {
      const c = msg?.content;
      const consider = (text, toolName, where, isPaste) => {
        const tok = TOK(text); if (tok < minTok) return;
        const sig = (where || text.slice(0, 120));
        const seenBefore = seen.has(sig); seen.add(sig);
        const { cls, fix } = isPaste ? { cls: "user-paste", fix: "attach as a file / trim to the relevant part" } : classify(text, toolName, where, seenBefore);
        const wtok = tok * remain;
        spikes.push({ sid, project: id.project || folder, turn, tool: toolName, cls, fix,
          tok, wtok, remain, where: (where || "").slice(-64), snip: text.replace(/\s+/g, " ").slice(0, 70) });
        totalSpikeTok += tok; totalSpikeWtok += wtok;
        bump(byClass, cls, tok, wtok); bump(byTool, toolName, tok, wtok);
        if (where) bump(byFile, where, tok, wtok);
        bump(bySession, sid, tok, wtok);
      };
      if (Array.isArray(c)) for (const b of c) {
        if (b.type === "tool_result") {
          const text = Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(" ") : String(b.content || "");
          const ti = toolById.get(b.tool_use_id) || { name: "?", where: "" };
          consider(text, ti.name, ti.where, false);
        } else if (b.type === "text" && b.text && !b.text.startsWith("<")) {
          consider(b.text, "user", "", true);
        }
      } else if (typeof c === "string" && !c.startsWith("<")) consider(c, "user", "", true);
    }
  }
}

spikes.sort((a, b) => b.wtok - a.wtok);
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(Math.round(n));
const rows = (m) => [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.wtok - a.wtok);

if (asJson) {
  console.log(JSON.stringify({
    scope: { project: projectQ || (cwdOnly ? HERE : "(all)"), days: days || "all", minTok },
    totals: { sessionsScanned, spikes: spikes.length, tok: totalSpikeTok, weightedTok: totalSpikeWtok },
    byClass: rows(byClass), byTool: rows(byTool),
    byFile: rows(byFile).slice(0, 40), bySession: rows(bySession).slice(0, 40),
    spikes: spikes.slice(0, 200),
  }, null, 2));
  process.exit(0);
}

console.log(`\nContext spikes — project:${projectQ || (cwdOnly ? "(cwd)" : "(all)")}  window:${days || "all"}d  min:${fmt(minTok)}tok  (Claude)`);
if (!sessionsScanned) { console.log("No matching Claude sessions in window.\n"); process.exit(0); }
console.log(`${sessionsScanned} sessions · ${spikes.length} spikes · raw ≈ ${fmt(totalSpikeTok)} tok · persistence-weighted ≈ ${fmt(totalSpikeWtok)} (cache-read pressure)\n`);

const P = (s, w) => String(s).padStart(w);
if (by === "class" || by === "tool" || by === "file") {
  const m = by === "class" ? byClass : by === "tool" ? byTool : byFile;
  const label = by === "file" ? "file/where" : by;
  console.log(`BY ${by.toUpperCase()} (sorted by persistence-weighted)`);
  console.log("  " + label.padEnd(by === "file" ? 60 : 16) + P("n", 5) + P("raw", 8) + P("weighted", 10));
  for (const r of rows(m).slice(0, top))
    console.log("  " + String(by === "file" ? r.key.slice(-60) : r.key).padEnd(by === "file" ? 60 : 16) + P(r.n, 5) + P(fmt(r.tok), 8) + P(fmt(r.wtok), 10));
  console.log("");
  process.exit(0);
}

console.log(`BY CLASS (why the spike was expensive)`);
console.log("  " + "class".padEnd(16) + P("n", 5) + P("raw", 8) + P("weighted", 10) + "  fix");
for (const r of rows(byClass)) {
  const ex = spikes.find((s) => s.cls === r.key);
  console.log("  " + r.key.padEnd(16) + P(r.n, 5) + P(fmt(r.tok), 8) + P(fmt(r.wtok), 10) + "  " + (ex ? ex.fix : ""));
}

console.log(`\nTOP ${top} SPIKES (persistence-weighted)`);
console.log("  " + "sess".padEnd(9) + P("raw", 6) + P("w", 7) + "  " + "class".padEnd(15) + "tool".padEnd(8) + "where");
for (const s of spikes.slice(0, top))
  console.log("  " + s.sid.padEnd(9) + P(fmt(s.tok), 6) + P(fmt(s.wtok), 7) + "  " + s.cls.padEnd(15) + (s.tool || "").padEnd(8) + (s.where || s.snip).slice(-52));
console.log(`\n→ Fix the recurring classes at the source (log level, quiet flags, ranged reads, jq-select).`);
console.log(`  --by file shows which exact files/commands to target; --by class the biggest lever.\n`);
