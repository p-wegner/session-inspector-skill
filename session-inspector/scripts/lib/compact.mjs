/**
 * compact.mjs — shrink the TOOL traffic of a Claude transcript, keep the conversation.
 *
 * The middle ground between a fork (the whole history, at full price) and a handoff (a
 * brief, with the history gone). Human prompts and assistant text are cheap and are kept
 * byte for byte; what a session spends its context on is tool calls — the file it read, the
 * command output it scrolled through, the content it wrote. Measured on this box's own
 * sessions: tool_result + tool_use is 75–90 % of the message content, assistant text under
 * 3 %.
 *
 * Two modes, both leaving every line, uuid and parentUuid in place so `claude --resume`
 * walks the copy exactly as it walked the original:
 *
 *   pairs    (default) each tool_use keeps its id, name and the SHAPE of its input, with
 *            long strings cut to a head; each tool_result keeps its id and is_error and
 *            carries a head + tail of the output with an "[omitted]" marker in between.
 *            Shape-preserving, so nothing that renders a past turn can trip on it.
 *   narrate  the tool_use input is reduced to one line ("what was done") and the result to
 *            one line ("what came back"), so a call reads like a diary entry. Cheaper, and
 *            the API still sees a valid tool_use/tool_result pair.
 *
 * Tool calls after the last N human prompts (`recent`, default 1) are left untouched: the
 * file the session was just reading is the one the continuation needs verbatim.
 *
 * The sidecar fields Claude Code writes beside the blocks (`toolUseResult`, which repeats the
 * result in structured form; `wireToolInputs`, which repeats the input) are shrunk the same
 * way, type-preserving, so the transcript on disk shrinks with the context.
 *
 * Node builtins only. Pure: lines in, lines out, plus a stats object.
 */

const MARK = "session-compact";

const DEFAULTS = {
  mode: "pairs",       // pairs | narrate | llm (narrate, but a model writes the lines: `narrations`)
  narrations: null,    // Map tool_use id → { did, got } from lib/narrator.mjs; a call without one falls back to narrate
  recent: 1,           // human prompts whose tool calls stay verbatim (counted from the end)
  head: 240,           // chars of a result kept from the top (pairs)
  tail: 160,           // chars of a result kept from the bottom (pairs)
  input: 200,          // chars kept of any string inside a tool_use input (pairs)
  errorFactor: 2,      // an is_error result keeps this many times more
  sessionId: null,     // rewrite the sessionId on every line (a fork copy)
};

export const estTokens = (chars) => Math.round((chars || 0) / 4);

// ── text helpers ────────────────────────────────────────────────────────────

function firstLine(s, max = 120) {
  const l = String(s ?? "").split("\n").find((x) => x.trim()) || "";
  return l.length > max ? l.slice(0, max) + "…" : l;
}
const lineCount = (s) => (s ? String(s).split("\n").length : 0);

/** Cut a long string to a head, naming what was dropped. Short strings pass through. */
export function cutString(s, max) {
  if (typeof s !== "string" || s.length <= max + 40) return s;
  const dropped = s.length - max;
  return `${s.slice(0, max)}… [${MARK}: ${dropped} chars, ${lineCount(s.slice(max))} lines cut]`;
}

/** Recursively cut every string in a JSON value. Type- and shape-preserving. */
export function shrinkStrings(v, max) {
  if (typeof v === "string") return cutString(v, max);
  if (Array.isArray(v)) return v.map((x) => shrinkStrings(x, max));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = shrinkStrings(x, max);
    return out;
  }
  return v;
}

/** Head + tail of a result with a marker between; the whole thing when it is short. */
export function headTail(text, head, tail) {
  const s = String(text ?? "");
  if (s.length <= head + tail + 80) return s;
  const mid = s.slice(head, s.length - tail);
  const marker = `\n… [${MARK}: ${mid.length} chars, ${lineCount(mid)} lines omitted] …\n`;
  return s.slice(0, head) + marker + s.slice(s.length - tail);
}

function textOfResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n");
  return "";
}

// ── what a call DID, in one line (narrate mode, and the pairs marker) ───────

