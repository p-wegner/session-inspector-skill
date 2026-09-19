/**
 * lenses/cost.mjs — the cost lens: "this session was expensive; what do I change?"
 *
 * The generic half of the dashboard counts TOKENS. A person deciding what to do
 * differently needs DOLLARS, attributed to something they can change: the context
 * they let grow, the pauses that let the cache expire, the dumps they pulled into
 * context, the subagents they spawned. So every figure here is in $ at list price
 * (lib/quota.mjs), and the levers at the end are ranked by what they would save.
 *
 * Two kinds of number, labelled differently everywhere they appear:
 *   EXACT      — from the transcript's own usage rows, one per API call
 *                (lib/usage.mjs rule): totals, token-type split, per model,
 *                per hour, per subagent, cold re-writes.
 *   ESTIMATED  — (`~`) from characters (chars/4) × how many later calls re-read
 *                them: the cost of one injection, of a re-read, of repeated output.
 *                A transcript has no per-block usage, so this is the only honest way.
 *
 * Subagents are part of the session's cost. Their transcripts sit in
 * <session>/subagents/*.jsonl (plus .meta.json with the task description) and are
 * read here directly; the main transcript alone under-reports a delegating session.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { priceFor } from "../quota.mjs";
import { estTokens, fmtN, claudeTurns, classifyCommand } from "../turns.mjs";

export const id = "cost";
export const title = "Cost — what it cost, where the money went, what to change";

/** Every session with usage gets the lens; cost is a question about any session. */
export function detect({ apiCalls }) {
  return apiCalls.length > 0;
}

// ── pricing ──────────────────────────────────────────────────────────────────

/** $ of one API call, split by token type. Cache writes: 2x input (1h), 1.25x (5m). */
function callCost(c) {
  const p = priceFor(c.model);
  const cw5 = Math.max(0, c.cacheCreate - c.cacheCreate1h);
  const parts = {
    input: (c.input * p.in) / 1e6,
    output: (c.output * p.out) / 1e6,
    cacheWrite: (c.cacheCreate1h * p.in * 2 + cw5 * p.in * 1.25) / 1e6,
    cacheRead: (c.cacheRead * p.in * p.cr) / 1e6,
  };
  parts.total = parts.input + parts.output + parts.cacheWrite + parts.cacheRead;
  return parts;
}
const crPrice = (model) => { const p = priceFor(model); return (p.in * p.cr) / 1e6; };

const $ = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "0%");
const shortModel = (m) => String(m || "?").replace(/^claude-/, "").replace(/-\d{8}$/, "");
const tsMs = (t) => (t ? new Date(t).getTime() : 0);
const count = (n) => Number(n).toLocaleString("en-US"); // exact counts: "1,449 calls", never "1k"
const HOOK_PROMPT = /^(Stop hook feedback|Goal check-in)/;

// ── the fixed prefix ─────────────────────────────────────────────────────────

/**
 * What a thread loads before any work: CLAUDE.md and memory files (`instructions`
 * attachment, one entry per file) and the skill listing. Each is re-read on every
 * later call of that thread, and every subagent loads its own copy, so a 20k-token
 * CLAUDE.md stack in a session with nine subagents is paid ten times over.
 * Characters only (estimated); the thread's first call gives the exact floor.
 */
function readPrefix(file) {
  const parts = [];
  if (!file || !existsSync(file)) return parts;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"attachment"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const a = o.attachment;
    if (!a) continue;
    if (a.type === "instructions") for (const f of a.files || [])
      parts.push({ ts: o.timestamp, key: f.path, name: `${f.path.split(/[\\/]/).slice(-2).join("/")} (${f.type || "?"})`, kind: "instructions", chars: (f.content || "").length });
    // a CLAUDE.md below the cwd, attached when the agent first touches that directory
    else if (a.type === "nested_memory")
      parts.push({ ts: o.timestamp, key: a.path, name: `${String(a.displayPath || a.path).split(/[\\/]/).slice(-2).join("/")} (nested)`, kind: "instructions",
        chars: typeof a.content === "string" ? a.content.length : JSON.stringify(a.content || "").length });
    // the full listing is sent once (isInitial) and again after a compaction; later
    // entries are small deltas that ADD to it, so they are a separate part, not a reload
    else if (a.type === "skill_listing")
      parts.push(a.isInitial === false
        ? { ts: o.timestamp, key: `skill listing update ${parts.length}`, name: "skill listing updates", kind: "skills", chars: (a.content || "").length }
        : { ts: o.timestamp, key: "skill listing", name: `skill listing (${a.skillCount ?? "?"} skills)`, kind: "skills", chars: (a.content || "").length });
  }
  return parts;
}

/**
 * Claude Code's own running total (`cost-state` rows; the last one wins). It includes
 * calls that write no usage row to the transcript (compaction summaries, Haiku side
 * calls, title generation), so it is the ceiling the transcript total is compared to.
 */
function readCostState(file) {
  let last = null;
  if (!file || !existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"cost-state"')) continue;
    try { const o = JSON.parse(line); if (o.type === "cost-state") last = o; } catch {}
  }
  return last;
}

// ── subagents ────────────────────────────────────────────────────────────────

/** All nested transcripts under <session>/ (subagents, workflows), usage deduped per file. */
function readSubagents(path) {
  if (!path || !path.endsWith(".jsonl")) return [];
  const dir = path.slice(0, -".jsonl".length);
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(dir);
  return files.map((f) => {
    const metaPath = f.replace(/\.jsonl$/, ".meta.json");
    let meta = {};
    try { if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch {}
    const seen = new Map(); // id -> call; output grows across a subagent's rows, keep the max
    const calls = [];
    let firstPrompt = "";
    let lastText = "";
    const files = new Set();
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = o.message;
      if (!m) continue;
      if (!firstPrompt && o.type === "user" && typeof m.content === "string") firstPrompt = m.content;
      // its final report is the last text it wrote; that is what the main thread gets back
      if (o.type === "assistant" && Array.isArray(m.content)) for (const b of m.content) {
        if (b.type === "text" && b.text) lastText = b.text;
        const fp = b.type === "tool_use" && (b.input?.file_path || b.input?.notebook_path);
        if (fp) files.add(String(fp).replace(/\\/g, "/").toLowerCase());
      }
      if (o.type !== "assistant" || !m.usage) continue;
      const u = m.usage;
      if (m.id && seen.has(m.id)) { const c = seen.get(m.id); c.output = Math.max(c.output, u.output_tokens || 0); continue; }
      calls.push({
        ts: o.timestamp, model: m.model || "",
        input: u.input_tokens || 0, output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0,
        cacheCreate1h: u.cache_creation?.ephemeral_1h_input_tokens || 0,
        ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0),
      });
      if (m.id) seen.set(m.id, calls[calls.length - 1]);
    }
    const cost = calls.reduce((a, c) => a + callCost(c).total, 0);
    const models = [...new Set(calls.map((c) => shortModel(c.model)).filter((m) => m !== "<synthetic>"))];
    return {
      path: f, toolUseId: meta.toolUseId || "",
      file: basename(f, ".jsonl"),
      kind: f.includes(`${join("", "workflows")}`) ? "workflow" : "subagent",
      description: meta.description || firstPrompt.replace(/\s+/g, " ").slice(0, 90),
      agentType: meta.agentType || "",
      calls, cost, models,
      start: calls[0]?.ts, end: calls[calls.length - 1]?.ts,
      peakCtx: calls.reduce((m, c) => Math.max(m, c.ctx), 0),
      reportTok: estTokens(lastText.length),
      files,
      reportHead: lastText.replace(/\s+/g, " ").slice(0, 90),
    };
  }).filter((s) => s.calls.length);
}

