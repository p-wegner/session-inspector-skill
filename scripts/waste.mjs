#!/usr/bin/env node
/**
 * Where do CONTEXT tokens go — and which are avoidable? Attributes each session's
 * content to buckets (tool_result by tool, Write/Edit args, user prompts/pastes,
 * assistant text, harness injects) and weights every chunk by PERSISTENCE
 * (tokens × turns-it-survives). That matters because agent cost is cache-read
 * dominated: a chunk added EARLY is re-billed on every later turn, so an early
 * 10K dump costs far more than a late one. Then it flags the avoidable waste:
 * re-reading a file already in context, repeated identical Bash output, and
 * Glob/Read leaking into node_modules.
 *
 * Companion to token-sinks.mjs (which gives the billing total per session/project);
 * this explains WHAT inside a session ran up that bill.
 *
 * Token counts use a chars/4 o200k estimate — calibrated within ~1.5% of the
 * token-budget skill's exact tiktoken count; fine for ranking + relative share.
 *
 * Claude transcripts only (richest per-message structure); --provider is accepted
 * for symmetry but non-claude sessions are skipped with a note.
 *
 * Usage:
 *   node scripts/waste.mjs --project slidesmith     # substring: folder / cwd / git remote
 *   node scripts/waste.mjs --days 30
 *   node scripts/waste.mjs --top 20                 # how many single biggest chunks (default 15)
 *   node scripts/waste.mjs --json
 */

import { readFileSync } from "fs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const projectQ = (opt("--project", "") || "").toLowerCase();
const days = parseInt(opt("--days", "0"), 10);
const top = parseInt(opt("--top", "15"), 10);
const asJson = flag("--json");
const windowStartMs = days > 0 ? Date.now() - days * 86400000 - 86400000 : 0;

const TOK = (s) => Math.ceil((s || "").length / 4);
const NODE_MODULES = /node_modules/;

const buckets = new Map();
const add = (k, tok, wtok) => { const b = buckets.get(k) || { tok: 0, wtok: 0, n: 0, max: 0 }; b.tok += tok; b.wtok += wtok; b.n++; b.max = Math.max(b.max, tok); buckets.set(k, b); };
const bigItems = [], readsByFile = new Map(), bashByCmd = new Map();
let totalTok = 0, totalWtok = 0, sessions = 0, nmLeakTok = 0, nmLeakN = 0;

const all = discover("claude");
for (const s of all) {
  if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
  let content; try { content = readFileSync(s.path, "utf-8"); } catch { continue; }
  const meta = extractMeta("claude", content);
  const id = projectIdentity(meta.cwd || "");
  const folder = basename(dirname(s.path));
  if (projectQ && ![folder, meta.cwd, id.project, id.projectKey].join(" ").toLowerCase().includes(projectQ)) continue;

  const lines = content.split("\n");
  let N = 0;
  for (const ln of lines) { if (!ln.trim()) continue; let o; try { o = JSON.parse(ln); } catch { continue; } if (o.type === "assistant") N++; }
  if (N < 3) continue;
  sessions++;
  let turn = 0; const toolById = new Map();
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const remain = Math.max(1, N - turn);
    const msg = o.message;
    if (o.type === "assistant") {
      turn++;
      for (const b of msg?.content || []) {
        if (b.type === "text" && b.text) { const t = TOK(b.text); add("assistant_text", t, t * remain); totalTok += t; totalWtok += t * remain; }
        else if (b.type === "tool_use") {
          toolById.set(b.id, { name: b.name, cmd: b.input?.command || b.input?.file_path || b.input?.path || b.input?.pattern || "" });
          const t = TOK(JSON.stringify(b.input || {}));
          const kind = (b.name === "Write" || b.name === "Edit" || b.name === "MultiEdit") ? `toolargs:${b.name}` : "toolargs:other";
          add(kind, t, t * remain); totalTok += t; totalWtok += t * remain;
        }
      }
    } else if (o.type === "user") {
      const c = msg?.content;
      const handle = (raw, isErr, tuid) => {
        const text = Array.isArray(raw) ? raw.map((x) => x.text || "").join(" ") : String(raw || "");
        const t = TOK(text);
        const ti = toolById.get(tuid) || { name: "?", cmd: "" };
        const kind = isErr ? `tool_error:${ti.name}` : `tool_result:${ti.name}`;
        add(kind, t, t * remain); totalTok += t; totalWtok += t * remain;
        if (t > 2000) bigItems.push({ kind, tok: t, wtok: t * remain, where: ti.cmd, snip: text.replace(/\s+/g, " ").slice(0, 80) });
        if (ti.name === "Read" && ti.cmd) { const r = readsByFile.get(ti.cmd) || { n: 0, tok: 0 }; r.n++; r.tok += t; readsByFile.set(ti.cmd, r); }
        if (ti.name === "Bash" && ti.cmd) { const r = bashByCmd.get(ti.cmd) || { n: 0, tok: 0 }; r.n++; r.tok += t; bashByCmd.set(ti.cmd, r); }
        if ((ti.name === "Glob" || ti.name === "Read" || ti.name === "Bash") && NODE_MODULES.test(text)) { nmLeakTok += t; nmLeakN++; }
      };
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === "tool_result") handle(b.content, b.is_error, b.tool_use_id);
          else if (b.type === "text" && b.text) {
            const t = TOK(b.text);
            const kind = b.text.startsWith("<") ? "harness_inject" : (t > 1200 ? "user_paste" : "user_prompt");
            add(kind, t, t * remain); totalTok += t; totalWtok += t * remain;
            if (t > 3000) bigItems.push({ kind: "user_paste", tok: t, wtok: t * remain, where: "", snip: b.text.replace(/\s+/g, " ").slice(0, 80) });
          }
        }
      } else if (typeof c === "string") {
        const t = TOK(c);
        const kind = c.startsWith("<") ? "harness_inject" : (t > 1200 ? "user_paste" : "user_prompt");
        add(kind, t, t * remain); totalTok += t; totalWtok += t * remain;
        if (t > 3000) bigItems.push({ kind: "user_paste", tok: t, wtok: t * remain, where: "", snip: c.replace(/\s+/g, " ").slice(0, 80) });
      }
    }
  }
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(Math.round(n));
const pct = (x, tot) => tot ? (100 * x / tot).toFixed(1) + "%" : "0%";
const dupReads = [...readsByFile.entries()].filter(([, r]) => r.n >= 2).map(([f, r]) => ({ f, n: r.n, waste: Math.round(r.tok * (r.n - 1) / r.n) })).sort((a, b) => b.waste - a.waste);
const dupBash = [...bashByCmd.entries()].filter(([, r]) => r.n >= 3).map(([c, r]) => ({ c, n: r.n, waste: Math.round(r.tok * (r.n - 1) / r.n) })).sort((a, b) => b.waste - a.waste);
const rows = [...buckets.entries()].sort((a, b) => b[1].wtok - a[1].wtok);
bigItems.sort((a, b) => (b.wtok || b.tok) - (a.wtok || a.tok));