const short = (p) => String(p ?? "").replace(/\\/g, "/").split("/").slice(-3).join("/");

export function describeCall(name, input) {
  const i = input && typeof input === "object" ? input : {};
  switch (name) {
    case "Read":  return `Read ${short(i.file_path)}${i.offset ? ` from line ${i.offset}` : ""}${i.limit ? ` (${i.limit} lines)` : ""}`;
    case "Write": return `Write ${short(i.file_path)} (${lineCount(i.content)} lines, ${String(i.content ?? "").length} chars)`;
    case "Edit":  return `Edit ${short(i.file_path)}: "${firstLine(i.old_string, 60)}" → "${firstLine(i.new_string, 60)}"${i.replace_all ? " (all)" : ""}`;
    case "MultiEdit": return `MultiEdit ${short(i.file_path)} (${Array.isArray(i.edits) ? i.edits.length : "?"} edits)`;
    case "Glob":  return `Glob ${i.pattern}${i.path ? ` in ${short(i.path)}` : ""}`;
    case "Grep":  return `Grep /${i.pattern}/${i.path ? ` in ${short(i.path)}` : ""}${i.glob ? ` (${i.glob})` : ""}`;
    case "Bash":
    case "PowerShell": return `${name}: ${firstLine(i.command, 160)}${lineCount(i.command) > 1 ? ` (+${lineCount(i.command) - 1} lines)` : ""}${i.description ? ` — ${i.description}` : ""}`;
    case "Agent":
    case "Task":  return `${name}${i.subagent_type ? ` ${i.subagent_type}` : ""}: ${i.description || firstLine(i.prompt, 100)}`;
    case "Skill": return `Skill ${i.skill}${i.args ? ` ${firstLine(i.args, 80)}` : ""}`;
    case "WebFetch": return `WebFetch ${i.url}`;
    case "WebSearch": return `WebSearch "${i.query}"`;
    case "TodoWrite": return `TodoWrite (${Array.isArray(i.todos) ? i.todos.length : "?"} items)`;
    case "AskUserQuestion": return `AskUserQuestion: ${Array.isArray(i.questions) ? i.questions.map((q) => firstLine(q?.question, 80)).join(" | ") : ""}`;
    default: {
      const j = JSON.stringify(i);
      return `${name} ${j.length > 160 ? j.slice(0, 160) + "…" : j}`;
    }
  }
}

/** What came back, in one line. */
export function describeResult(name, text, isError) {
  const s = String(text ?? "");
  const lines = lineCount(s);
  if (isError) return `ERROR: ${firstLine(s, 200)}${lines > 1 ? ` (+${lines - 1} lines)` : ""}`;
  if (!s.trim()) return "(no output)";
  switch (name) {
    case "Read":  return `${lines} lines`;
    case "Edit":
    case "MultiEdit":
    case "Write": return firstLine(s, 120);
    default: {
      const tail = s.trimEnd().split("\n").slice(-1)[0] || "";
      return lines <= 2 ? firstLine(s, 200) : `${lines} lines; first: ${firstLine(s, 90)}; last: ${tail.trim().slice(0, 90)}`;
    }
  }
}

// ── the block rewrites ──────────────────────────────────────────────────────

export function compactInput(name, input, o, id) {
  if (o.mode === "llm") {
    const n = o.narrations?.get?.(id);
    return { [MARK]: n?.did || describeCall(name, input) };
  }
  if (o.mode === "narrate") return { [MARK]: describeCall(name, input) };
  const i = input && typeof input === "object" ? input : {};
  if (name === "Write" && typeof i.content === "string" && i.content.length > o.input + 40) {
    return { ...i, content: `[${MARK}: ${lineCount(i.content)} lines, ${i.content.length} chars] ${firstLine(i.content, 100)}` };
  }
  return shrinkStrings(i, o.input);
}

export function compactResultText(name, text, isError, o, id) {
  if (o.mode === "llm") {
    const n = o.narrations?.get?.(id);
    return `[${MARK}] ${n?.got || describeResult(name, text, isError)}`;
  }
  if (o.mode === "narrate") return `[${MARK}] ${describeResult(name, text, isError)}`;
  const f = isError ? o.errorFactor : 1;
  return headTail(text, o.head * f, o.tail * f);
}

