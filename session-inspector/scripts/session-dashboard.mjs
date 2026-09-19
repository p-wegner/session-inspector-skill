#!/usr/bin/env node
/**
 * session-dashboard.mjs — one self-contained HTML page answering "how did this
 * session actually behave", with a problem-specific panel bolted on.
 *
 * Shape: a FIXED generic half that is true of any session (tokens, context curve,
 * rhythm, message shape, verification, tools, failures) plus a LENS half that
 * answers the questions of one workflow (see lib/lenses/). The split is the point:
 * the generic numbers are comparable across sessions, the lens numbers are the ones
 * the reader actually asked about, and neither pretends to be the other.
 *
 * The page is one file, no network calls, no scripts beyond a theme toggle, so it
 * can be committed next to the run it describes.
 *
 * Usage
 *   node session-dashboard.mjs <path|sessionId|--latest> [-o out.html]
 *       [--lens auto|cost|speckit|none] [--repo <dir>] [--json] [--md] [--open]
 *   --md     the lens panels as Markdown on stdout (for an agent or a terminal);
 *            same data as the page, nothing written to disk
 *   --repo   the checkout the session worked in, for artifact-side facts
 *            (default: the session's own cwd, if it still exists)
 *
 * Node builtins only.
 */

import { writeFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { resolveTranscript, readLines, parseArgs, configDirFrom } from "./lib/locate.mjs";
import { claudeTurns, estTokens, fmtN } from "./lib/turns.mjs";
import { verificationMetrics, messageMetrics, tokenMetrics, activityMetrics, toolMetrics, offsetter } from "./lib/metrics.mjs";
import { lensById, detectLenses } from "./lib/lenses/index.mjs";
import { lensToMarkdown } from "./lib/lenses/render-md.mjs";
import { reach } from "./lib/reach.mjs";
import { fmtDuration } from "./lib/parse.mjs";

const argv = process.argv.slice(2);
const { has, val, positional } = parseArgs(argv, ["--repo"]);
const jsonOut = has("--json");
const mdOut = has("--md"); // the lens panels as Markdown on stdout: the agent's view of the same page
const lensArg = val("--lens") || "auto";

let path;
try {
  path = resolveTranscript(positional, { latest: has("--latest"), profile: val("--profile"), configDir: configDirFrom(has, val) });
} catch (e) { console.error(e.message); process.exit(1); }

reach.begin("session-dashboard", { session: positional || "--latest", lens: lensArg });
reach.found("claude", "", positional || "");
reach.file(path);

const turns = claudeTurns(readLines(path));
const { meta, events, calls, apiCalls } = turns;
const repoDir = val("--repo") ? resolve(val("--repo")) : (meta.cwd && existsSync(meta.cwd) ? meta.cwd : null);
if (val("--repo") && !existsSync(repoDir)) { console.error(`--repo ${repoDir} does not exist`); process.exit(1); }
if (!repoDir) reach.note("the session's cwd is not on this machine — artifact-side facts are omitted");

const ver = verificationMetrics(turns);
const msg = messageMetrics(turns);
const tok = tokenMetrics(turns);
const act = activityMetrics(turns);
const tools = toolMetrics(turns);
const off = offsetter(meta);

const lensCtx = { meta, events, calls, apiCalls, repoDir, path };
const lenses = lensArg === "none" ? []
  : lensArg === "auto" ? detectLenses(lensCtx)
  : [lensById(lensArg)].filter(Boolean);
if (lensArg !== "auto" && lensArg !== "none" && !lenses.length) { console.error(`Unknown lens "${lensArg}".`); process.exit(1); }
const lensResults = lenses.map((l) => ({ id: l.id, title: l.title, ...l.analyze(lensCtx) }));

const failures = calls.filter((c) => c.ok === false);
// subagents keep their own transcripts beside this one; the generic half covers the main thread only
const subDir = path.replace(/\.jsonl$/, "");
const subagentCount = existsSync(join(subDir, "subagents")) ? readdirSync(join(subDir, "subagents")).filter((n) => n.endsWith(".jsonl")).length : 0;

if (mdOut) {
  console.log(`# ${(meta.cwd || "session").split(/[\/]/).pop()} — session ${meta.sessionId.slice(0, 8)}
`);
  console.log(`${meta.model} · ${fmtDuration(meta.durationSec)} · ${calls.length} tool calls · started ${meta.startTime}
`);
  if (!lensResults.length) console.log("No lens applies to this session; run without --md for the HTML page.");
  for (const l of lensResults) console.log(lensToMarkdown(l));
  console.log(`---
${reach.line()}`);
  process.exit(0);
}

if (jsonOut) {
  console.log(JSON.stringify({
    meta, tokens: tok, verification: ver.summary, verifyByCategory: ver.byCategory,
    messages: { charStats: msg.charStats, narrationChars: msg.narrationChars, reportChars: msg.reportChars, humanTurns: msg.humans.length, production: msg.production, outputTokensExact: msg.outputTokensExact },
    tools,
    failures: failures.map((c) => ({ ts: c.ts, tool: c.tool, command: c.command.slice(0, 160), excerpt: c.excerpt.slice(0, 160) })),
    lenses: lensResults.map((l) => ({ id: l.id, headline: l.headline, questions: l.questions, sections: l.sections })),
    reach: reach.toJSON(),
  }, (k, v) => (v instanceof Set ? [...v] : v), 2));
  process.exit(0);
}

// ── html ─────────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function tile(label, value, note = "") {
  return `<div class="tile"><div class="tile-v">${esc(value)}</div><div class="tile-l">${esc(label)}</div>${note ? `<div class="tile-n">${esc(note)}</div>` : ""}</div>`;
}
function table(cols, rows, cls = "") {
  return `<div class="tw"><table class="${cls}"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

// Context curve — the session's shape in one line.
function contextChart(series, peak, w = 900, h = 140) {
  if (!series.length) return "<p class='muted'>no usage rows</p>";
  const maxSec = Math.max(1, ...series.map((p) => p.sec));
  const maxCtx = Math.max(1, peak);
  const pts = series.map((p) => `${((p.sec / maxSec) * w).toFixed(1)},${(h - (p.ctx / maxCtx) * h).toFixed(1)}`);
  const compactions = events.filter((e) => e.kind === "compaction").map((e) => (off(e.ts) / maxSec) * w);
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" preserveAspectRatio="none" role="img" aria-label="context size over time">
  <polyline points="${pts.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2"/>
  <polygon points="0,${h} ${pts.join(" ")} ${w},${h}" fill="var(--accent)" opacity=".12"/>
  ${compactions.map((x) => `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${h}" stroke="var(--warn)" stroke-width="2" stroke-dasharray="4 3"/>`).join("")}
</svg>`;
}

// Per-minute activity, stacked by what the call was for.
const CAT_COLORS = {
  test: "--ok", typecheck: "--ok", build: "--ok", lint: "--ok",
  write: "--accent", inspect: "--muted-2", git: "--muted-2",
  "speckit-script": "--lens", skill: "--lens", install: "--muted-2",
  "run-app": "--warn", format: "--muted-2", other: "--muted-2",
};
function activityChart(minutes, w = 900, h = 120) {
  // at most 240 bars: a 15-hour session is 900 minutes, and one <rect> per minute bloats the page
  const per = Math.max(1, Math.ceil(minutes.length / 240));
  const grid = [];
  for (let i = 0; i < minutes.length; i += per) {
    const b = {};
    for (const m of minutes.slice(i, i + per)) for (const [k, n] of Object.entries(m)) b[k] = (b[k] || 0) + n;
    grid.push(b);
  }
  const max = Math.max(1, ...grid.map((m) => Object.values(m).reduce((a, b) => a + b, 0)));
  const bw = w / grid.length;
  let out = "";
  grid.forEach((m, i) => {
    let y = h;
    for (const [cat, n] of Object.entries(m).sort()) {
      const bh = (n / max) * h;
      y -= bh;
      out += `<rect x="${(i * bw).toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0.8, bw - 0.6).toFixed(2)}" height="${bh.toFixed(2)}" fill="var(${CAT_COLORS[cat] || "--muted-2"})"><title>min ${i * per}: ${n} × ${cat}</title></rect>`;
    }
  });
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" preserveAspectRatio="none" role="img" aria-label="tool calls per minute">${out}</svg>`;
}

