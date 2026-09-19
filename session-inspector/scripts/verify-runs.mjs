#!/usr/bin/env node
/**
 * verify-runs.mjs — did the agent ever RUN the code it wrote, when, and what did
 * the output cost?
 *
 * The question behind it
 * ──────────────────────
 * A session that writes 150 files and never runs a test is not "done", and its
 * summary looks identical to one that verified every step. The transcript can tell
 * them apart: every shell command is in there, joined to its result. This
 * classifies the commands (test / typecheck / lint / build) and reports:
 *
 *   • WHEN verification first happened, relative to the writing
 *   • the FLYING-BLIND stretches — how many file writes went unverified between
 *     two verification runs, which is where the risk actually sits
 *   • what the verification OUTPUT cost in context, and how much of it was the
 *     same text arriving again (a verbose runner re-printing a passing suite)
 *
 * Classification strips heredoc bodies and quoted strings first: a package.json
 * that MENTIONS vitest, or a capacity probe that greps the process table for it,
 * is not a test run — see lib/turns.mjs.
 *
 * Token figures for tool output are ESTIMATES (chars/4), printed with `~`. The
 * exact per-call figures are in analyze-claude-session.mjs.
 *
 * Usage
 *   node verify-runs.mjs <path|sessionId|--latest> [--all] [--full] [--json]
 *   --all    list every classified command, not just the verification ones
 *   --full   do not truncate commands
 *   (+ --profile <name> / --config-dir <path> to break ties when resolving an id)
 *
 * Node builtins only.
 */

import { resolveTranscript, readLines, parseArgs, configDirFrom } from "./lib/locate.mjs";
import { claudeTurns, estTokens, fmtN, VERIFY_CATEGORIES } from "./lib/turns.mjs";
import { verificationMetrics } from "./lib/metrics.mjs";
import { reach } from "./lib/reach.mjs";
import { fmtDuration } from "./lib/parse.mjs";

const argv = process.argv.slice(2);
const { has, val, positional } = parseArgs(argv);
const jsonOut = has("--json");
const showAll = has("--all");
const full = has("--full");

let path;
try {
  path = resolveTranscript(positional, { latest: has("--latest"), profile: val("--profile"), configDir: configDirFrom(has, val) });
} catch (e) { console.error(e.message); process.exit(1); }

reach.begin("verify-runs", { session: positional || "--latest" });
reach.found("claude", "", positional || "");
reach.file(path);
const turns = claudeTurns(readLines(path));
const { meta } = turns;
const { shell, verify, gaps, byCategory, summary } = verificationMetrics(turns);

if (jsonOut) {
  console.log(JSON.stringify({
    session: meta.sessionId, cwd: meta.cwd, model: meta.model, durationSec: meta.durationSec,
    summary, categories: byCategory,
    runs: verify.map((c) => ({
      offsetSec: c.offsetSec, ts: c.ts, category: c.category, ok: c.ok,
      durationSec: c.durationSec, resultLines: c.resultLines, resultChars: c.resultChars,
      tokensEst: estTokens(c.resultChars), branch: c.branch, skill: c.skill,
      command: full ? c.command : c.command.slice(0, 200),
    })),
    gaps,
    commands: showAll ? shell.map((c) => ({ offsetSec: c.offsetSec, category: c.category, ok: c.ok, command: c.command.slice(0, 200) })) : undefined,
    reach: reach.toJSON(),
  }, null, 2));
  process.exit(0);
}

const line = (s = "") => console.log(s);
const bar = "─".repeat(60);
const mmss = (s) => (s == null ? "  —  " : `${String(Math.floor(s / 60)).padStart(3)}m${String(s % 60).padStart(2, "0")}`);

line("═".repeat(60));
line("VERIFICATION RUNS");
line("═".repeat(60));
line(`Session:  ${meta.sessionId.slice(0, 8)}…  ${meta.cwd}`);
line(`Duration: ${fmtDuration(meta.durationSec)}  ·  ${shell.length} shell calls  ·  ${summary.totalWrites} file writes`);
line();