function setResultText(block, text) {
  if (typeof block.content === "string" || block.content == null) { block.content = text; return; }
  if (Array.isArray(block.content)) {
    // Keep only the first text block, rewritten; images and further text are dropped with it.
    const first = block.content.find((b) => b?.type === "text");
    block.content = [first ? { ...first, text } : { type: "text", text }];
    return;
  }
  block.content = text;
}

// ── the pass ────────────────────────────────────────────────────────────────

const isPrompt = (obj) =>
  obj?.type === "user" && typeof obj.message?.content === "string" && obj.isMeta !== true &&
  obj.isCompactSummary !== true && !/^\s*<(command-|local-command|system-reminder)/.test(obj.message.content);

// recent 0: everything is old. Fewer prompts than `recent`: everything is recent, nothing changes.
const cutoffOf = (recent, promptIdx) =>
  recent <= 0 ? Infinity : promptIdx.length >= recent ? promptIdx[promptIdx.length - recent] : 0;

/**
 * @param {string[]} lines  raw transcript lines
 * @param {object} opts     see DEFAULTS
 * @returns {{ lines: string[], stats: object }}
 */
export function compactTranscript(lines, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const parsed = lines.map((raw) => {
    const t = raw.trim();
    if (!t) return { raw, obj: null };
    try { return { raw, obj: JSON.parse(t) }; } catch { return { raw, obj: null }; }
  });

  // The cut-off: tool calls after the `recent`-th human prompt from the end stay verbatim.
  const promptIdx = [];
  parsed.forEach(({ obj }, i) => { if (isPrompt(obj)) promptIdx.push(i); });
  const cutoff = cutoffOf(o.recent, promptIdx);

  const stats = {
    mode: o.mode, recent: o.recent, prompts: promptIdx.length,
    calls: 0, compacted: 0, kept: 0,
    before: { toolUse: 0, toolResult: 0, text: 0, thinking: 0, user: 0 },
    after:  { toolUse: 0, toolResult: 0, text: 0, thinking: 0, user: 0 },
    bytesBefore: 0, bytesAfter: 0,
  };
  const size = (v) => JSON.stringify(v ?? "").length;
  const toolOf = new Map();   // tool_use id → name
  const out = [];

  for (let i = 0; i < parsed.length; i++) {
    const { raw, obj } = parsed[i];
    stats.bytesBefore += raw.length;
    if (!obj) { out.push(raw); stats.bytesAfter += raw.length; continue; }
    let changed = false;
    if (o.sessionId && typeof obj.sessionId === "string") { obj.sessionId = o.sessionId; changed = true; }
    if (o.sessionId && typeof obj.session_id === "string") { obj.session_id = o.sessionId; changed = true; }

    const content = obj.message?.content;
    const inRecent = i >= cutoff;
    if (obj.type === "user" && typeof content === "string") {
      stats.before.user += content.length; stats.after.user += content.length;
    } else if (Array.isArray(content) && (obj.type === "user" || obj.type === "assistant")) {
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text") { stats.before.text += size(b.text); stats.after.text += size(b.text); }
        else if (b.type === "thinking") { stats.before.thinking += size(b.thinking); stats.after.thinking += size(b.thinking); }
        else if (b.type === "tool_use") {
          toolOf.set(b.id, b.name);
          stats.calls++;
          const before = size(b.input);
          stats.before.toolUse += before;
          if (inRecent || obj.isSidechain === true) { stats.kept++; stats.after.toolUse += before; continue; }
          b.input = compactInput(b.name, b.input, o, b.id);
          stats.after.toolUse += size(b.input);
          stats.compacted++;
          changed = true;
          if (obj.wireToolInputs && typeof obj.wireToolInputs === "object") obj.wireToolInputs = shrinkStrings(obj.wireToolInputs, o.input);
        } else if (b.type === "tool_result") {
          const text = textOfResult(b.content);
          stats.before.toolResult += size(b.content);
          if (inRecent || obj.isSidechain === true) { stats.after.toolResult += size(b.content); continue; }
          const name = toolOf.get(b.tool_use_id) || "tool";
          setResultText(b, compactResultText(name, text, b.is_error === true, o, b.tool_use_id));
          stats.after.toolResult += size(b.content);
          changed = true;
          if (obj.toolUseResult !== undefined) {
            const lim = o.mode === "pairs" ? o.head : 120;
            obj.toolUseResult = shrinkStrings(obj.toolUseResult, lim);
          }
        }
      }
    }
    const line = changed ? JSON.stringify(obj) : raw;
    out.push(line);
    stats.bytesAfter += line.length;
  }

  const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);
  stats.contextBefore = sum(stats.before);
  stats.contextAfter = sum(stats.after);
  stats.tokensBefore = estTokens(stats.contextBefore);
  stats.tokensAfter = estTokens(stats.contextAfter);
  stats.saved = stats.contextBefore ? 1 - stats.contextAfter / stats.contextBefore : 0;
  return { lines: out, stats };
}