if (asJson) {
  console.log(JSON.stringify({
    scope: { project: projectQ || "(all)", days: days || "all" }, sessions, totalTok, totalWtok,
    byKind: rows.map(([k, b]) => ({ kind: k, tok: b.tok, weightedTok: b.wtok, n: b.n, max: b.max })),
    topChunks: bigItems.slice(0, top), dupReads: dupReads.slice(0, 15), dupBash: dupBash.slice(0, 15),
    nodeModulesLeak: { tok: nmLeakTok, n: nmLeakN },
  }, null, 2));
  process.exit(0);
}

if (!sessions) { console.log("\nNo matching Claude sessions.\n"); process.exit(0); }
console.log(`\nContext-token waste — project:${projectQ || "(all)"}  window:${days || "all"}  (Claude)`);
console.log(`${sessions} sessions · unique content ≈ ${fmt(totalTok)} tok · persistence-weighted ≈ ${fmt(totalWtok)} (≈ cache-read pressure)\n`);
const P = (s, w) => String(s).padStart(w);
console.log("BY KIND (sorted by persistence-weighted = the real driver)");
console.log("  " + "kind".padEnd(24) + P("raw", 7) + P("raw%", 7) + P("weighted", 10) + P("wt%", 7) + P("n", 6) + P("max", 7));
for (const [k, b] of rows.slice(0, 16)) console.log("  " + k.padEnd(24) + P(fmt(b.tok), 7) + P(pct(b.tok, totalTok), 7) + P(fmt(b.wtok), 10) + P(pct(b.wtok, totalWtok), 7) + P(b.n, 6) + P(fmt(b.max), 7));

console.log(`\nTOP ${top} SINGLE MOST EXPENSIVE CHUNKS (persistence-weighted)`);
for (const it of bigItems.slice(0, top)) console.log(`  ${P(fmt(it.tok), 6)} tok  w=${P(fmt(it.wtok || it.tok), 6)}  ${it.kind.padEnd(20)} ${(it.where || "").slice(-38).padEnd(38)} ${it.snip}`);

console.log(`\nAVOIDABLE — re-reading files already in context (top 12)`);
for (const d of dupReads.slice(0, 12)) console.log(`  ${(d.n + "×").padStart(4)}  waste≈${P(fmt(d.waste), 6)}  ${d.f.slice(-66)}`);
console.log(`  → dup-read waste (sum): ${fmt(dupReads.reduce((a, d) => a + d.waste, 0))} tok`);

if (dupBash.length) {
  console.log(`\nAVOIDABLE — repeated identical Bash output (≥3×, top 8)`);
  for (const d of dupBash.slice(0, 8)) console.log(`  ${(d.n + "×").padStart(4)}  waste≈${P(fmt(d.waste), 6)}  ${d.c.replace(/\s+/g, " ").slice(0, 60)}`);
}
console.log(`\nAVOIDABLE — node_modules leaked into Glob/Read/Bash output: ${fmt(nmLeakTok)} tok across ${nmLeakN} results`);
console.log("");
