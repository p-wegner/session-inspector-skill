/**
 * metrics.mjs — the derived numbers the shape tools and the dashboard both need.
 *
 * verify-runs.mjs, message-stats.mjs and session-dashboard.mjs all answer parts of
 * the same three questions, so the computation lives here once. A CLI formats; it
 * does not re-derive. (The alternative drifts: the dashboard and the text report
 * disagree about the same session, and neither is obviously wrong.)
 *
 * Every function takes the output of claudeTurns() and returns plain data.
 * Token figures derived from characters are estimates and named `…Est`.
 */

import { classifyCommand, VERIFY_CATEGORIES, estTokens, stats, histogram, DEFAULT_BUCKETS } from "./turns.mjs";

const SHELL = new Set(["Bash", "PowerShell"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function offsetter(meta) {
  const t0 = meta.startTime ? new Date(meta.startTime).getTime() : 0;
  return (ts) => (t0 && ts ? Math.round((new Date(ts).getTime() - t0) / 1000) : 0);
}

// ── verification ─────────────────────────────────────────────────────────────

export function verificationMetrics({ meta, events, calls }) {
  const off = offsetter(meta);
  const shell = calls.filter((c) => SHELL.has(c.tool) && c.command)
    .map((c) => ({ ...c, category: classifyCommand(c.command), offsetSec: off(c.ts) }));
  const verify = shell.filter((c) => VERIFY_CATEGORIES.has(c.category));
  const writes = calls
    .filter((c) => WRITE_TOOLS.has(c.tool) || (SHELL.has(c.tool) && classifyCommand(c.command) === "write"))
    .map((c) => ({ seq: c.seq, ts: c.ts, offsetSec: off(c.ts), file: c.filePath }));

  // Stretches of file writes with no verification between them.
  const gaps = [];
  {
    const all = [...writes.map((w) => ({ ...w, _w: true })), ...verify.map((v) => ({ ...v, _v: true }))].sort((a, b) => a.seq - b.seq);
    let count = 0, firstSeq = null;
    for (const e of all) {
      if (e._w) { if (firstSeq === null) firstSeq = e.seq; count++; continue; }
      if (count) gaps.push({ writes: count, fromSeq: firstSeq, endedBy: e.category, endOffsetSec: e.offsetSec, ok: e.ok });
      count = 0; firstSeq = null;
    }
    if (count) gaps.push({ writes: count, fromSeq: firstSeq, endedBy: null, endOffsetSec: null, ok: null });
  }

  const byCategory = {};
  for (const c of shell) {
    const b = (byCategory[c.category] ||= { runs: 0, failed: 0, chars: 0, lines: 0 });
    b.runs++; if (c.ok === false) b.failed++; b.chars += c.resultChars; b.lines += c.resultLines;
  }

  // Identical output arriving again = the verbose-runner tax.
  const repeats = new Map();
  for (const c of verify) {
    const k = `${c.resultChars}|${c.excerpt.slice(0, 120)}`;
    const e = repeats.get(k) || { count: 0, chars: c.resultChars };
    e.count++; repeats.set(k, e);
  }
  const repeatedChars = [...repeats.values()].filter((e) => e.count > 1).reduce((a, e) => a + e.chars * (e.count - 1), 0);

  const FILTERED = /\|\s*(head|tail|grep|rg|Select-Object|Select-String)\b|--reporter[= ](dot|basic)|--silent|-q\b/i;
  const filteredRuns = verify.filter((c) => FILTERED.test(c.command)).length;

  const allResultChars = events.filter((e) => e.kind === "tool_result").reduce((a, e) => a + e.chars, 0);
  const verifyChars = verify.reduce((a, c) => a + c.resultChars, 0);
  const first = verify[0] || null, last = verify[verify.length - 1] || null;

  return {
    shell, verify, writes, gaps, byCategory,
    summary: {
      shellCalls: shell.length,
      verifyRuns: verify.length,
      verifyFailed: verify.filter((c) => c.ok === false).length,
      firstVerifyOffsetSec: first ? first.offsetSec : null,
      lastVerifyOffsetSec: last ? last.offsetSec : null,
      firstWriteOffsetSec: writes.length ? writes[0].offsetSec : null,
      writesBeforeFirstVerify: first ? writes.filter((w) => w.seq < first.seq).length : writes.length,
      totalWrites: writes.length,
      worstBlindStretch: gaps.length ? Math.max(...gaps.map((g) => g.writes)) : 0,
      medianBlindStretch: gaps.length ? stats(gaps.map((g) => g.writes)).median : 0,
      verifyOutputChars: verifyChars,
      verifyOutputTokensEst: estTokens(verifyChars),
      allToolResultChars: allResultChars,
      verifyShareOfToolOutput: allResultChars ? +(verifyChars / allResultChars).toFixed(3) : 0,
      repeatedOutputChars: repeatedChars,
      repeatedOutputTokensEst: estTokens(repeatedChars),
      filteredRuns, unfilteredRuns: verify.length - filteredRuns,
      resultLines: stats(verify.map((c) => c.resultLines)),
    },
  };
}

// ── message shape ────────────────────────────────────────────────────────────

export function messageMetrics({ meta, events, calls, apiCalls }) {
  const texts = events.filter((e) => e.kind === "assistant_text");
  const ordered = events.filter((e) => ["assistant_text", "tool_use", "user"].includes(e.kind));
  const reportSeqs = new Set();
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].kind !== "assistant_text") continue;
    let isReport = true;
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[j].kind === "tool_use") { isReport = false; break; }
      if (ordered[j].kind === "user") break;
    }
    if (isReport) reportSeqs.add(ordered[i].seq);
  }
  const narration = texts.filter((e) => !reportSeqs.has(e.seq));
  const reports = texts.filter((e) => reportSeqs.has(e.seq));
  const thinking = events.filter((e) => e.kind === "thinking");
  const results = events.filter((e) => e.kind === "tool_result");
  const humans = events.filter((e) => e.kind === "user" && !e.interrupt && e.role === "human");
  const injected = events.filter((e) => e.kind === "user" && e.role !== "human");

  const textChars = texts.reduce((a, e) => a + e.chars, 0);
  const thinkChars = thinking.reduce((a, e) => a + e.chars, 0);
  const toolInputChars = calls.reduce((a, c) => a + c.inputChars, 0);
  const resultChars = results.reduce((a, e) => a + e.chars, 0);
  const exactOutput = apiCalls.reduce((a, c) => a + c.output, 0);

  const charStats = stats(texts.map((e) => e.chars));
  return {
    texts, narration, reports, humans, injected, reportSeqs,
    charStats,
    histogram: histogram(texts.map((e) => e.chars), DEFAULT_BUCKETS),
    production: { textChars, thinkChars, toolInputChars, resultChars },
    narrationChars: narration.reduce((a, e) => a + e.chars, 0),
    reportChars: reports.reduce((a, e) => a + e.chars, 0),
    injectedChars: injected.reduce((a, e) => a + e.chars, 0),
    outputTokensExact: exactOutput,
    outputTokensEstFromChars: estTokens(textChars + thinkChars + toolInputChars),
    longest: (n = 8) => [...texts].sort((a, b) => b.chars - a.chars).slice(0, n)
      .map((e) => ({ ts: e.ts, chars: e.chars, tokensEst: estTokens(e.chars), kind: reportSeqs.has(e.seq) ? "report" : "narration", excerpt: e.excerpt })),
  };
}

