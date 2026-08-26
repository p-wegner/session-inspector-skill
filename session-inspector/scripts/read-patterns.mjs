#!/usr/bin/env node
/**
 * read-patterns.mjs — HOW do agents read files, and does progressive disclosure keep up?
 *
 * Claude Code auto-loads a nested CLAUDE.md (and path-scoped .claude/rules) only when the agent
 * touches a file in that subtree through Read/Edit/Write. Agents increasingly use the Grep/Glob
 * tools and shell readers (`cat`, `sed -n`, `grep`, `rg`, `head`, `Get-Content`) instead — those
 * touch the same files and trigger nothing. This script measures both halves across many sessions:
 *
 *   1. read style per model: Read full vs partial (offset/limit), Grep/Glob, shell read-verbs
 *   2. disclosure gap: per (session × guidance dir), was the dir touched, by which tool first, and
 *      did a `nested_memory` attachment (Claude Code's own injection record) ever arrive?
 *
 * Guidance dirs = subdirectories carrying a CLAUDE.md, discovered from the session's cwd on disk
 * (when it still exists) plus every nested_memory path seen in the corpus for that repo.
 *
 *   node scripts/read-patterns.mjs --project kanban                 # sessions whose dir/cwd matches
 *   node scripts/read-patterns.mjs --project kanban --worktrees     # only worktree (board builder) sessions
 *   node scripts/read-patterns.mjs --days 30 --min-turns 5 --json
 *   node scripts/read-patterns.mjs --session <id-prefix>           # dump one session's record
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { claudeProjectDirs } from "./lib/config.mjs";

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days || 90);
const MIN_TURNS = Number(args["min-turns"] || 5);
const since = Date.now() - DAYS * 864e5;
const READ_VERB = /(^|[\s;&|(])(cat|head|tail|sed|grep|rg|awk|less|more|bat|wc|Get-Content|gc|Select-String|sls|type)\b/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", "dist", "build", ".claude"]);

// ---------- collect sessions ----------
const sessions = [];
for (const home of claudeProjectDirs()) {
  let dirs; try { dirs = readdirSync(home); } catch { continue; }
  for (const d of dirs) {
    if (args.project && !d.toLowerCase().includes(String(args.project).toLowerCase())) continue;
    if (args.worktrees && !/worktree/i.test(d)) continue;
    let files; try { files = readdirSync(join(home, d)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = join(home, d, f);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.mtimeMs < since) continue;
      if (args.session && !f.startsWith(String(args.session))) continue;
      const s = parseSession(p, d);
      if (s) sessions.push(s);
    }
  }
}

// guidance dirs per repo root (cwd) — from disk + from nested_memory evidence
const guidanceByCwd = new Map();
for (const s of sessions) {
  if (!s.cwd) continue;
  if (!guidanceByCwd.has(s.cwd)) guidanceByCwd.set(s.cwd, new Set(scanGuidanceDirs(s.cwd)));
  for (const p of s.nestedPaths) { const d = dirname(p); if (d !== s.cwd) guidanceByCwd.get(s.cwd).add(norm(d)); }
}

// ---------- classify touches ----------
for (const s of sessions) {
  s.touches = [];
  const dirs = [...(guidanceByCwd.get(s.cwd) || [])];
  for (const gd of dirs) {
    const inDir = (p) => p && (norm(p) === gd || norm(p).startsWith(gd + "/"));
    let first = null, firstReadEdit = null;
    for (const t of s.paths) { // {seq, tool, path}
      if (!inDir(t.path)) continue;
      if (!first) first = t;
      if (!firstReadEdit && ["Read", "Edit", "Write", "MultiEdit"].includes(t.tool)) firstReadEdit = t;
    }
    if (!first) continue;
    const injected = s.nestedPaths.some((p) => norm(dirname(p)) === gd);
    s.touches.push({ dir: relative(s.cwd, gd).split(sep).join("/") || ".", firstTool: first.tool, firstSeq: first.seq,
      readEditSeq: firstReadEdit?.seq ?? null, injected, lag: firstReadEdit ? firstReadEdit.seq - first.seq : null });
  }
}

if (args.session) { console.log(JSON.stringify(sessions, null, 1)); process.exit(0); }

// ---------- aggregate by model ----------
const byModel = {};
const kept = sessions.filter((s) => s.model && s.turns >= MIN_TURNS);
for (const s of kept) {
  const a = (byModel[s.model] ||= { sessions: 0, readFull: 0, readPartial: 0, grep: 0, glob: 0, shell: 0, shellRead: 0,
    touches: 0, injected: 0, firstByTool: {}, indirectOnly: 0, indirectOnlyInjected: 0, lags: [] });
  a.sessions++; a.readFull += s.readFull; a.readPartial += s.readPartial; a.grep += s.tools.Grep || 0; a.glob += s.tools.Glob || 0;
  a.shell += s.shell; a.shellRead += s.shellRead;
  for (const t of s.touches) {
    a.touches++; if (t.injected) a.injected++;
    a.firstByTool[t.firstTool] = (a.firstByTool[t.firstTool] || 0) + 1;
    if (t.readEditSeq == null) { a.indirectOnly++; if (t.injected) a.indirectOnlyInjected++; }
    else if (!["Read", "Edit", "Write", "MultiEdit"].includes(t.firstTool)) a.lags.push(t.lag);
  }
}

if (args.json) { console.log(JSON.stringify({ days: DAYS, minTurns: MIN_TURNS, sessions: kept.length, byModel }, null, 2)); process.exit(0); }

console.log(`read-patterns — ${kept.length} sessions (${sessions.length} scanned, last ${DAYS} days, ≥${MIN_TURNS} turns${args.project ? `, project ~ "${args.project}"` : ""}${args.worktrees ? ", worktrees only" : ""})`);
for (const [m, a] of Object.entries(byModel).sort((x, y) => y[1].sessions - x[1].sessions)) {
  const reads = a.readFull + a.readPartial;
  console.log(`\n== ${m} — ${a.sessions} sessions`);
  console.log(`  READ STYLE`);
  console.log(`    Read tool ${reads}  (partial offset/limit ${a.readPartial} = ${pct(a.readPartial, reads)})   Grep ${a.grep}   Glob ${a.glob}`);
  console.log(`    shell calls ${a.shell}, with a file-reading verb ${a.shellRead} (${pct(a.shellRead, a.shell)})  → shell share of all reading ${pct(a.shellRead, a.shellRead + reads)}`);
  console.log(`    search-first ratio (Grep+Glob+shell reads) : Read = ${((a.grep + a.glob + a.shellRead) / Math.max(1, reads)).toFixed(2)}`);
  console.log(`  DISCLOSURE GAP (session × guidance dir)`);
  console.log(`    touched ${a.touches}, nested CLAUDE.md injected ${a.injected} (${pct(a.injected, a.touches)}), never injected ${a.touches - a.injected}`);
  console.log(`    first touch by tool: ${JSON.stringify(a.firstByTool)}`);
  console.log(`    touched ONLY via Grep/Glob/shell (no Read/Edit ever): ${a.indirectOnly} — injected: ${a.indirectOnlyInjected}`);
  const l = a.lags.slice().sort((x, y) => x - y);
  if (l.length) console.log(`    first touch indirect, Read/Edit later: ${l.length} — lag in tool calls median ${l[l.length >> 1]} p90 ${l[Math.floor(l.length * 0.9)]} max ${l[l.length - 1]}`);
}
console.log(`\nReading: "touched ONLY via Grep/Glob/shell — injected: 0" is the gap. A PostToolUse hook on Bash|Grep|Glob that resolves nested CLAUDE.md + path-scoped rules for the touched paths closes it (see the context-disclosure-hook demo).`);

// ---------- parsing ----------
function parseSession(p, dir) {
  const s = { file: p, dir, model: "", cwd: "", turns: 0, tools: {}, readFull: 0, readPartial: 0, shell: 0, shellRead: 0, paths: [], nestedPaths: [] };
  let seq = 0, text; try { text = readFileSync(p, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
    if (!s.cwd && r.cwd) s.cwd = norm(r.cwd);
    if (r.type === "attachment" && r.attachment?.type === "nested_memory") { s.nestedPaths.push(norm(String(r.attachment.path))); continue; }
    if (r.type !== "assistant" || !r.message) continue;
    if (r.message.model && !s.model && !String(r.message.model).startsWith("<")) s.model = String(r.message.model).replace(/-\d{8}$/, "");
    s.turns++;
    for (const b of r.message.content || []) {
      if (b.type !== "tool_use") continue; seq++;
      const n = b.name, inp = b.input || {}; s.tools[n] = (s.tools[n] || 0) + 1;
      const push = (pp) => { if (pp) s.paths.push({ seq, tool: n, path: abs(s.cwd, String(pp)) }); };
      if (n === "Read") { if (inp.offset != null || inp.limit != null) s.readPartial++; else s.readFull++; push(inp.file_path); }
      else if (["Edit", "Write", "MultiEdit"].includes(n)) push(inp.file_path);
      else if (n === "Grep" || n === "Glob") push(inp.path || s.cwd);
      else if (n === "Bash" || n === "PowerShell") {
        s.shell++; const cmd = String(inp.command || "");
        if (READ_VERB.test(cmd)) s.shellRead++;
        for (const tok of cmd.split(/\s+/)) { const t = tok.replace(/^["'`]+|["'`,;:)]+$/g, "").replace(/:\d+(:\d+)?$/, ""); if (/[\\/]/.test(t) && !t.startsWith("-")) push(t); }
      }
    }
  }
  return s;
}

function scanGuidanceDirs(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (d, depth) => {
    if (depth > 4) return;
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const sub = join(d, e.name);
      if (existsSync(join(sub, "CLAUDE.md"))) out.push(norm(sub));
      walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function norm(p) { return String(p).replace(/\\/g, "/").replace(/\/+$/, ""); }
function abs(cwd, p) { p = norm(p); return /^[A-Za-z]:\//.test(p) || p.startsWith("/") ? p : norm(join(cwd, p)); }
function pct(a, b) { return b ? `${Math.round((100 * a) / b)}%` : "n/a"; }
function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith("--")) continue; const k = a.slice(2); const v = argv[i + 1]; if (v && !v.startsWith("--")) { o[k] = v; i++; } else o[k] = true; } return o; }
