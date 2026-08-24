#!/usr/bin/env node
/**
 * HOOK COST — how much wall-clock do configured hooks burn, and which ones.
 *
 * Hooks run SYNCHRONOUSLY in the agent's critical path: a PostToolUse hook
 * delays the next tool call, a Stop hook delays the end of every turn. So a
 * slow hook is a pure throughput tax — it costs seconds of latency per turn
 * while adding zero tokens, which makes it invisible to every other tool in
 * this skill (token-sinks, waste, context-growth all measure TOKENS).
 * This one measures TIME.
 *
 * Two independent channels in the transcript, both reported and labeled:
 *
 *   A. `system` / `subtype:"stop_hook_summary"` — emitted once per turn-end,
 *      carrying `hookInfos[]` of `{command, durationMs}` for the whole Stop
 *      chain plus `preventedContinuation` / `hasOutput`. This is the DENSE
 *      channel: every Stop hook of every turn shows up, whether or not it
 *      printed anything.
 *
 *   B. `attachment` / `attachment.type` in {hook_success, hook_blocking_error,
 *      hook_cancelled, hook_additional_context} — per-invocation records
 *      carrying `hookEvent`, `command`, `durationMs`, `exitCode`,
 *      `timedOut`/`timeoutMs`. This is the SPARSE channel: a hook is only
 *      attached when it produced output, blocked, cancelled, or injected
 *      context.
 *
 * THE TWO CHANNELS OVERLAP — verified on real data: one Stop hook run emitted
 * an `attachment` at ...:25.445Z AND a `stop_hook_summary` entry at ...:25.473Z,
 * same command, same `durationMs`. Summing both double-counts (it inflated one
 * 11m41s invocation to 23m). `dedupe()` below merges records that agree on
 * session+event+command+durationMs within DEDUPE_WINDOW_MS, preferring the
 * summary channel. Never sum the channels naively.
 *
 * KNOWN BLIND SPOT — a hook that runs, succeeds, and prints NOTHING leaves no
 * record at all. `PreToolUse` in particular only ever shows up when it blocks,
 * times out, or emits output: a silent per-tool-call guard is UNMEASURABLE here
 * and its cost is NOT in these totals. Every total below is therefore a LOWER
 * BOUND. The report says so rather than quietly under-reporting.
 *
 * Usage:
 *   node scripts/hook-cost.mjs                        # last 7d, ranked by total hook time
 *   node scripts/hook-cost.mjs --days 3 --project agentic-kanban
 *   node scripts/hook-cost.mjs --cwd                  # only sessions from this directory
 *   node scripts/hook-cost.mjs --by event             # command (default) | event | session | day | project
 *   node scripts/hook-cost.mjs --slowest 20           # slowest individual invocations
 *   node scripts/hook-cost.mjs --min-ms 1000          # ignore invocations under N ms
 *   node scripts/hook-cost.mjs --include-subagents
 *   node scripts/hook-cost.mjs --json
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { claudeProjectDirs, profileOfProjectsDir } from "./lib/config.mjs";

// ── helpers ──────────────────────────────────────────────────────────────────
const HOOK_ATTACH = /^hook_(success|blocking_error|cancelled|additional_context)$/;

/** Collapse a hook command into a stable, readable label. */
function hookLabel(cmd, fallback) {
  let c = (cmd || "").trim();
  if (!c) return fallback || "(unknown)";
  // Strip a leading interpreter so `node X/y.js Stop` -> `y.js Stop`
  c = c.replace(/^(node|npx|bash|sh|cmd(?:\.exe)?\s*\/c|powershell(?:\.exe)?(?:\s+-\S+)*)\s+/i, "");
  c = c.replace(/^["']|["']$/g, "");
  // Drop the directory part of the first path-ish token
  c = c.replace(/^\S*[\\/]([^\\/\s"']+)/, "$1");
  c = c.replace(/^["']|["']$/g, "");
  return c.length > 64 ? c.slice(0, 61) + "..." : c;
}

const pctl = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
  return `${(ms / 3600000).toFixed(2)}h`;
}
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n);
const norm = (s) => String(s).replace(/[\\/_-]+/g, "-").toLowerCase();

// ── parse one transcript ─────────────────────────────────────────────────────
function parseTranscript(path) {
  let txt;
  try { txt = readFileSync(path, "utf-8"); } catch { return null; }

  const invocations = [];
  let stopSummaries = 0, prevented = 0, hadOutput = 0;
  let tMin = null, tMax = null;
  let cwd = null, sessionId = null;

  for (const line of txt.split("\n")) {
    if (!line) continue;

    // cheap span scan without a full parse
    const tm = line.indexOf('"timestamp":"');
    if (tm >= 0) {
      const t = Date.parse(line.slice(tm + 13, tm + 37));
      if (!Number.isNaN(t)) {
        if (tMin === null || t < tMin) tMin = t;
        if (tMax === null || t > tMax) tMax = t;
      }
    }
    if (line.indexOf("ook") < 0) continue;

    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!sessionId && o.sessionId) sessionId = o.sessionId;
    if (!cwd && o.cwd) cwd = o.cwd;
    const ts = o.timestamp ? Date.parse(o.timestamp) : null;

    // ── channel A: the per-turn Stop summary ────────────────────────────────
    if (o.type === "system" && o.subtype === "stop_hook_summary") {
      stopSummaries++;
      if (o.preventedContinuation) prevented++;
      if (o.hasOutput) hadOutput++;
      for (const hi of o.hookInfos || []) {
        if (hi.durationMs == null) continue; // queued / never-ran entry
        invocations.push({
          label: hookLabel(hi.command),
          event: "Stop",
          ms: hi.durationMs,
          channel: "summary",
          status: "ran",
          ts,
        });
      }
      continue;
    }

    // ── channel B: per-invocation attachments ───────────────────────────────
    const a = o.attachment;
    if (a && HOOK_ATTACH.test(a.type || "")) {
      if (a.durationMs == null) continue; // no timing recorded — not measurable
      invocations.push({
        label: hookLabel(a.command, a.hookName),
        event: a.hookEvent || "(unknown)",
        ms: a.durationMs,
        channel: "attachment",
        status: a.type.replace(/^hook_/, ""),
        exitCode: a.exitCode,
        timedOut: !!a.timedOut,
        timeoutMs: a.timeoutMs,
        ts,
      });
    }
  }

  if (!invocations.length && !stopSummaries) return null;
  const { kept, dropped } = dedupe(invocations);
  return {
    path, sessionId, cwd,
    spanMs: tMin != null && tMax != null ? tMax - tMin : 0,
    invocations: kept, dupesDropped: dropped,
    stopSummaries, prevented, hadOutput,
  };
}

/**
 * Merge the same invocation seen through both channels. Two records are the
 * same run when they agree on event + command label + exact durationMs and sit
 * within DEDUPE_WINDOW_MS of each other (observed skew: 28ms). The summary
 * record wins, because it is the channel that is emitted unconditionally.
 */
const DEDUPE_WINDOW_MS = 5000;
function dedupe(invocations) {
  const byKey = new Map();
  for (const inv of invocations) {
    const key = `${inv.event}|${inv.label}|${inv.ms}`;
    const bucket = byKey.get(key) || [];
    const near = bucket.find((b) => Math.abs((b.ts ?? 0) - (inv.ts ?? 0)) <= DEDUPE_WINDOW_MS);
    if (near) {
      // keep the richer/denser record: summary wins, else keep the first
      if (near.channel !== "summary" && inv.channel === "summary") {
        Object.assign(near, inv, { dupOf: near.channel });
      } else {
        near.dupSeen = (near.dupSeen || 1) + 1;
      }
      continue;
    }
    bucket.push(inv);
    byKey.set(key, bucket);
  }
  const kept = [...byKey.values()].flat();
  return { kept, dropped: invocations.length - kept.length };
}

// ── discovery ────────────────────────────────────────────────────────────────
function collect({ cutoffMs, projectFilter, cwdFilter, includeSubagents }) {
  const out = [];
  for (const base of claudeProjectDirs()) {
    const profile = profileOfProjectsDir(base);
    let dirs;
    try { dirs = readdirSync(base); } catch { continue; }
    for (const dir of dirs) {
      if (projectFilter && !norm(dir).includes(projectFilter)) continue;
      const dirPath = join(base, dir);
      const files = [];
      const walk = (d, depth) => {
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = join(d, e.name);
          if (e.isDirectory()) { if (includeSubagents && depth < 2) walk(p, depth + 1); continue; }
          if (!e.name.endsWith(".jsonl")) continue;
          if (!includeSubagents && e.name.startsWith("agent-")) continue;
          files.push(p);
        }
      };
      walk(dirPath, 0);
      for (const p of files) {
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.mtimeMs < cutoffMs) continue;
        const parsed = parseTranscript(p);
        if (!parsed) continue;
        if (cwdFilter && norm(parsed.cwd || "") !== norm(cwdFilter)) continue;
        out.push({ ...parsed, profile, project: dir, modified: st.mtime });
      }
    }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const days = parseInt(flag("days", "7"), 10);
const by = flag("by", "command");
const top = parseInt(flag("top", "25"), 10);
const slowestN = parseInt(flag("slowest", "10"), 10);
const minMs = parseInt(flag("min-ms", "0"), 10);
const projectFilter = args.includes("--project") ? norm(flag("project", "")) : null;
const cwdFilter = args.includes("--cwd") ? process.cwd() : null;
const includeSubagents = args.includes("--include-subagents");
const jsonOut = args.includes("--json");

const sessions = collect({
  cutoffMs: Date.now() - days * 864e5,
  projectFilter, cwdFilter, includeSubagents,
});

// ── aggregate ────────────────────────────────────────────────────────────────
const groups = new Map();
const all = [];
let totalHookMs = 0, totalSpanMs = 0, turns = 0, prevented = 0, dupesDropped = 0;
const events = new Map();

for (const s of sessions) {
  totalSpanMs += s.spanMs;
  turns += s.stopSummaries;
  prevented += s.prevented;
  dupesDropped += s.dupesDropped || 0;
  for (const inv of s.invocations) {
    if (inv.ms < minMs) continue;
    all.push({ ...inv, session: s.sessionId, project: s.project, profile: s.profile });
    totalHookMs += inv.ms;

    const key =
      by === "event" ? inv.event
      : by === "session" ? `${(s.sessionId || "?").slice(0, 8)} ${s.project}`
      : by === "project" ? s.project
      : by === "day" ? (inv.ts ? new Date(inv.ts).toISOString().slice(0, 10) : "(no date)")
      : inv.label;

    const g = groups.get(key) || { n: 0, ms: 0, max: 0, samples: [], timeouts: 0, blocked: 0, sessions: new Set() };
    g.n++; g.ms += inv.ms; g.max = Math.max(g.max, inv.ms);
    g.samples.push(inv.ms);
    if (inv.timedOut) g.timeouts++;
    if (inv.status === "blocking_error") g.blocked++;
    g.sessions.add(s.sessionId);
    groups.set(key, g);

    const e = events.get(inv.event) || { n: 0, ms: 0 };
    e.n++; e.ms += inv.ms; events.set(inv.event, e);
  }
}

const ranked = [...groups.entries()]
  .map(([k, g]) => {
    const s = g.samples.slice().sort((a, b) => a - b);
    return {
      key: k, n: g.n, totalMs: g.ms, avgMs: g.ms / g.n,
      medianMs: pctl(s, 50), p90Ms: pctl(s, 90), maxMs: g.max,
      timeouts: g.timeouts, blocked: g.blocked, sessions: g.sessions.size,
      shareOfHookTime: totalHookMs ? g.ms / totalHookMs : 0,
    };
  })
  .sort((a, b) => b.totalMs - a.totalMs);

const slowest = all.slice().sort((a, b) => b.ms - a.ms).slice(0, slowestN);

// Stop-hook per-turn tax: the whole Stop chain runs once per turn-end
const stopPerTurn = [];
for (const s of sessions) {
  const byTs = new Map();
  for (const inv of s.invocations) {
    if (inv.channel !== "summary") continue;
    const k = inv.ts || 0;
    byTs.set(k, (byTs.get(k) || 0) + inv.ms);
  }
  for (const v of byTs.values()) stopPerTurn.push(v);
}
stopPerTurn.sort((a, b) => a - b);

if (jsonOut) {
  console.log(JSON.stringify({
    meta: {
      days, by, minMs, projectFilter, cwdFilter, includeSubagents,
      sessionsWithHookData: sessions.length,
      note: "PreToolUse and any silent hook leave no transcript record; totals are a LOWER BOUND.",
    },
    totals: {
      hookMs: totalHookMs, sessionSpanMs: totalSpanMs,
      shareOfWallClock: totalSpanMs ? totalHookMs / totalSpanMs : null,
      invocations: all.length, turnsWithStopHooks: turns, preventedContinuations: prevented,
      crossChannelDuplicatesDropped: dupesDropped,
      stopChainPerTurn: {
        n: stopPerTurn.length,
        medianMs: pctl(stopPerTurn, 50), p90Ms: pctl(stopPerTurn, 90),
        maxMs: stopPerTurn.at(-1) || 0,
      },
    },
    byEvent: [...events].map(([k, v]) => ({ event: k, n: v.n, totalMs: v.ms })),
    groups: ranked,
    slowest,
  }, null, 2));
  process.exit(0);
}

// ── report ───────────────────────────────────────────────────────────────────
const scope = [
  `last ${days}d`,
  projectFilter ? `project~${projectFilter}` : null,
  cwdFilter ? `cwd=${basename(cwdFilter)}` : null,
  minMs ? `>=${minMs}ms` : null,
].filter(Boolean).join(", ");

console.log(`\n\x1b[1mHOOK COST\x1b[0m  (${scope})`);
console.log(`${sessions.length} session(s) carrying hook records · ${all.length} timed invocation(s)\n`);

if (!all.length) {
  console.log("No timed hook invocations found in this window.\n");
  console.log("Note: a hook that runs silently and prints nothing leaves NO transcript record,");
  console.log("so an absence here is not proof that no hooks ran.\n");
  process.exit(0);
}

console.log(`\x1b[1mTotal hook wall-clock:\x1b[0m ${fmtMs(totalHookMs)}` +
  (totalSpanMs ? `  —  ${((100 * totalHookMs) / totalSpanMs).toFixed(1)}% of the ${fmtMs(totalSpanMs)} these sessions spanned` : ""));
if (stopPerTurn.length) {
  console.log(`\x1b[1mStop chain per turn:\x1b[0m   median ${fmtMs(pctl(stopPerTurn, 50))} · p90 ${fmtMs(pctl(stopPerTurn, 90))} · max ${fmtMs(stopPerTurn.at(-1))}   (${stopPerTurn.length} turn-ends)`);
  console.log(`                       -> every turn pays the median before the agent may stop.`);
}
if (prevented) console.log(`\x1b[33mBlocked continuations:\x1b[0m ${prevented} — each forces an EXTRA model turn (tokens, not just time).`);

// by event
if (events.size) {
  console.log(`\n\x1b[1mBy hook event\x1b[0m`);
  for (const [k, v] of [...events].sort((a, b) => b[1].ms - a[1].ms)) {
    console.log(`  ${pad(k, 22)} ${padL(v.n, 5)} inv  ${padL(fmtMs(v.ms), 9)}  ${padL(((100 * v.ms) / totalHookMs).toFixed(1) + "%", 6)}`);
  }
}

// main table
const label = { command: "hook", event: "event", session: "session", project: "project", day: "day" }[by] || by;
console.log(`\n\x1b[1mBy ${label}\x1b[0m  (ranked by total wall-clock)`);
console.log(`  ${pad(label, 46)} ${padL("n", 5)} ${padL("total", 9)} ${padL("share", 6)} ${padL("med", 8)} ${padL("p90", 8)} ${padL("max", 8)}  flags`);
console.log("  " + "-".repeat(104));
for (const g of ranked.slice(0, top)) {
  const flags = [g.timeouts ? `${g.timeouts} timeout` : null, g.blocked ? `${g.blocked} blocked` : null]
    .filter(Boolean).join(" ");
  const hot = g.shareOfHookTime > 0.5 ? "\x1b[31m" : g.shareOfHookTime > 0.15 ? "\x1b[33m" : "";
  console.log(`  ${hot}${pad(g.key, 46)}\x1b[0m ${padL(g.n, 5)} ${padL(fmtMs(g.totalMs), 9)} ${padL((100 * g.shareOfHookTime).toFixed(1) + "%", 6)} ${padL(fmtMs(g.medianMs), 8)} ${padL(fmtMs(g.p90Ms), 8)} ${padL(fmtMs(g.maxMs), 8)}  ${flags}`);
}

// slowest individual
if (slowest.length) {
  console.log(`\n\x1b[1mSlowest individual invocations\x1b[0m`);
  for (const s of slowest) {
    const when = s.ts ? new Date(s.ts).toISOString().slice(5, 16).replace("T", " ") : "—";
    console.log(`  ${padL(fmtMs(s.ms), 9)}  ${pad(s.label, 44)} ${pad(s.event, 14)} ${when}  ${(s.session || "").slice(0, 8)}`);
  }
}

console.log(`\n\x1b[2mBlind spot: a hook that runs, succeeds and prints nothing emits no transcript`);
console.log(`record — PreToolUse shows up only when it blocks, times out, or outputs. These`);
console.log(`totals are a LOWER BOUND.` +
  (dupesDropped ? ` Merged ${dupesDropped} cross-channel duplicate record(s).` : "") + `\x1b[0m\n`);