function histChart(bins) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  return `<div class="hist">${bins.filter((b) => b.count).map((b) => `
    <div class="hist-row"><span class="hist-l">${fmtN(b.lo)}–${b.hi === Infinity ? "∞" : fmtN(b.hi)}</span>
    <span class="hist-bar"><i style="width:${(b.count / max) * 100}%"></i></span>
    <span class="hist-n">${b.count}</span></div>`).join("")}</div>`;
}

// Verification timeline — one mark per run, positioned in time.
function verifyStrip(runs, duration, w = 900, h = 44) {
  if (!runs.length) return `<p class="warn-box">No test, typecheck, lint or build command ran in the main thread.${subagentCount ? ` ${subagentCount} subagent${subagentCount === 1 ? "" : "s"} ran separately; their checks are not counted here.` : ""}</p>`;
  const max = Math.max(1, duration);
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" preserveAspectRatio="none" role="img" aria-label="verification runs over time">
  <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="var(--border)" stroke-width="1"/>
  ${runs.map((r) => {
    const x = (r.offsetSec / max) * w;
    const color = r.ok === false ? "--bad" : r.category === "test" ? "--ok" : "--accent";
    return `<circle cx="${x.toFixed(1)}" cy="${h / 2}" r="${r.ok === false ? 7 : 5}" fill="var(${color})"><title>${Math.floor(r.offsetSec / 60)}m — ${r.category}${r.ok === false ? " FAILED" : ""} — ${r.resultLines} lines</title></circle>`;
  }).join("")}
</svg>`;
}

const prod = msg.production;
const producedTotal = prod.textChars + prod.thinkChars + prod.toolInputChars || 1;

const genericSections = `
<section>
  <h2>Token ledger — main thread</h2>
  <p class="cap">Main thread only. Subagents keep their own transcripts; the cost panel adds them in.</p>
  <div class="tiles">
    ${tile("API calls", fmtN(tok.apiCallCount))}
    ${tile("output", fmtN(tok.totals.output), "exact, billed")}
    ${tile("input (fresh)", fmtN(tok.totals.input))}
    ${tile("cache read", fmtN(tok.totals.cacheRead), "cache-dominated by construction")}
    ${tile("cache write", fmtN(tok.totals.cacheCreate))}
    ${tile("peak context", fmtN(tok.peakContext), `${tok.compactions} compaction${tok.compactions === 1 ? "" : "s"}`)}
  </div>
  <h3>Context size per API call</h3>
  ${contextChart(tok.ctxSeries, tok.peakContext)}
  <p class="cap">Dashed lines are compactions (automatic or a typed /compact). A sawtooth means the window was the binding constraint; a straight climb means it was not.</p>
</section>

<section>
  <h2>Rhythm</h2>
  ${activityChart(act.grid)}
  <p class="cap">Tool calls per minute, stacked by what the call was for: <b class="k-ok">verification</b>, <b class="k-accent">writing</b>, <b class="k-lens">workflow scripts &amp; skills</b>, <b class="k-muted">inspecting / git / other</b>. Hover a bar for the counts.</p>
</section>

<section>
  <h2>Did it check its own work? (main thread)</h2>
  ${verifyStrip(ver.verify, meta.durationSec)}
  <div class="tiles">
    ${tile("verification runs", String(ver.summary.verifyRuns), `${ver.summary.verifyFailed} failed`)}
    ${tile("first run at", ver.summary.firstVerifyOffsetSec == null ? "never" : `${Math.floor(ver.summary.firstVerifyOffsetSec / 60)}m`, `after ${ver.summary.writesBeforeFirstVerify} file writes`)}
    ${tile("worst blind stretch", `${ver.summary.worstBlindStretch} writes`, `median ${ver.summary.medianBlindStretch} between runs`)}
    ${tile("output cost", `~${fmtN(ver.summary.verifyOutputTokensEst)}`, `${pct(ver.summary.verifyOutputChars, ver.summary.allToolResultChars)}% of all tool output`)}
    ${tile("re-printed", `~${fmtN(ver.summary.repeatedOutputTokensEst)}`, "identical output seen again")}
    ${tile("quiet runs", `${ver.summary.filteredRuns}/${ver.summary.verifyRuns}`, "piped through head/grep or a quiet reporter")}
  </div>
  ${table(["category", "runs", "failed", "~tokens out", "lines"],
    Object.entries(ver.byCategory).sort((a, b) => b[1].chars - a[1].chars)
      .map(([c, b]) => [c, b.runs, b.failed, `~${fmtN(estTokens(b.chars))}`, fmtN(b.lines)]))}
  <p class="cap">Categories come from the command text with heredoc bodies and quoted strings removed, so a file that mentions the test runner is not counted as a test run.</p>
</section>

<section>
  <h2>Message shape</h2>
  <div class="tiles">
    ${tile("assistant text blocks", String(msg.texts.length))}
    ${tile("median length", `${fmtN(msg.charStats.median)} ch`, `p90 ${fmtN(msg.charStats.p90)} · max ${fmtN(msg.charStats.max)}`)}
    ${tile("narration", `${pct(msg.narrationChars, prod.textChars)}%`, `${msg.narration.length} blocks written mid-run, for no reader`)}
    ${tile("human turns", String(msg.humans.length), `${msg.injected.length} further user turns were harness-injected`)}
  </div>
  ${histChart(msg.histogram)}
  <h3>Where the output tokens came from</h3>
  ${table(["source", "~tokens", "share"], [
    ["tool inputs (file writes, commands)", `~${fmtN(estTokens(prod.toolInputChars))}`, `${pct(prod.toolInputChars, producedTotal)}%`],
    ["assistant prose", `~${fmtN(estTokens(prod.textChars))}`, `${pct(prod.textChars, producedTotal)}%`],
    ["thinking (as stored)", `~${fmtN(estTokens(prod.thinkChars))}`, `${pct(prod.thinkChars, producedTotal)}%`],
    ["— exact output_tokens —", fmtN(msg.outputTokensExact), ""],
    ["tool results read back in", `~${fmtN(estTokens(prod.resultChars))}`, "input side"],
  ])}
  <p class="cap">The estimate sums to ${pct(msg.outputTokensEstFromChars, msg.outputTokensExact)}% of the exact billed output. The gap is billed output the transcript does not keep as text (thinking, and whatever the chars ÷ 4 estimate misses); this page cannot split it further.</p>
</section>

<section>
  <h2>Tools (main thread)</h2>
  ${table(["tool", "calls", "failed", "~tokens returned"],
    tools.slice(0, 20).map((t) => [t.tool, t.count, t.failed || "", `~${fmtN(estTokens(t.resultChars))}`]))}
  ${failures.length ? `<h3>Failures (${failures.length})</h3>${table(["at", "tool", "what"],
    failures.slice(0, 15).map((c) => [`${Math.floor(off(c.ts) / 60)}m`, c.tool, (c.command || c.filePath || "").replace(/\s+/g, " ").slice(0, 70) + " → " + c.excerpt.replace(/\s+/g, " ").slice(0, 80)]))}` : ""}
</section>`;

const lensHtml = lensResults.map((l) => `
<section class="lens">
  <h2>${esc(l.title)}</h2>
  ${l.headline?.length ? `<div class="tiles">${l.headline.map((t) => tile(t.label, t.value, t.note)).join("")}</div>` : ""}
  ${l.questions?.length ? `<div class="qa">${l.questions.map((q) => `
    <div class="q"><div class="q-q">${esc(q.q)}</div><div class="q-a">${esc(q.a)}</div>${q.detail ? `<div class="q-d">${esc(q.detail)}</div>` : ""}</div>`).join("")}</div>` : ""}
  ${(l.sections || []).map((s) => `
    <h3>${esc(s.title)}</h3>
    ${s.table ? table(s.table.cols, s.table.rows) : ""}
    ${s.note ? `<p class="cap">${esc(s.note)}</p>` : ""}`).join("")}
</section>`).join("");

const html = `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session ${esc(meta.sessionId.slice(0, 8))} — ${esc((meta.cwd || "").split(/[\\/]/).pop())}</title>
<style>
:root{
  --bg:#fbfbfa; --fg:#1d1d1b; --muted:#6b6b66; --muted-2:#b4b4ae; --border:#e3e3de;
  --card:#ffffff; --accent:#3b6ea5; --ok:#3f8f5f; --warn:#c08a2e; --bad:#b4483c; --lens:#7a5aa8;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --bg:#16171a; --fg:#e7e7e3; --muted:#9a9a94; --muted-2:#55565a; --border:#2b2d31;
  --card:#1d1f23; --accent:#6c9dd6; --ok:#63b585; --warn:#d6ab5c; --bad:#d97367; --lens:#a88ad0;
}}
:root[data-theme="dark"]{
  --bg:#16171a; --fg:#e7e7e3; --muted:#9a9a94; --muted-2:#55565a; --border:#2b2d31;
  --card:#1d1f23; --accent:#6c9dd6; --ok:#63b585; --warn:#d6ab5c; --bad:#d97367; --lens:#a88ad0;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;}
.wrap{max-width:1000px;margin:0 auto;padding:32px 16px 80px}
header{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:24px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:17px;margin:0 0 12px;letter-spacing:.01em}
h3{font-size:14px;margin:22px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:18px}
section.lens{border-left:3px solid var(--lens)}
.sub{color:var(--muted);font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0 16px}
.tile{border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:var(--bg)}
.tile-v{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.tile-l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.tile-n{font-size:12px;color:var(--muted);margin-top:5px;line-height:1.35}
.tw{overflow-x:auto;max-width:100%}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin:6px 0}
th{text-align:left;font-weight:600;color:var(--muted);border-bottom:1px solid var(--border);padding:6px 8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
td{padding:6px 8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;vertical-align:top}
tr:last-child td{border-bottom:none}
.chart{width:100%;height:auto;display:block;margin:10px 0}
.cap{font-size:12.5px;color:var(--muted);margin:6px 0 0}
.hist{margin:10px 0}
.hist-row{display:flex;align-items:center;gap:10px;font-size:12.5px;font-variant-numeric:tabular-nums}
.hist-l{width:90px;text-align:right;color:var(--muted)}
.hist-bar{flex:1;background:var(--bg);border:1px solid var(--border);height:14px;border-radius:3px;overflow:hidden}
.hist-bar i{display:block;height:100%;background:var(--accent)}
.hist-n{width:40px;color:var(--muted)}
.qa{display:grid;gap:10px;margin:8px 0 4px}
.q{border:1px solid var(--border);border-radius:8px;padding:12px 14px;background:var(--bg)}
.q-q{font-weight:600;font-size:14px}
.q-a{color:var(--lens);font-weight:600;margin-top:4px}
.q-d{color:var(--muted);font-size:13px;margin-top:6px}
.warn-box{background:var(--bg);border:1px solid var(--bad);color:var(--bad);border-radius:8px;padding:10px 12px;font-size:14px}
.k-ok{color:var(--ok)} .k-accent{color:var(--accent)} .k-lens{color:var(--lens)} .k-muted{color:var(--muted)}
footer{color:var(--muted);font-size:12.5px;margin-top:8px}
footer code{background:var(--card);padding:1px 4px;border-radius:3px}
button{position:fixed;top:12px;right:12px;background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer}
@media (max-width:600px){ .wrap{padding:20px 16px 60px} .hist-l{width:64px} }
</style>
</head>
<body>
<button onclick="document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'">theme</button>
<div class="wrap">
<header>
  <h1>${esc((meta.cwd || "session").split(/[\\/]/).pop())} — session ${esc(meta.sessionId.slice(0, 8))}</h1>
  <div class="sub">${esc(meta.model)} · ${esc(fmtDuration(meta.durationSec))} · ${calls.length} tool calls · ${failures.length} failed · started ${esc(meta.startTime)}</div>
  <div class="sub">${esc(meta.cwd)}</div>
</header>
${lensHtml}
${genericSections}
<footer>
  <p><b>How to read the numbers.</b> Token figures marked <code>~</code> are estimated from character counts (chars ÷ 4); everything else comes from the transcript's own usage rows, counted once per API call. Command categories are inferred from the command text after heredoc bodies and quoted strings are removed. Phase boundaries in a workflow panel are inferred from skill calls, workflow scripts and the artifacts they own — a workflow skill is loaded once per session, so counting skill invocations alone under-reports every repeat.</p>
  <p>${esc(reach.line())}</p>
  <p>Generated by <code>session-dashboard.mjs</code> from <code>${esc(path)}</code>.</p>
</footer>
</div>
</body>
</html>`;

const outPath = val("-o") || val("--out") || `session-${meta.sessionId.slice(0, 8)}-dashboard.html`;
writeFileSync(outPath, html, "utf8");
console.log(`wrote ${outPath}  (${(html.length / 1024).toFixed(0)} KB)`);
console.log(`lenses: ${lensResults.length ? lensResults.map((l) => l.id).join(", ") : "none"}`);
console.log(reach.line());
