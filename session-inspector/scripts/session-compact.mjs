#!/usr/bin/env node
/**
 * session-compact.mjs — a fork of a Claude session with its tool traffic compressed.
 *
 * The middle ground between `claude --resume --fork-session` (everything, at full price) and a
 * handoff brief (a few thousand tokens, the conversation gone). Prompts and assistant text are
 * kept byte for byte; tool_use inputs and tool_result outputs — 75–90 % of a working session's
 * context — are cut to a head/tail (`pairs`, default) or to one line each (`narrate`). Every
 * line, uuid and parentUuid stays where it was, so `claude --resume <copy>` walks the copy as it
 * walked the original. The last prompt's tool calls stay verbatim (`--recent`).
 *
 * Usage:
 *   node scripts/session-compact.mjs <path|id-prefix|--latest> --fork          # copy beside the source, new id
 *   node scripts/session-compact.mjs <locator> --out <path.jsonl>               # copy to a path (same id unless --session-id)
 *   node scripts/session-compact.mjs <locator> --in-place                       # rewrite a copy you already made
 *   node scripts/session-compact.mjs <locator> --dry-run                        # the numbers only
 *     [--mode pairs|narrate|llm|summary] [--recent N] [--head N] [--tail N] [--input N] [--json]
 *     [--llm-model haiku] [--llm-settings <settings.json>] [--llm-config-dir <profile home>] [--strict]
 *     [--profile p | --config-dir d]
 *
 * Two depths use a MODEL, on a profile of your choosing (the point: compact on the cheap one,
 * resume on the strong one):
 *   llm      a model writes the one-line narrations of each call (lib/narrator.mjs), through a
 *            headless `claude -p` under --llm-settings / --llm-config-dir / --llm-model; a call
 *            the model skipped falls back to the narrate string cut.
 *   summary  Claude Code's own /compact, run headlessly on the copy under --llm-model /
 *            --llm-settings (lib/summarize.mjs); the copy's account is fixed by where it lives.
 *            The conversation collapses into Claude Code's summary — the handoff end of the scale.
 *
 * `--fork` prints `SESSION_ID: <id>` and `PATH: <file>` on stdout as the last two lines, so a
 * launcher can capture them; the stats go to stderr. It never writes the source: without --fork,
 * --out or --in-place nothing is written, and --in-place refuses a file modified in the last two
 * minutes (a live session rewrites its transcript on every turn).
 */

import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { randomUUID } from "crypto";
import { resolveTranscript, parseArgs, configDirFrom } from "./lib/locate.mjs";
import { compactTranscript, collectCalls, renderStats } from "./lib/compact.mjs";
import { narrateCalls } from "./lib/narrator.mjs";
import { summarizeCopy } from "./lib/summarize.mjs";

const argv = process.argv.slice(2);
const { has, val, positional } = parseArgs(argv, ["--mode", "--recent", "--head", "--tail", "--input", "--session-id", "--llm-model", "--llm-settings", "--llm-config-dir", "--llm-batch-chars"]);
const die = (m) => { console.error("error: " + m); process.exit(1); };

if (has("--help") || has("-h") || (!positional && !has("--latest"))) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].split("\n").slice(2).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
  process.exit(positional || has("--latest") ? 0 : 1);
}

let src;
try { src = resolveTranscript(positional, { latest: has("--latest"), configDir: configDirFrom(has, val) }); }
catch (e) { die(e.message); }