/**
 * The calls a compactTranscript pass with the same opts would rewrite, joined with their
 * results: [{ id, name, input, resultText, isError }]. This is what the narrator is given.
 */
export function collectCalls(lines, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const parsed = lines.map((raw) => { try { return JSON.parse(raw); } catch { return null; } });
  const promptIdx = [];
  parsed.forEach((obj, i) => { if (isPrompt(obj)) promptIdx.push(i); });
  const cutoff = cutoffOf(o.recent, promptIdx);
  const byId = new Map();
  parsed.forEach((obj, i) => {
    if (!obj || i >= cutoff || obj.isSidechain === true) return;
    const content = obj.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "tool_use") byId.set(b.id, { id: b.id, name: b.name, input: b.input, resultText: "", isError: false });
      else if (b?.type === "tool_result" && byId.has(b.tool_use_id)) {
        const c = byId.get(b.tool_use_id);
        c.resultText = textOfResult(b.content); c.isError = b.is_error === true;
      }
    }
  });
  return [...byId.values()];
}

export function renderStats(s, { path = "", sessionId = "" } = {}) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const kb = (n) => `${Math.round(n / 1024)} kB`;
  const row = (k) => `  ${k.padEnd(12)} ${String(s.before[k]).padStart(9)} → ${String(s.after[k]).padStart(9)} chars`;
  return [
    `${MARK}: ${s.mode} mode, ${s.compacted} of ${s.calls} tool calls compacted (${s.kept} kept verbatim: after the last ${s.recent} prompt${s.recent === 1 ? "" : "s"} of ${s.prompts})`,
    row("toolUse"), row("toolResult"), row("text"), row("thinking"), row("user"),
    `  context      ~${s.tokensBefore} → ~${s.tokensAfter} tokens (${pct(s.saved)} smaller, chars/4 estimate; thinking is not billed on resume)`,
    `  file         ${kb(s.bytesBefore)} → ${kb(s.bytesAfter)}`,
    ...(s.llm ? [`  narrator     ${s.llm.model}: ${s.llm.narrated} of ${s.llm.calls} calls narrated in ${s.llm.batches} batch${s.llm.batches === 1 ? "" : "es"}, ${s.llm.fallback} fell back to the string cut, $${s.llm.costUsd.toFixed(4)} (${s.llm.inputTokens} in / ${s.llm.outputTokens} out)${s.llm.failedBatches ? `, ${s.llm.failedBatches} batch(es) FAILED: ${s.llm.errors.join(" | ").slice(0, 200)}` : ""}`] : []),
    ...(s.summary ? [`  summary      Claude Code /compact on ${s.summary.model}: ${s.summary.preTokens ? `${s.summary.preTokens} tokens before, ` : ""}$${s.summary.costUsd.toFixed(4)}${s.summary.ok ? "" : ` FAILED: ${s.summary.error}`}`] : []),
    ...(sessionId ? [`  session      ${sessionId}`] : []),
    ...(path ? [`  written      ${path}`] : []),
  ].join("\n");
}