// ── per-thread carry: what one thread put into its context, and what that cost ──

const OWN_WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELLS = new Set(["Bash", "PowerShell"]);
const VERIFY = new Set(["test", "typecheck", "lint", "build", "run-app"]);
// driving a browser or taking screenshots is how UI work is checked; count it as verification
const BROWSER_CHECK = /\bplaywright(-cli)?\b|\bpuppeteer\b|\bscreenshot\b|\bchrome(-headless)?\b.*--(screenshot|print-to-pdf)/i;
const HEREDOC_WRITE = /(?:cat|tee)\b[^\n]*>\s*\S+[^\n]*<<|<<-?\s*['"]?\w+['"]?[^\n]*>\s*\S+/;

/**
 * One thread (the main thread or one subagent) as carry cost: every piece of content
 * × the calls of THAT thread that re-read it before a compaction, at that thread's
 * cache-read price. Subagents have their own context, so each is costed on its own
 * calls — a result a subagent pulled in is re-billed by the subagent, not by main.
 */
function threadCarry(label, { events, calls, apiCalls }) {
  const callTs = apiCalls.map((c) => tsMs(c.ts));
  const compTs = events.filter((e) => e.kind === "compaction").map((e) => tsMs(e.ts)).sort((a, b) => a - b);
  const cr = crPrice(apiCalls[0]?.model);
  const laterCalls = (t) => {
    const until = compTs.find((x) => x > t) ?? Infinity;
    let n = 0;
    for (const x of callTs) if (x > t && x <= until) n++;
    return n;
  };
  // Size of one tool result: chars/4 undercounts code and JSON. When a result is the ONLY
  // thing added between two API calls, the next call's cache write + fresh input is its
  // exact size once the previous call's own output is taken off: measured, not estimated.
  const resultTs = calls.filter((c) => c.resultChars > 0).map((c) => tsMs(c.ts)).sort((a, b) => a - b);
  const measuredSize = (t) => {
    const j = callTs.findIndex((x) => x > t);
    if (j <= 0) return null;
    const between = resultTs.filter((x) => x >= callTs[j - 1] && x < callTs[j]).length;
    // the new cache write also holds the previous call's own output (its text and tool call)
    return between === 1 ? Math.max(0, apiCalls[j].cacheCreate + apiCalls[j].input - apiCalls[j - 1].output) : null;
  };
  const injections = calls.filter((c) => c.resultChars > 0).map((c) => {
    const est = estTokens(c.resultChars);
    const later = laterCalls(tsMs(c.ts));
    return { label, c, tok: est, later, cost: est * later * cr };
  }).sort((a, b) => b.cost - a.cost).slice(0, 40).map((x) => {
    const m = measuredSize(tsMs(x.c.ts));
    return m && m > x.tok ? { ...x, tok: m, measured: true, cost: m * x.later * cr } : x;
  }).sort((a, b) => b.cost - a.cost);

  const fill = new Map();
  const addFill = (kind, chars, ts) => {
    if (!chars) return;
    const e = fill.get(kind) || { tok: 0, cost: 0 };
    const tok = estTokens(chars);
    e.tok += tok; e.cost += tok * laterCalls(tsMs(ts)) * cr;
    fill.set(kind, e);
  };
  const verify = { runs: 0, tok: 0, cost: 0 };
  const rewrites = new Map(); // file -> { n, cost } for whole-file writes (Write, heredoc)
  for (const c of calls) {
    addFill(`tool results: ${c.tool.startsWith("Agent") ? "subagent reports" : SHELLS.has(c.tool) ? "shell output" : c.tool}`, c.resultChars, c.ts);
    const inKind = c.tool === "Write" ? "own whole-file writes (Write input)"
      : OWN_WRITES.has(c.tool) ? "own edits (Edit input)"
      : SHELLS.has(c.tool) ? (HEREDOC_WRITE.test(c.command) ? "own heredoc file writes (shell input)" : "own shell commands (input)")
      : "other tool inputs";
    addFill(inKind, c.inputChars, c.ts);
    if (/whole-file|heredoc/.test(inKind)) {
      const f = (c.filePath || (c.command.match(/>\s*['"]?([^\s'"<>|;&]+)/) || [])[1] || "?").split(/[\\/]/).pop();
      const e = rewrites.get(f) || { n: 0, cost: 0 };
      e.n++; e.cost += estTokens(c.inputChars) * laterCalls(tsMs(c.ts)) * cr;
      rewrites.set(f, e);
    }
    if (SHELLS.has(c.tool) && (VERIFY.has(classifyCommand(c.command)) || BROWSER_CHECK.test(c.command))) {
      const tok = estTokens(c.resultChars);
      verify.runs++; verify.tok += tok; verify.cost += tok * laterCalls(tsMs(c.ts)) * cr;
    }
  }
  for (const e of events) {
    if (e.kind === "assistant_text") addFill("assistant prose", e.chars, e.ts);
    else if (e.kind === "user") addFill(e.role === "human" ? "human prompts" : "injected user text (hooks, skills, notices)", e.chars, e.ts);
  }

  // re-reads: same file, same view, no write to it in between, no compaction in between
  const lastRead = new Map(), lastWrite = new Map();
  const reread = { tok: 0, cost: 0, n: 0, files: new Map() };
  for (const c of calls) {
    if (OWN_WRITES.has(c.tool) && c.filePath) lastWrite.set(c.filePath, tsMs(c.ts));
    if (c.tool !== "Read" || !c.filePath) continue;
    const key = `${c.filePath}|${c.range}`;
    const prev = lastRead.get(key);
    const t = tsMs(c.ts);
    if (prev != null && (lastWrite.get(c.filePath) ?? -1) < prev && !compTs.some((x) => x > prev && x < t)) {
      const tok = estTokens(c.resultChars);
      const cst = tok * laterCalls(t) * cr;
      reread.tok += tok; reread.n++; reread.cost += cst;
      reread.files.set(c.filePath, (reread.files.get(c.filePath) || 0) + cst);
    }
    lastRead.set(key, t);
  }
  // repeated identical tool output (same full-text hash seen before)
  const seenHash = new Set();
  const repeat = { tok: 0, cost: 0 };
  for (const c of calls) {
    if (!c.hash) continue;
    if (seenHash.has(c.hash)) { const tok = estTokens(c.resultChars); repeat.tok += tok; repeat.cost += tok * laterCalls(tsMs(c.ts)) * cr; }
    seenHash.add(c.hash);
  }
  // cold cache, judged against THIS thread's TTL (main threads usually 1h, subagents 5m)
  const ttlMin = apiCalls.some((c) => c.cacheCreate1h > 0) ? 60 : 5;
  const cold = [];
  let longestGap = 0;
  for (let i = 1; i < apiCalls.length; i++) {
    const gapMin = (tsMs(apiCalls[i].ts) - tsMs(apiCalls[i - 1].ts)) / 60000;
    longestGap = Math.max(longestGap, gapMin);
    const c = apiCalls[i];
    const afterCompaction = compTs.some((x) => x > tsMs(apiCalls[i - 1].ts) && x <= tsMs(c.ts));
    if (gapMin > ttlMin && c.cacheCreate > 20_000 && !afterCompaction) {
      const p = priceFor(c.model);
      const cw5 = Math.max(0, c.cacheCreate - c.cacheCreate1h);
      cold.push({ label, ts: c.ts, gapMin, tokens: c.cacheCreate, premium: (c.cacheCreate1h * p.in * (2 - 0.1) + cw5 * p.in * (1.25 - 0.1)) / 1e6 });
    }
  }
  return { label, injections, fill, verify, reread, repeat, rewrites, compTs, callTs, ttlMin, cold, longestGap };
}

// ── analysis ─────────────────────────────────────────────────────────────────

export function analyze({ meta, events, calls, apiCalls, path }) {
  const main = apiCalls.map((c) => ({ ...c, $: callCost(c) }));
  const subs = readSubagents(path).sort((a, b) => b.cost - a.cost);
  const mainCost = main.reduce((a, c) => a + c.$.total, 0);
  // overlap signal: files a subagent read or wrote that another subagent also touched
  for (const x of subs) {
    const others = new Set(subs.filter((y) => y !== x).flatMap((y) => [...y.files]));
    x.shared = [...x.files].filter((f) => others.has(f)).length;
  }
  const subCost = subs.reduce((a, s) => a + s.cost, 0);
  const total = mainCost + subCost;

  // token-type split and per model, main + subagents
  const all = [...main, ...subs.flatMap((s) => s.calls.map((c) => ({ ...c, $: callCost(c) })))];
  const byType = { cacheRead: 0, cacheWrite: 0, output: 0, input: 0 };
  const byModel = new Map();
  for (const c of all) {
    for (const k of Object.keys(byType)) byType[k] += c.$[k];
    const m = shortModel(c.model);
    const e = byModel.get(m) || { calls: 0, cost: 0 };
    e.calls++; e.cost += c.$.total; byModel.set(m, e);
  }

  // context shape (main thread)
  const ctxs = main.map((c) => c.ctx).sort((a, b) => a - b);
  const median = ctxs.length ? ctxs[Math.floor(ctxs.length / 2)] : 0;
  const peak = ctxs.length ? ctxs[ctxs.length - 1] : 0;
  const over200 = main.filter((c) => c.ctx > 200_000);
  const over200Cost = over200.reduce((a, c) => a + c.$.total, 0);
  const compactions = events.filter((e) => e.kind === "compaction").length;
  const subCalls = subs.flatMap((x) => x.calls.map((c) => ({ ...c, $: callCost(c) })));
  const subCtx = subCalls.map((c) => c.ctx).sort((a, b) => a - b);
  const subMedian = subCtx.length ? subCtx[Math.floor(subCtx.length / 2)] : 0;
  const subOver = subCalls.filter((c) => c.ctx > 200_000);

  // carry cost per thread, then merged: main + each subagent on its own calls
  const mainCarry = threadCarry("main", { events, calls, apiCalls });
  const subCarry = subs.map((x) => threadCarry(x.description.slice(0, 32), claudeTurns(readFileSync(x.path, "utf8").split("\n"))));
  const carries = [mainCarry, ...subCarry];
  const compTs = mainCarry.compTs;
  const injections = carries.flatMap((t) => t.injections).sort((a, b) => b.cost - a.cost);
  const sumOf = (k) => carries.reduce((a, t) => ({ tok: a.tok + t[k].tok, cost: a.cost + t[k].cost }), { tok: 0, cost: 0 });
  const reread = { ...sumOf("reread"), n: carries.reduce((a, t) => a + t.reread.n, 0) };
  const rereadFiles = new Map();
  for (const t of carries) for (const [f, v] of t.reread.files) rereadFiles.set(f, (rereadFiles.get(f) || 0) + v);
  const repeat = sumOf("repeat");
  const verifyAll = { ...sumOf("verify"), runs: carries.reduce((a, t) => a + t.verify.runs, 0), mainRuns: mainCarry.verify.runs };
  const cold = carries.flatMap((t) => t.cold);
  const coldPremium = cold.reduce((a, c) => a + c.premium, 0);
  const ttlMin = mainCarry.ttlMin;
  const subTtls = [...new Set(subCarry.map((t) => t.ttlMin))];
  const ttlText = `main ${ttlMin === 60 ? "1 h" : "5 min"}${subTtls.length ? `, subagents ${subTtls.map((m) => (m === 60 ? "1 h" : "5 min")).join("/")}` : ""}`;
  const longestGap = Math.max(0, ...carries.map((t) => t.longestGap));

  // Calibrate the character estimates: where a tool result's size was MEASURED (the next
  // call's cache write), compare it to chars/4. Markdown, code and JSON tokenise denser
  // than prose, so chars/4 runs low; the median ratio corrects every estimate on the page.
  // only results of 1k+ tokens: on a small one the tool call's own framing dominates the ratio
  const ratios = injections.filter((x) => x.measured && estTokens(x.c.resultChars) >= 1000).map((x) => x.tok / Math.max(1, estTokens(x.c.resultChars))).sort((a, b) => a - b);
  const calib = ratios.length >= 3 ? Math.min(2, Math.max(1, ratios[Math.floor(ratios.length / 2)])) : 1;
  const K = (n) => n * calib;
  for (const x of injections) if (!x.measured) { x.tok = Math.round(K(x.tok)); x.cost = K(x.cost); }
  injections.sort((a, b) => b.cost - a.cost);
  for (const o of [reread, repeat, verifyAll]) { o.tok = Math.round(K(o.tok)); o.cost = K(o.cost); }
  const costState = readCostState(path);

  // the fixed prefix, per thread: named parts (estimated) and the exact floor (first call's context)
  const threads = [{ file: path, calls: main, compTs: mainCarry.compTs }, ...subs.map((x, i) => ({ file: x.path, calls: x.calls, compTs: subCarry[i].compTs }))];
  const prefixByKey = new Map();
  let floorCost = 0;
  for (const th of threads) {
    if (!th.calls.length) continue;
    const thCr = crPrice(th.calls[0].model);
    const first = th.calls[0];
    floorCost += (first.ctx + first.cacheCreate) * th.calls.length * thCr;
    const ts = th.calls.map((c) => tsMs(c.ts));
    // a compaction re-attaches the same file: each load is carried until the next load of it
    const parts = readPrefix(th.file);
    const seenInThread = new Set();
    parts.forEach((part, i) => {
      const t = tsMs(part.ts);
      const next = parts.slice(i + 1).find((q) => q.key === part.key);
      // carried until it is re-attached. A compaction does NOT drop it: measured 2026-09-19 on
      // two sessions, the first call after a compaction is the first call's size plus the
      // summary (65k -> 74k, 93k -> 107k), so the whole prefix survives, skill listing included
      const until = next ? tsMs(next.ts) : Infinity;
      const n = ts.filter((x) => x >= t && x < until).length;
      // prose (CLAUDE.md, the skill listing) tokenises close to chars/4; the calibration
      // factor is measured on tool output (code, JSON) and would oversize it by a third
      const tok = estTokens(part.chars);
      const gk = part.name === "skill listing updates" ? "skill listing updates" : part.key;
      const e = prefixByKey.get(gk) || { name: part.name, kind: part.kind, tok, threads: 0, loads: 0, cost: 0, subCost: 0 };
      if (!seenInThread.has(gk)) { e.threads++; seenInThread.add(gk); }
      e.loads++; e.cost += tok * n * thCr;
      if (th.file !== path) e.subCost += tok * n * thCr;
      prefixByKey.set(gk, e);
    });
  }
  const prefixParts = [...prefixByKey.values()].sort((a, b) => b.cost - a.cost);
  const instrCost = prefixParts.filter((x) => x.kind === "instructions").reduce((a, x) => a + x.cost, 0);
  const skillCost = prefixParts.filter((x) => x.kind === "skills").reduce((a, x) => a + x.cost, 0);
  const subPrefixCost = prefixParts.reduce((a, x) => a + x.subCost, 0);
  const mainPrefixCost = instrCost + skillCost - subPrefixCost;

  // what the context filled up with, by kind, across threads
  const fillMap = new Map();
  for (const t of carries) for (const [k0, v] of t.fill) {
    const e = fillMap.get(k0) || { tok: 0, cost: 0, main: 0, sub: 0 };
    const k = /^(tool results|own |other tool)/.test(k0) ? calib : 1; // code-like content only
    e.tok += Math.round(v.tok * k); e.cost += v.cost * k; e[t === mainCarry ? "main" : "sub"] += v.cost * k;
    fillMap.set(k0, e);
  }
  const fillRows = [...fillMap.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.cost - a.cost);
  const fillTotal = fillRows.reduce((a, x) => a + x.cost, 0);
  const own = fillRows.filter((x) => x.k.startsWith("own "));
  const ownCost = own.reduce((a, x) => a + x.cost, 0);
  const rewriteFiles = new Map();
  for (const t of carries) for (const [f, v] of t.rewrites) { const e = rewriteFiles.get(f) || { n: 0, cost: 0 }; e.n += v.n; e.cost += K(v.cost); rewriteFiles.set(f, e); }
  const topRewrites = [...rewriteFiles.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 3).map(([f, v]) => `${f} ×${v.n} (~${$(v.cost)})`).join(", ");
  const wholeWrites = fillRows.filter((x) => /whole-file|heredoc/.test(x.k)).reduce((a, x) => a + x.cost, 0);

  // one ranking of everything that sat in context: tool results, plus the prefix as groups
  const stackFiles = prefixParts.filter((x) => x.kind === "instructions");
  const merged = [
    ...injections.slice(0, 12).map((x) => ({ source: `${x.c.tool} result`, what: (x.c.filePath || x.c.command || x.c.description || "").replace(/\s+/g, " ").slice(0, 70), thread: x.label, tok: `${x.measured ? "=" : "~"}${fmtN(x.tok)}`, cost: x.cost })),
    ...(stackFiles.length ? [{ source: "CLAUDE.md / memory stack", what: `${stackFiles.length} files, loaded before any work`, thread: `${Math.max(...stackFiles.map((x) => x.threads))} thread(s)`, tok: `~${fmtN(stackFiles.reduce((a, x) => a + x.tok, 0))}`, cost: instrCost }] : []),
    ...prefixParts.filter((x) => x.kind === "skills").map((x) => ({ source: "skill listing", what: x.name, thread: `${x.threads} thread(s)`, tok: `~${fmtN(x.tok)}`, cost: x.cost })),
  ].sort((a, b) => b.cost - a.cost);

  // costliest hour (main + subagents), and what was going on in it
  // Costliest 60-minute stretches: a window sliding over every call (main + subagents),
  // not clock hours, so a stretch that straddles an hour boundary is not split in two.
  const t0 = tsMs(meta.startTime);
  const WIN = 3_600_000;
  const priced = [...main.map((c) => ({ t: tsMs(c.ts), $: c.$.total, sub: false, ctx: c.ctx })),
    ...subs.flatMap((s) => s.calls.map((c) => ({ t: tsMs(c.ts), $: callCost(c).total, sub: true })))].sort((a, b) => a.t - b.t);
  const windows = [];
  { let j = 0, sum = 0;
    for (let i = 0; i < priced.length; i++) {
      while (j < priced.length && priced[j].t < priced[i].t + WIN) sum += priced[j++].$;
      windows.push({ from: priced[i].t, to: priced[i].t + WIN, total: sum });
      sum -= priced[i].$;
    } }
  const topWindows = [];
  for (const w of windows.sort((a, b) => b.total - a.total)) {
    if (topWindows.length >= 3) break;
    if (topWindows.some((x) => w.from < x.to && x.from < w.to)) continue;
    const inW = priced.filter((q) => q.t >= w.from && q.t < w.to);
    const mainIn = inW.filter((q) => !q.sub);
    topWindows.push({ ...w,
      main: mainIn.reduce((a, q) => a + q.$, 0), sub: inW.filter((q) => q.sub).reduce((a, q) => a + q.$, 0),
      avgCtx: mainIn.length ? Math.round(mainIn.reduce((a, q) => a + q.ctx, 0) / mainIn.length) : 0,
      compactAfter: compTs.some((x) => x >= w.to - WIN / 4 && x < w.to + WIN / 2) });
  }
  const clock = (t) => new Date(t).toISOString().slice(11, 16);
  const winLabel = (w) => `${clock(w.from)}–${clock(w.to)} UTC (${((w.from - t0) / 3_600_000).toFixed(1)} h in)`;
  const describeHour = (w) => {
    const inHour = (t) => tsMs(t) >= w.from && tsMs(t) < w.to;
    const prompts = events.filter((e) => e.kind === "user" && e.role === "human" && inHour(e.ts)).map((e) => e.excerpt.replace(/\s+/g, " ").slice(0, 70));
    // with no human in the loop, say what drove it: a goal loop / stop hook re-entering
    const hooks = events.filter((e) => e.kind === "user" && e.role === "automated" && inHour(e.ts) && /^(Stop hook feedback|Goal check-in)/.test(e.excerpt || ""));
    const goal = hooks.map((e) => (e.excerpt.match(/Goal:\s*([^\]\n«»]+?)(?:\s+Last check|\]|»|$)/) || [])[1]).find(Boolean);
    const tools = new Map();
    for (const c of calls) if (inHour(c.ts)) tools.set(c.tool, (tools.get(c.tool) || 0) + 1);
    const top = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t}×${n}`).join(", ");
    const subsIn = subs.map((s) => ({ s, $: s.calls.filter((c) => inHour(c.ts)).reduce((a, c) => a + callCost(c).total, 0) }))
      .filter((x) => x.$ > 0.005).sort((a, b) => b.$ - a.$).map((x) => `${x.s.description.slice(0, 36)} ${$(x.$)}`);
    // what the hour produced, in the session's own words: commit subjects, then the files it wrote
    const commits = calls.filter((c) => inHour(c.ts) && /\bgit\b[^|;&]*\bcommit\b/.test(c.command))
      .map((c) => (c.command.match(/-m\s+"\$\(cat <<'?EOF'?\s*\n([^\n]+)/) || c.command.match(/-m\s+["']([^"'\n]+)/) || [])[1])
      .filter(Boolean).map((m) => m.slice(0, 70));
    const written = new Map();
    for (const c of calls) if (inHour(c.ts) && OWN_WRITES.has(c.tool) && c.filePath) { const f = c.filePath.split(/[\\/]/).pop(); written.set(f, (written.get(f) || 0) + 1); }
    const wrote = [...written.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f).join(", ");
    return [prompts.length ? `asked: "${prompts[0]}"${prompts.length > 1 ? ` (+${prompts.length - 1})` : ""}` : hooks.length ? `no human prompt; driven by a goal/stop-hook loop${goal ? ` «${goal.trim().slice(0, 60)}»` : ""} re-entering ${hooks.length}×` : "no human prompt", commits.length && `committed: "${commits[0]}"${commits.length > 1 ? ` (+${commits.length - 1})` : ""}`, wrote && `wrote: ${wrote}`, top && `tools: ${top}`, subsIn.length && `subagents: ${subsIn.slice(0, 2).join("; ")}${subsIn.length > 2 ? ` (+${subsIn.length - 2})` : ""}`].filter(Boolean).join(" · ");
  };


  // Who was steering: each main-thread call is attributed to the most recent prompt before
  // it, a person's or a goal/stop-hook re-entry. Loop-driven spend is the part nobody watched.
  const drivers = events.filter((e) => e.kind === "user" && (e.role === "human" || (e.role === "automated" && HOOK_PROMPT.test(e.excerpt || ""))))
    .map((e) => ({ t: tsMs(e.ts), loop: e.role !== "human", text: e.excerpt || "" })).sort((a, b) => a.t - b.t);
  let loopCost = 0, loopEntries = drivers.filter((d) => d.loop).length;
  { let k = -1;
    for (const c of main) {
      const t = tsMs(c.ts);
      while (k + 1 < drivers.length && drivers[k + 1].t <= t) k++;
      if (k >= 0 && drivers[k].loop) loopCost += c.$.total;
    } }
  const loopGoal = drivers.filter((d) => d.loop).map((d) => (d.text.match(/Goal:\s*([^\]\n«»]+?)(?:\s+Last check|\]|»|$)/) || [])[1]).find(Boolean);
  const humanPrompts = drivers.filter((d) => !d.loop).length;

  // Phases: the session cut where its direction could change: a human prompt or a
  // compaction. Each phase gets its $ (main + subagents), what launched it and what ran.
  const tEnd = Math.max(tsMs(meta.endTime), ...priced.map((q) => q.t));
  const cuts = [
    { t: t0, why: "session start" },
    ...events.filter((e) => e.kind === "user" && e.role === "human").map((e) => ({ t: tsMs(e.ts), why: `asked: "${e.excerpt.replace(/\s+/g, " ").slice(0, 60)}"` })),
    ...compTs.map((t) => ({ t, why: "after a compaction" })),
  ].sort((a, b) => a.t - b.t).filter((c, i, arr) => i === 0 || c.t - arr[i - 1].t > 60_000);
  const phases = cuts.map((c, i) => {
    const to = cuts[i + 1]?.t ?? tEnd + 1;
    const inP = priced.filter((q) => q.t >= c.t && q.t < to);
    const launched = calls.filter((x) => x.tool.startsWith("Agent") && tsMs(x.ts) >= c.t && tsMs(x.ts) < to);
    return { from: c.t, to, why: c.why, main: inP.filter((q) => !q.sub).reduce((a, q) => a + q.$, 0), sub: inP.filter((q) => q.sub).reduce((a, q) => a + q.$, 0), launched: launched.length,
      launchedWhat: launched.map((x) => x.description).filter(Boolean).slice(0, 3).join("; ") };
  }).map((ph) => ({ ...ph, total: ph.main + ph.sub }));
  const costliestPhase = [...phases].sort((a, b) => b.total - a.total)[0];

  // subagents grouped: by launch wave (started within 10 minutes of each other) and by role
  // (the first word of the task: Test / Fix / Review ...), so a round of testers reads as one line
  const bySubStart = [...subs].sort((a, b) => tsMs(a.start) - tsMs(b.start));
  const waves = [];
  for (const x of bySubStart) {
    const w = waves[waves.length - 1];
    if (w && tsMs(x.start) - w.last <= 10 * 60_000) { w.subs.push(x); w.last = tsMs(x.start); }
    else waves.push({ at: tsMs(x.start), last: tsMs(x.start), subs: [x] });
  }
  const roles = new Map();
  for (const x of subs) {
    const r = (x.description.match(/^\s*([A-Za-z]+)/)?.[1] || "?").toLowerCase();
    const e = roles.get(r) || { n: 0, cost: 0 };
    e.n++; e.cost += x.cost; roles.set(r, e);
  }

  // cost by context band: what one call cost as the context grew
  const BANDS = [[0, 100e3], [100e3, 200e3], [200e3, 500e3], [500e3, 800e3], [800e3, Infinity]];
  const bandRows = BANDS.map(([lo, hi]) => {
    const inB = [...main, ...subCalls].filter((c) => c.ctx >= lo && c.ctx < hi);
    const cost = inB.reduce((a, c) => a + c.$.total, 0);
    return { lo, hi, n: inB.length, cost, perCall: inB.length ? cost / inB.length : 0, outPerCall: inB.length ? Math.round(inB.reduce((a, c) => a + c.output, 0) / inB.length) : 0 };
  }).filter((b) => b.n);
  const tokIn = [...main, ...subCalls].reduce((a, c) => ({ r: a.r + c.cacheRead, w: a.w + c.cacheCreate, i: a.i + c.input }), { r: 0, w: 0, i: 0 });
  const hitRate = tokIn.r / Math.max(1, tokIn.r + tokIn.w + tokIn.i);

  // levers, each a $ saving with how it was computed
  // Simulated: compact whenever the context passes CAP, back to the thread's floor plus a
  // summary. Each simulated compaction pays a cold re-write of that base and the summary's
  // output; every later call reads the smaller context. A real compaction in the session
  // resets the simulation too.
  const CAP = 200_000, SUMMARY = 20_000;
  const floorCtx = main[0]?.ctx || 0;
  let capSaving = 0, simResets = 0, offset = 0;
  for (const c of main) {
    if (c.ctx - offset < floorCtx) offset = 0;
    if (c.ctx - offset > CAP) {
      const p = priceFor(c.model);
      offset = c.ctx - (floorCtx + SUMMARY); simResets++;
      capSaving -= ((floorCtx + SUMMARY) * p.in * (2 - 0.1) + SUMMARY * p.out) / 1e6;
    }
    capSaving += offset * crPrice(c.model);
  }
  const opusSubs = subs.filter((s) => s.models.some((m) => /opus|fable/.test(m)));
  const subSwitch = opusSubs.reduce((a, s) => a + s.cost * 0.6, 0);
  const top5 = injections.slice(0, 5).reduce((a, x) => a + x.cost, 0);
  const levers = [
    { basis: "simulated", lever: `/compact or hand off each time the context passes ${fmtN(CAP)}`, saving: capSaving, how: `simulated: ${simResets} compaction(s) back to the ${fmtN(floorCtx)} floor + a ${fmtN(SUMMARY)} summary, each paying a cold re-write and the summary; ignores re-reading files the summary dropped`, confidence: "medium" },
    { basis: "measured", lever: "Keep the cache warm: finish or /compact before a break longer than the TTL", saving: coldPremium, how: `${cold.length} cold re-write(s) after gaps longer than each thread's cache TTL (${ttlText}), premium over a warm read (exact)`, confidence: "high" },
    { basis: "estimated", lever: "Pull less into context: ranged reads, quiet flags, head/jq on the top 5 injections", saving: top5 / 2, how: "~half of the top 5 injections' carry cost (estimated from characters)", confidence: "low" },
    { basis: "price swap", lever: "Run the Opus subagents on Sonnet", saving: subSwitch, how: `${opusSubs.length} subagent(s) on ${[...new Set(opusSubs.flatMap((s) => s.models))].join(", ")}, price ratio 0.4 (exact $, quality risk not priced)`, confidence: "medium" },
    ...(subs.length ? [{ basis: "estimated", lever: "Give subagents a lean brief: keep the global CLAUDE.md stack and skill listing out of them", saving: subPrefixCost, how: `what those files cost inside the ${subs.length} subagent thread(s), re-read on every one of their calls (estimated)`, confidence: "medium" }] : []),
    { basis: "estimated", lever: "Shorten the CLAUDE.md stack and skill listing the main thread loads", saving: mainPrefixCost / 2, how: `half of the ~${$(mainPrefixCost)} they cost in the main thread, re-read on every call and re-attached after each compaction (estimated)`, confidence: "medium" },
    { basis: "price swap", lever: "Run the main thread on Sonnet", saving: main.filter((c) => /opus|fable/.test(c.model)).reduce((a, c) => a + c.$.total, 0) * 0.6, how: "price ratio 0.4 on the main thread's Opus calls (exact $); changes quality, not waste", confidence: "low" },
    ...(loopEntries ? [{ basis: "simulated", lever: "Give the goal loop a fresh context per item (or a budget stop) instead of one ever-growing thread", saving: loopCost > 0 ? capSaving * (loopCost / Math.max(mainCost, 1e-9)) : 0, how: `the compaction simulation's saving, pro-rated to the ${pct(loopCost, mainCost)} of main-thread spend the loop steered; overlaps the /compact lever`, confidence: "low" }] : []),
    { basis: "estimated", lever: "Stop re-reading files already in context", saving: reread.cost, how: `${reread.n} same-view re-reads with no edit or compaction in between, all threads (estimated)`, confidence: "medium" },
    { basis: "estimated", lever: "Targeted edits instead of whole-file writes and heredoc rewrites", saving: wholeWrites / 2, how: `half of the ~${$(wholeWrites)} that whole-file Write inputs and heredoc file writes cost while they sat in context (estimated); most: ${topRewrites || "none"}`, confidence: "low" },
  ].filter((l) => l.saving > 0.005).sort((a, b) => b.saving - a.saving);
  const best = levers[0];
  const bestWaste = levers.find((l) => l.basis !== "price swap") || best;

  // ── output ──
  const headline = [
    { label: "total, list price", value: $(total), note: subs.length ? `main ${$(mainCost)} + ${subs.length} subagent${subs.length === 1 ? "" : "s"} ${$(subCost)}` : "no subagents" },
    { label: "cost per hour", value: $(total / Math.max(1 / 60, (meta.durationSec || 1) / 3600)), note: `${(meta.durationSec / 3600).toFixed(1)} h wall time` },
    { label: "cache read", value: pct(byType.cacheRead, total), note: `${$(byType.cacheRead)} — re-billing the context every call` },
    { label: "median context", value: fmtN(median), note: `main thread; peak ${fmtN(peak)}, ${pct(over200.length, main.length)} of calls above 200k (${$(over200Cost)})` },
    { label: "cold-cache premium", value: $(coldPremium), note: `${cold.length} re-write(s) after idle beyond the TTL (${ttlText})` },
    ...(loopEntries ? [{ label: "steered by a loop", value: pct(loopCost, mainCost), note: `of main-thread spend (${$(loopCost)}) followed a goal/stop-hook re-entry, not a human prompt` }] : []),
    ...(bestWaste ? [{ label: "biggest lever (removes waste)", value: `~${$(bestWaste.saving)}`, note: `${bestWaste.lever} (${bestWaste.basis})` }] : []),
  ];

  const questions = [
    { q: "What did it cost?", a: `${$(total)} at list price${subs.length ? ` — ${$(mainCost)} main thread, ${$(subCost)} in ${subs.length} subagent${subs.length === 1 ? "" : "s"} (${pct(subCost, total)})` : ", all main thread"}.`,
      detail: `Exact: from ${count(all.length)} API calls' usage, each counted once per message id (summing the transcript's rows instead would count most calls 2-3 times; a subagent's output is read from its last streaming row). Token split: cache read ${$(byType.cacheRead)}, cache write ${$(byType.cacheWrite)}, output ${$(byType.output)}, fresh input ${$(byType.input)}.${!costState ? "" : costState.totalCostUSD >= total
        ? ` Claude Code's own running total for the session is ${$(costState.totalCostUSD)}; the ${$(costState.totalCostUSD - total)} gap is calls that write no usage row here (compaction summaries, ${Object.keys(costState.modelUsage || {}).filter((m) => /haiku/.test(m)).length ? "Haiku side calls, " : ""}title and utility calls), so this page's figure is the floor.`
        : ` Claude Code's own record says ${$(costState.totalCostUSD)}, less than the transcript: that record is per process, so for a resumed session it covers only the last leg.`}` },
    { q: "Did the context size drive it?", a: `Main thread: peak ${fmtN(peak)} tokens, median ${fmtN(median)}; ${pct(over200.length, main.length)} of its calls ran above 200k and cost ${$(over200Cost)} (${pct(over200Cost, mainCost)} of the main thread); ${compactions} compaction${compactions === 1 ? "" : "s"}.${subs.length ? ` Subagents: ${count(subCalls.length)} calls at a median context of ${fmtN(subMedian)}, ${pct(subOver.length, subCalls.length)} above 200k; each subagent re-reads its own context on every call, so ${subs.length} parallel threads multiply it.` : ""}`,
      detail: "Each call re-bills the whole context as cache read, so a session's cost is roughly the area under its context curve. A long session that never compacts pays for its early history on every later call." },
    { q: "Did idle time cost anything?", a: cold.length ? `${cold.length} cold re-write${cold.length === 1 ? "" : "s"} after gaps longer than the cache TTL (${ttlText}), ${$(coldPremium)} more than a warm cache would have cost.` : `No. Cache TTL: ${ttlText}; the longest gap between two calls of one thread was ${Math.round(longestGap)} min, and no gap past the TTL was followed by a re-write.` },
    { q: "Where was the money spent?", a: costliestPhase ? `The costliest phase ran ${clock(costliestPhase.from)}–${clock(Math.min(costliestPhase.to, tEnd))} UTC, started by ${costliestPhase.why}: ${$(costliestPhase.total)} (${pct(costliestPhase.total, total)} of the session)${costliestPhase.sub ? `, ${$(costliestPhase.sub)} of it in ${costliestPhase.launched} subagent(s) it launched` : ""}. ${loopEntries ? `${pct(loopCost, mainCost)} of the main thread's spend (${$(loopCost)}) ran while a goal/stop-hook loop${loopGoal ? ` «${loopGoal.trim().slice(0, 50)}»` : ""} was steering (${loopEntries} re-entries against ${humanPrompts} human prompts).` : ""}` : "no usage",
      detail: topWindows[0] ? `The single costliest 60 minutes, which can straddle two phases: ${winLabel(topWindows[0])}, ${$(topWindows[0].total)}${topWindows[0].sub ? ` (${$(topWindows[0].sub)} subagents)` : ""}, average main-thread context ${fmtN(topWindows[0].avgCtx)}${topWindows[0].compactAfter ? ", just before a compaction" : ""}. ${describeHour(topWindows[0])}.` : "" },
    { q: "Which single change would have saved most?", a: best ? `${best.lever}: ~${$(best.saving)} (${pct(best.saving, total)} of the total; ${best.basis}), confidence ${best.confidence}.${best.basis === "price swap" && levers.find((l) => l.basis !== "price swap") ? ` The largest saving that removes waste rather than changing the model: ${levers.find((l) => l.basis !== "price swap").lever}, ~${$(levers.find((l) => l.basis !== "price swap").saving)}.` : ""}` : "No lever stands out.",
      detail: best ? `How: ${best.how}. All levers are ranked in the table below; they overlap, so do not add them up.` : "" },
    { q: "What can this page not tell you?", a: `Thinking tokens are billed inside output but not stored, so output cost is exact while its split is not. Per-item costs are estimates: characters ÷ 4 (tool output and code scaled by ×${calib.toFixed(2)}, the median ratio of measured to estimated size over ${ratios.length} tool results; prose left unscaled), × the calls that re-read them. Calls that write no usage row (compaction summaries, side calls) are missing${costState ? `: Claude Code's own record says ${$(costState.totalCostUSD)} (per process, so a resumed session's record covers its last leg only)` : ""}. List prices; a subscription or gateway bills differently. No long-context (>200k) surcharge is applied.` },
  ];

  const sections = [
    { title: "Levers, ranked by what they would save", note: "Basis: measured = read off the transcript; simulated = the session replayed under the change; estimated = from characters; price swap = the same tokens at another model's price, which changes quality rather than removing waste. Savings overlap, so the rows do not add up.",
      table: { cols: ["change", "~saving", "share", "basis", "confidence", "how it is computed"], rows: levers.map((l) => [l.lever, $(l.saving), pct(l.saving, total), l.basis, l.confidence, l.how]) } },
    { title: "Phases: cut at each human prompt and each compaction", note: "What each stretch of direction cost, main thread and subagents, and which subagents it launched. The costliest is marked.",
      table: { cols: ["from", "to", "started by", "$", "main", "subagents", "launched"], rows: phases.filter((ph) => ph.total >= total * 0.01 || ph === costliestPhase).slice(0, 14).map((ph) => [
        `${clock(ph.from)} (${((ph.from - t0) / 3_600_000).toFixed(1)} h)`, clock(Math.min(ph.to, tEnd)), ph.why, `${$(ph.total)}${ph === costliestPhase ? " ★" : ""}`, $(ph.main), ph.sub ? $(ph.sub) : "", ph.launched ? `${ph.launched}: ${ph.launchedWhat}` : ""]) } },
    { title: "What one call cost as the context grew", note: `All threads. Cache hit rate ${(hitRate * 100).toFixed(2)}% of input tokens read from cache, so the price per call is the context size, not a cache problem. Output per call staying flat while $/call rises means the extra spend is re-reading, not work.`,
      table: { cols: ["context", "calls", "$/call", "output/call", "$", "share"], rows: bandRows.map((b) => [`${fmtN(b.lo)}–${b.hi === Infinity ? "" : fmtN(b.hi)}`, count(b.n), `$${b.perCall.toFixed(3)}`, count(b.outPerCall), $(b.cost), pct(b.cost, total)]) } },
    { title: "By token type and model", table: { cols: ["", "$", "share"], rows: [
      ["cache read", $(byType.cacheRead), pct(byType.cacheRead, total)],
      ["cache write", $(byType.cacheWrite), pct(byType.cacheWrite, total)],
      ["output", $(byType.output), pct(byType.output, total)],
      ["fresh input", $(byType.input), pct(byType.input, total)],
      ...[...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([m, e]) => [`model ${m} (${count(e.calls)} calls)`, $(e.cost), pct(e.cost, total)]),
    ] } },
    { title: "Costliest 60-minute stretches", note: "A window sliding over every API call, main thread and subagents; the three costliest that do not overlap. Commits and files are what the stretch produced.",
      table: { cols: ["when", "$", "main", "subagents", "avg ctx", "what was happening"], rows: topWindows.map((w) => [winLabel(w), $(w.total), $(w.main), w.sub ? $(w.sub) : "", `${fmtN(w.avgCtx)}${w.compactAfter ? " → compaction" : ""}`, describeHour(w)]) } },
    { title: "What filled the context (all threads)", note: `~ tokens put into context by each kind of content × the calls of that thread that re-read it before a compaction, at the cache-read price. Estimated; the fixed prefix is costed in the next table. The agent's own inputs (writes, edits, commands) total ~${$(ownCost)} of ~${$(fillTotal)}.`,
      table: { cols: ["kind", "~tokens", "~carry $", "main", "subagents", "share"], rows: fillRows.map((x) => [x.k, fmtN(x.tok), $(x.cost), $(x.main), subs.length ? $(x.sub) : "", pct(x.cost, fillTotal)]) } },
    { title: "The fixed prefix: loaded before any work, re-read on every call", note: `Exact floor: each thread's first call already carried its system prompt, tools and these files; that floor × every call of the thread = ${$(floorCost)} across ${threads.length} thread(s). Named parts below are estimated from characters; every subagent loads its own copy.`,
      table: { cols: ["file / part", "~tokens", "threads", "loads (re-attached after compaction)", "~$ over the session"], rows: prefixParts.slice(0, 10).map((x) => [x.name, fmtN(x.tok), String(x.threads), String(x.loads), $(x.cost)]) } },
    { title: "Biggest injections, all threads, by carry cost", note: "One ranking of what sat in context longest: single tool results (per thread) and the fixed prefix as one row per group. Sizes = are measured from the next call's cache write; ~ are chars ÷ 4.",
      table: { cols: ["source", "what", "thread", "tokens", "carry $"], rows: merged.slice(0, 10).map((x) => [x.source, x.what, x.thread, x.tok, $(x.cost)]) } },
    { title: "Biggest tool results, by carry cost (main thread)", note: "Tokens of one tool result × the main-thread calls that re-read it before a compaction, at the cache-read price. Sizes marked = are measured from the next call's cache write; ~ are chars ÷ 4, which undercounts code and JSON. The fixed prefix (CLAUDE.md, skill listing) is costed in its own table above.",
      table: { cols: ["tool", "what", "tokens", "later calls", "carry $"], rows: mainCarry.injections.slice(0, 8).map((x) => [x.c.tool, (x.c.filePath || x.c.command || x.c.description || "").replace(/\s+/g, " ").slice(0, 70), `${x.measured ? "=" : "~"}${fmtN(x.tok)}`, fmtN(x.later), $(x.cost)]) } },
    { title: "Avoidable repeats and verification output (all threads)", table: { cols: ["kind", "~tokens", "~carry $", "detail"], rows: [
      ["same-view re-read, nothing changed in between", fmtN(reread.tok), $(reread.cost), [...rereadFiles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f.split(/[\\/]/).pop()).join(", ")],
      ["identical tool output seen again", fmtN(repeat.tok), $(repeat.cost), ""],
      ["test / typecheck / lint / build / app-run / browser-check output", fmtN(verifyAll.tok), $(verifyAll.cost), `${verifyAll.runs} runs: ${verifyAll.mainRuns} in the main thread, ${verifyAll.runs - verifyAll.mainRuns} in subagents`],
    ] } },
  ];
  if (subs.length) sections.push({ title: `Subagents (${subs.length})`, note: "Cost is exact, from each subagent transcript's own usage. Files touched are the paths its Read/Write/Edit calls named (shell commands not parsed); a high shared count means the subagents worked over the same files, which is where duplicated effort would be.",
    table: { cols: ["task", "type", "model", "calls", "peak ctx", "$", "share", "files touched (also touched by another subagent)", "its final report"], rows: subs.map((s) => [s.description, s.agentType || s.kind, s.models.join(", "), count(s.calls.length), fmtN(s.peakCtx), $(s.cost), pct(s.cost, total), `${s.files.size} (${s.shared})`, s.reportHead ? `~${fmtN(s.reportTok)} tok: ${s.reportHead}` : "none"]) } });
  if (subs.length) sections.push({ title: "Subagents by launch wave and by role", note: "A wave is subagents started within 10 minutes of each other; the role is the first word of each task.",
    table: { cols: ["group", "subagents", "$", "share", "tasks"], rows: [
      ...waves.map((w, i) => [`wave ${i + 1}, ${clock(w.at)} UTC`, String(w.subs.length), $(w.subs.reduce((a, x) => a + x.cost, 0)), pct(w.subs.reduce((a, x) => a + x.cost, 0), total), w.subs.map((x) => x.description.slice(0, 40)).join("; ")]),
      ...[...roles.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([r, e]) => [`role "${r}"`, String(e.n), $(e.cost), pct(e.cost, total), ""]),
    ] } });
  if (cold.length) sections.push({ title: "Cold re-writes", table: { cols: ["at", "idle", "re-written", "premium"], rows: cold.map((c) => [c.ts?.slice(0, 16).replace("T", " "), `${Math.round(c.gapMin)} min`, fmtN(c.tokens), $(c.premium)]) } });

  return { headline, questions, sections };
}