const num = (f, d) => (val(f) != null ? Number(val(f)) : d);
const mode = (val("--mode") || "pairs").toLowerCase();
if (!["pairs", "narrate", "llm", "summary"].includes(mode)) die(`--mode must be pairs, narrate, llm or summary, not "${mode}"`);
// No --model when a profile is named: its own ANTHROPIC_MODEL is the point of naming it (a zai
// profile maps "haiku" to glm-4.5-air, measured 2026-09-19). Haiku only on the bare default account.
const llmSettings = val("--llm-settings") ? resolve(val("--llm-settings")) : null;
const llmConfigDir = val("--llm-config-dir") || null;
const llm = { model: val("--llm-model") || ((llmSettings || llmConfigDir) ? null : "haiku"), settings: llmSettings, configDir: llmConfigDir };
if (llm.settings && !existsSync(llm.settings)) die(`--llm-settings: no such file ${llm.settings}`);
const log = (m) => console.error(`session-compact: ${m}`);
const opts = { mode, recent: num("--recent", 1), head: num("--head", 240), tail: num("--tail", 160), input: num("--input", 200) };
for (const [k, v] of Object.entries(opts)) if (typeof v === "number" && !(v >= 0)) die(`--${k} must be a non-negative number`);

const fork = has("--fork");
const inPlace = has("--in-place");
const outArg = val("--out") || val("-o");
if ([fork, inPlace, !!outArg].filter(Boolean).length > 1) die("choose one of --fork, --out, --in-place");
const dryRun = has("--dry-run") || !(fork || inPlace || outArg);

const srcId = basename(src).replace(/\.jsonl$/, "");
const newId = fork ? randomUUID() : (val("--session-id") || null);
if (inPlace) {
  const age = Date.now() - statSync(src).mtimeMs;
  if (age < 120_000 && !has("--force")) die(`${src} was modified ${Math.round(age / 1000)}s ago — a live session rewrites its transcript; exit it or pass --force`);
}

const raw = readFileSync(src, "utf8");
const lines = raw.split("\n");
let narrations = null, llmReport;
if (mode === "llm" && !dryRun) {
  const calls = collectCalls(lines, opts);
  const r = narrateCalls(calls, { ...llm, maxChars: num("--llm-batch-chars", 24_000), log, strict: has("--strict") });
  narrations = r.narrations; llmReport = r.report;
}
// summary: the copy is written whole (no cut), then Claude Code compacts it in place.
const passOpts = mode === "summary" ? { ...opts, recent: 0, mode: "pairs", head: Infinity, tail: Infinity, input: Infinity } : { ...opts, narrations };
const { lines: outLines, stats } = compactTranscript(lines, { ...passOpts, sessionId: newId });
if (mode === "summary") { stats.mode = "summary"; stats.compacted = 0; stats.kept = stats.calls; }
if (llmReport) stats.llm = llmReport;

const dest = fork ? join(dirname(src), `${newId}.jsonl`) : inPlace ? src : outArg ? resolve(outArg) : null;
if (dest && !dryRun) {
  if (fork && existsSync(dest)) die(`refusing to overwrite ${dest}`);
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, outLines.join("\n"), "utf8");
  renameSync(tmp, dest);
  if (mode === "summary") {
    if (inPlace) die("--mode summary needs a copy (--fork or --out): Claude Code appends to the file it compacts");
    // cwd must be the transcript's project so `--resume` finds it; the transcript names it.
    const cwd = cwdOfTranscript(lines) || process.cwd();
    stats.summary = summarizeCopy(dest, { ...llm, cwd, log });
    if (!stats.summary.ok && has("--strict")) die(`summary failed: ${stats.summary.error}`);
  }
}
function cwdOfTranscript(ls) {
  for (const l of ls) { try { const o = JSON.parse(l); if (typeof o.cwd === "string") return o.cwd; } catch { /* next */ } }
  return null;
}

const report = renderStats(stats, { path: dryRun ? "" : dest, sessionId: newId || (dryRun ? "" : srcId) });
if (has("--json")) {
  // `report` is the human rendering, so a launcher that parses the JSON can still show it.
  console.log(JSON.stringify({ contract: "session-inspector/session-compact/1", source: src, sessionId: newId || srcId, path: dryRun ? null : dest, dryRun, ...stats, report }, null, 2));
} else if (fork) {
  console.error(report);
  console.log(`SESSION_ID: ${newId}`);
  console.log(`PATH: ${dest}`);
} else {
  console.log(report + (dryRun ? "\n  (dry run: nothing written; add --fork, --out <path> or --in-place)" : ""));
}