// ── tokens and activity over time ────────────────────────────────────────────

export function tokenMetrics({ meta, events, apiCalls }) {
  const off = offsetter(meta);
  const totals = apiCalls.reduce((a, c) => ({
    input: a.input + c.input, output: a.output + c.output,
    cacheRead: a.cacheRead + c.cacheRead, cacheCreate: a.cacheCreate + c.cacheCreate,
  }), { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  const ctxSeries = apiCalls.map((c) => ({ sec: off(c.ts), ctx: c.ctx }));
  return {
    totals,
    apiCallCount: apiCalls.length,
    peakContext: apiCalls.reduce((m, c) => Math.max(m, c.ctx), 0),
    compactions: events.filter((e) => e.kind === "compaction").length,
    ctxSeries,
  };
}

/** Tool calls per minute, split by command category — the session's rhythm. */
export function activityMetrics({ meta, calls }) {
  const off = offsetter(meta);
  const minutes = Math.max(1, Math.ceil((meta.durationSec || 1) / 60));
  const grid = Array.from({ length: minutes }, () => ({}));
  for (const c of calls) {
    const m = Math.min(minutes - 1, Math.floor(off(c.ts) / 60));
    const key = SHELL.has(c.tool) ? classifyCommand(c.command)
      : WRITE_TOOLS.has(c.tool) ? "write"
      : c.tool.startsWith("Skill:") ? "skill"
      : c.tool === "Read" ? "inspect" : "other";
    grid[m][key] = (grid[m][key] || 0) + 1;
  }
  return { minutes, grid };
}

export function toolMetrics({ calls }) {
  const out = new Map();
  for (const c of calls) {
    const e = out.get(c.tool) || { tool: c.tool, count: 0, failed: 0, resultChars: 0 };
    e.count++; if (c.ok === false) e.failed++; e.resultChars += c.resultChars;
    out.set(c.tool, e);
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}