if (!verify.length) {
  line("⚠  NO test / typecheck / lint / build command ran in this session.");
  line(`   ${summary.totalWrites} file writes went unverified.`);
} else {
  line(`First verification at ${mmss(summary.firstVerifyOffsetSec)} into the session` +
    (summary.writesBeforeFirstVerify ? `, after ${summary.writesBeforeFirstVerify} write${summary.writesBeforeFirstVerify > 1 ? "s" : ""}` : ""));
  line(`Last  verification at ${mmss(summary.lastVerifyOffsetSec)}  ·  ${verify.length} runs, ${summary.verifyFailed} failed`);
  line(`Flying blind: worst stretch ${summary.worstBlindStretch} writes between verifications (median ${summary.medianBlindStretch})`);
}
line();

line(bar);
line("BY CATEGORY (runs / failed / ~tokens of output)");
line(bar);
for (const [cat, b] of Object.entries(byCategory).sort((a, b) => b[1].chars - a[1].chars)) {
  const mark = VERIFY_CATEGORIES.has(cat) ? "✓" : " ";
  line(`  ${mark} ${cat.padEnd(15)} ${String(b.runs).padStart(4)} runs  ${String(b.failed).padStart(3)} failed  ~${fmtN(estTokens(b.chars)).padStart(6)} tok  ${fmtN(b.lines).padStart(6)} lines`);
}
line();

if (verify.length) {
  const rs = summary.resultLines;
  line(bar);
  line("OUTPUT COST");
  line(bar);
  line(`  verification output      ~${fmtN(summary.verifyOutputTokensEst)} tokens  (${Math.round(summary.verifyShareOfToolOutput * 100)}% of all tool output)`);
  line(`  of which re-printed      ~${fmtN(summary.repeatedOutputTokensEst)} tokens  (identical output seen again)`);
  line(`  filtered runs            ${summary.filteredRuns}/${verify.length} piped through head/grep or a quiet reporter`);
  line(`  lines per run            median ${rs.median}  ·  p90 ${rs.p90}  ·  max ${rs.max}`);
  if (summary.unfilteredRuns && rs.p90 > 100)
    line(`  ⚠ ${summary.unfilteredRuns} run(s) returned full output; p90 is ${rs.p90} lines — a dot/quiet reporter would cut most of it`);
  line();

  line(bar);
  line("TIMELINE");
  line(bar);
  for (const c of verify) {
    const ok = c.ok === false ? "✗" : c.ok === true ? "✓" : "?";
    const cmd = full ? c.command.replace(/\s+/g, " ") : c.command.replace(/\s+/g, " ").slice(0, 64);
    line(`  ${mmss(c.offsetSec)}  ${ok} ${c.category.padEnd(10)} ${String(c.resultLines).padStart(5)} ln  ~${fmtN(estTokens(c.resultChars)).padStart(5)} tok  ${(c.branch || "").padEnd(20).slice(0, 20)} ${cmd}`);
  }
  line();
}

if (gaps.length) {
  line(bar);
  line("UNVERIFIED WRITE STRETCHES (top 8)");
  line(bar);
  for (const g of [...gaps].sort((a, b) => b.writes - a.writes).slice(0, 8))
    line(`  ${String(g.writes).padStart(3)} writes → ${g.endedBy ? `${g.endedBy} at ${mmss(g.endOffsetSec)} ${g.ok === false ? "(failed)" : ""}` : "never verified (session ended)"}`);
  line();
}

if (showAll) {
  line(bar);
  line("ALL SHELL COMMANDS");
  line(bar);
  for (const c of shell)
    line(`  ${mmss(c.offsetSec)}  ${c.category.padEnd(14)} ${c.command.replace(/\s+/g, " ").slice(0, full ? 400 : 90)}`);
  line();
}

console.log(reach.line());
