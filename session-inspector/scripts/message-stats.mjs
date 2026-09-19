#!/usr/bin/env node
/**
 * message-stats.mjs — how long were the agent's messages, and who was actually
 * generating the tokens?
 *
 * The questions behind it
 * ───────────────────────
 *   • "How long were the agent message outputs?" — a mean is useless here; the
 *     distribution spans three orders of magnitude, so this prints a histogram and
 *     the percentiles, and names the longest few.
 *   • "Did the agent mostly talk to itself?" — in an autonomous run nobody reads
 *     the prose between tool calls. This splits assistant text into NARRATION
 *     (another tool call follows, so it was written for no reader) and REPORTS
 *     (the last text before control returns to a human), and prices both.
 *   • "Where did the context go?" — assistant prose, thinking, tool INPUTS (writing
 *     a file is output tokens too), and tool RESULTS coming back. Only one of those
 *     four is what people picture when they say "the agent's output".
 *
 * Exact vs estimated: the per-API-call `output_tokens` are exact (deduped usage
 * rows). Per-message figures are estimates from character counts, printed with `~`.
 * The report shows both totals side by side, so the estimate's error is visible
 * rather than assumed — on code-heavy sessions it runs well under the exact figure,
 * because reasoning tokens are billed but not stored in the transcript.
 *
 * Usage
 *   node message-stats.mjs <path|sessionId|--latest> [--top N] [--json]
 *   (+ --profile <name> / --config-dir <path>)
 *
 * Node builtins only.
 */

import { resolveTranscript, readLines, parseArgs, configDirFrom } from "./lib/locate.mjs";
import { claudeTurns, estTokens, renderHistogram, fmtN } from "./lib/turns.mjs";
import { messageMetrics } from "./lib/metrics.mjs";
import { reach } from "./lib/reach.mjs";
import { fmtDuration } from "./lib/parse.mjs";

const argv = process.argv.slice(2);
const { has, val, positional } = parseArgs(argv);
const jsonOut = has("--json");
const top = Number(val("--top") || 8);

let path;
try {
  path = resolveTranscript(positional, { latest: has("--latest"), profile: val("--profile"), configDir: configDirFrom(has, val) });
} catch (e) { console.error(e.message); process.exit(1); }

reach.begin("message-stats", { session: positional || "--latest" });
reach.found("claude", "", positional || "");
reach.file(path);
const turns = claudeTurns(readLines(path));
const { meta } = turns;
const m = messageMetrics(turns);
const { textChars, thinkChars, toolInputChars, resultChars } = m.production;

const out = {
  session: meta.sessionId, cwd: meta.cwd, model: meta.model, durationSec: meta.durationSec,
  assistantTextBlocks: m.texts.length,
  narrationBlocks: m.narration.length,
  reportBlocks: m.reports.length,
  humanTurns: m.humans.length,
  injectedUserTurns: m.injected.length,
  injectedUserChars: m.injectedChars,
  charStats: m.charStats,
  histogram: m.histogram.map((b) => ({ lo: b.lo, hi: b.hi === Infinity ? null : b.hi, count: b.count })),
  narrationChars: m.narrationChars,
  reportChars: m.reportChars,
  production: m.production,
  outputTokensExact: m.outputTokensExact,
  outputTokensEstFromChars: m.outputTokensEstFromChars,
  longest: m.longest(top),
};

if (jsonOut) { console.log(JSON.stringify({ ...out, reach: reach.toJSON() }, null, 2)); process.exit(0); }

const line = (s = "") => console.log(s);
const bar = "─".repeat(64);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "0%");
const cs = m.charStats;

line("═".repeat(64));
line("MESSAGE SHAPE");
line("═".repeat(64));
line(`Session:  ${meta.sessionId.slice(0, 8)}…  ${meta.cwd}`);
line(`Duration: ${fmtDuration(meta.durationSec)}  ·  ${m.texts.length} assistant text blocks  ·  ${m.humans.length} human turn(s)`);
line();

line(bar);
line("ASSISTANT MESSAGE LENGTH (characters)");
line(bar);
line(`  n ${cs.n}  ·  median ${fmtN(cs.median)}  ·  mean ${fmtN(cs.mean)}  ·  p90 ${fmtN(cs.p90)}  ·  max ${fmtN(cs.max)}`);
line(`  total ${fmtN(cs.sum)} chars  (~${fmtN(estTokens(cs.sum))} tokens)`);
line();
line(renderHistogram(m.histogram));
line();

line(bar);
line("TALKING TO ITSELF?");
line(bar);
line(`  narration (mid-run, no reader)  ${String(m.narration.length).padStart(4)} blocks  ~${fmtN(estTokens(m.narrationChars)).padStart(6)} tok  ${pct(m.narrationChars, textChars)} of prose`);
line(`  reports  (a human would read)   ${String(m.reports.length).padStart(4)} blocks  ~${fmtN(estTokens(m.reportChars)).padStart(6)} tok  ${pct(m.reportChars, textChars)} of prose`);
if (m.humans.length <= 2)
  line(`  ⚠ ${m.humans.length} human turn(s) in the whole session — an autonomous run, so even the "reports" had no live reader`);
line();

line(bar);
line("WHERE THE TOKENS WERE PRODUCED");
line(bar);
const prod = [["assistant prose", textChars], ["thinking (stored)", thinkChars], ["tool inputs (writes, commands)", toolInputChars]];
const producedTotal = prod.reduce((a, [, c]) => a + c, 0) || 1;
for (const [name, chars] of prod.sort((a, b) => b[1] - a[1]))
  line(`  ${name.padEnd(32)} ~${fmtN(estTokens(chars)).padStart(7)} tok  ${pct(chars, producedTotal).padStart(4)}`);
line(`  ${"—".repeat(32)}`);
line(`  ${"exact output_tokens (usage rows)".padEnd(32)}  ${fmtN(m.outputTokensExact).padStart(7)} tok`);
line(`  ${"same, estimated from chars".padEnd(32)} ~${fmtN(m.outputTokensEstFromChars).padStart(7)} tok   (estimate is ${m.outputTokensExact ? `${Math.round((m.outputTokensEstFromChars / m.outputTokensExact) * 100)}%` : "—"} of exact — the gap is mostly reasoning tokens, billed but not stored)`);
line();
line(`  tool RESULTS read back in       ~${fmtN(estTokens(resultChars)).padStart(7)} tok   (input side — re-read every turn until compaction)`);
line(`  injected user turns             ~${fmtN(estTokens(m.injectedChars)).padStart(7)} tok   ${m.injected.length} turns the harness wrote, not a human`);
line();

line(bar);
line(`LONGEST MESSAGES (top ${top})`);
line(bar);
for (const x of out.longest)
  line(`  ${String(fmtN(x.chars)).padStart(6)} ch  ~${String(fmtN(x.tokensEst)).padStart(5)} tok  ${x.kind.padEnd(9)} ${x.excerpt.replace(/\s+/g, " ").slice(0, 70)}`);
line();

console.log(reach.line());
