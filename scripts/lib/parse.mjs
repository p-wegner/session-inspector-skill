/**
 * Shared full-transcript parsers for Claude / Codex / Copilot sessions.
 *
 * This is the single source of truth for "what happened in this session":
 * tool usage (with failures), repeated commands, errors, files touched,
 * tokens / cost, stop reason, and the user + assistant messages. Both the
 * analyze-*-session.mjs CLIs and the sync-server web UI parse through here, so
 * a session reads the same on disk and over the network.
 *
 * Node builtins only. Each parse<Provider> returns the provider-native stats
 * shape the analyzers print; summarize() folds any provider into one normalized
 * SessionSummary for the server / UI.
 */

import { classify } from "./prompts.mjs";

// ── helpers ──────────────────────────────────────────────────────────────────

export function fmtDuration(sec) {
  if (!sec || sec < 0) return "?";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n || 0);
}
function pushUnique(arr, v) { if (v && !arr.includes(v)) arr.push(v); }

// A `Skill` / `Agent` (a.k.a. `Task`) tool_use is generic until you read its
// input: the ACTUAL skill (`input.skill`) or subagent type (`input.subagent_type`)
// is what a human wants to see on the board, in tool counts, and on the timeline —
// otherwise every skill invocation collapses into one anonymous "Skill" chip.
// Expand those into `Skill:<name>` / `Agent:<type>`; pass every other tool through.
export function toolDisplayName(name, input) {
  const n = name || "unknown";
  if (!input || typeof input !== "object") return n;
  if (n === "Skill" && typeof input.skill === "string" && input.skill.trim())
    return `Skill:${input.skill.trim()}`;
  if ((n === "Agent" || n === "Task") && typeof input.subagent_type === "string" && input.subagent_type.trim())
    return `${n}:${input.subagent_type.trim()}`;
  return n;
}
function repeatedFrom(commands) {
  const counts = new Map();
  for (const c of commands) {
    const key = String(c).slice(0, 100);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([command, count]) => ({ command, count }));
}

// ── Claude ───────────────────────────────────────────────────────────────────

const CLAUDE_READ_TOOLS = new Set(["Read", "NotebookRead"]);
const CLAUDE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const CLAUDE_WRITE_TOOLS = new Set(["Write"]);

// Usage/rate-limit banner detection. The USAGE regex matches the exact banner
// Claude Code emits as its FINAL assistant message when a session is cut off
// ("You've hit your session limit · resets 1:50am"). RATE matches transient
// 429/overload text. Kept module-level so the discovery tools reuse the identical
// test the analyzer uses — a session reads the same everywhere.
const LIMIT_USAGE_RE = /you've hit your (session|usage) limit|usage limit reached|session limit ·|resets \d{1,2}(:\d\d)?\s*(am|pm)/i;
const LIMIT_RATE_RE = /rate limit|\b429\b|overloaded/i;
export function limitKind(text) {
  if (!text) return "";
  if (LIMIT_USAGE_RE.test(text)) return "usage-limit";
  if (LIMIT_RATE_RE.test(text)) return "rate-limit";
  return "";
}

export function parseClaude(lines) {
  const toolNameById = new Map();
  const toolCounts = new Map(); // name -> { count, failed }
  const commands = [];
  const stats = {
    provider: "claude",
    model: "", sessionId: "", cwd: "", startTime: "", endTime: "", durationSec: 0,
    assistantTurns: 0, toolCalls: 0, failedToolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0,
    stopReason: "",
    userMessages: [], assistantTexts: [],
    filesRead: [], filesEdited: [], filesWritten: [],
    errors: [],
    // ── "at a glance" signals ───────────────────────────────────────────────
    aiTitle: "",        // agent-generated session title (the goal in a phrase)
    firstPrompt: "",    // first human prompt (raw intent)
    lastPrompt: "",     // most recent human prompt
    compactions: 0,     // auto-compact boundaries (isCompactSummary)
    maxContextTokens: 0,// largest single-turn context (input+cacheRead) seen
    hitLimit: "",       // "" | "usage-limit" | "rate-limit" — a limit was MENTIONED anywhere (weak: fooled by sessions that merely discuss limits)
    endedOnLimit: "",   // "" | "usage-limit" | "rate-limit" — the limit banner was the FINAL assistant message (strong: the session was actually cut off here → resumable)
    endedInterrupted: false, // last human action was an interrupt
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj; try { obj = JSON.parse(trimmed); } catch { continue; }

    if (obj.timestamp) { if (!stats.startTime) stats.startTime = obj.timestamp; stats.endTime = obj.timestamp; }
    if (obj.sessionId && !stats.sessionId) stats.sessionId = obj.sessionId;
    if (obj.cwd && !stats.cwd) stats.cwd = obj.cwd;
    // Goal signal: the agent-generated session title (latest wins).
    if (obj.type === "ai-title" && obj.aiTitle) stats.aiTitle = obj.aiTitle;
    // Auto-compact boundary — the context safety valve fired here.
    if (obj.isCompactSummary) stats.compactions++;
    if (obj.type === "result") {
      if (typeof obj.total_cost_usd === "number") stats.totalCostUsd = obj.total_cost_usd;
      continue;
    }
    const msg = obj.message;
    if (!msg) continue;

    if (obj.type === "assistant") {
      stats.assistantTurns++;
      if (msg.model) stats.model = msg.model;
      if (msg.stop_reason) stats.stopReason = msg.stop_reason;
      const u = msg.usage;
      if (u) {
        stats.inputTokens += u.input_tokens || 0;
        stats.outputTokens += u.output_tokens || 0;
        stats.cacheReadTokens += u.cache_read_input_tokens || 0;
        // Track the largest single-turn context (input + cache-read) as a proxy
        // for how close the session ran to its window.
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
        if (ctx > stats.maxContextTokens) stats.maxContextTokens = ctx;
      }
      for (const block of msg.content || []) {
        if (block.type === "text" && block.text) {
          stats.assistantTexts.push(block.text);
          // Weak mention signal (any occurrence). endedOnLimit (computed after the
          // loop from the FINAL assistant text) is the trustworthy one.
          const k = limitKind(block.text);
          if (k === "usage-limit") stats.hitLimit = "usage-limit";
          else if (k === "rate-limit" && !stats.hitLimit) stats.hitLimit = "rate-limit";
        } else if (block.type === "tool_use") {
          stats.toolCalls++;
          const rawName = block.name || "unknown";
          const name = toolDisplayName(rawName, block.input); // Skill:<name> / Agent:<type>
          toolNameById.set(block.id, name);
          const e = toolCounts.get(name) || { count: 0, failed: 0 };
          e.count++; toolCounts.set(name, e);
          const fp = block.input?.file_path || block.input?.notebook_path;
          if (fp) {
            if (CLAUDE_READ_TOOLS.has(rawName)) pushUnique(stats.filesRead, fp);
            else if (CLAUDE_EDIT_TOOLS.has(rawName)) pushUnique(stats.filesEdited, fp);
            else if (CLAUDE_WRITE_TOOLS.has(rawName)) pushUnique(stats.filesWritten, fp);
          }
          const cmd = block.input?.command || block.input?.cmd || block.input?.script;
          if (typeof cmd === "string") commands.push(cmd);
        }
      }
    } else if (obj.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (/\[Request interrupted by user/.test(content)) stats.endedInterrupted = true;
        else if (!content.startsWith("<")) { stats.userMessages.push(content); stats.endedInterrupted = false; }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.is_error) {
            stats.failedToolCalls++;
            const name = toolNameById.get(block.tool_use_id);
            if (name) { const e = toolCounts.get(name) || { count: 0, failed: 0 }; e.failed++; toolCounts.set(name, e); }
            const text = Array.isArray(block.content) ? block.content.map((c) => c.text || "").join(" ") : String(block.content || "");
            if (text) stats.errors.push(text.slice(0, 200));
          } else if (block.type === "text" && block.text && !block.text.startsWith("<")) {
            stats.userMessages.push(block.text);
          }
        }
      }
    }
  }

  if (stats.startTime && stats.endTime) stats.durationSec = Math.round((new Date(stats.endTime) - new Date(stats.startTime)) / 1000);
  // Strong "cut off here" signal: the limit banner is the FINAL assistant message.
  // A genuine limit-hit session ends ON the banner; a session that merely quotes or
  // discusses limits keeps working afterwards, so its last text is something else.
  const lastText = stats.assistantTexts.length ? stats.assistantTexts[stats.assistantTexts.length - 1] : "";
  stats.endedOnLimit = limitKind(lastText);
  stats.toolNames = Object.fromEntries([...toolCounts.entries()]);
  stats.commands = commands;
  stats.repeatedCommands = repeatedFrom(commands);
  // Human-intent bookends: run userMessages through classify() so injected
  // skill preambles ("Base directory for this skill:"), handoffs, and slash-UI
  // noise don't masquerade as the human's first/last ask.
  const human = [];
  for (const m of stats.userMessages) {
    const c = classify(m);
    if (c && c.kind === "human") human.push(c.text);
  }
  if (human.length) {
    stats.firstPrompt = human[0];
    stats.lastPrompt = human[human.length - 1];
  } else if (stats.userMessages.length) {
    // Fallback: no clean human prompt (e.g. a pure subagent) — show the first raw one.
    stats.firstPrompt = stats.userMessages[0];
  }
  return stats;
}

// ── Codex ────────────────────────────────────────────────────────────────────

export function parseCodex(lines) {
  const stats = {
    provider: "codex",
    model: "", sessionId: "", cwd: "", cliVersion: "", startTime: "", endTime: "", durationSec: 0,
    turns: 0, toolCalls: 0, toolNames: {}, commands: [],
    userMessages: [], agentMessages: [], patchesApplied: [], webSearches: [],
    inputTokens: 0, outputTokens: 0,
  };
  const events = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj; try { obj = JSON.parse(trimmed); } catch { continue; }
    const type = obj.type, payload = obj.payload || {}, ts = obj.timestamp;
    if (ts) { if (!stats.startTime) stats.startTime = ts; stats.endTime = ts; }

    if (type === "session_meta") {
      stats.sessionId = payload.id || ""; stats.cwd = payload.cwd || ""; stats.cliVersion = payload.cli_version || "";
    } else if (type === "turn_context") {
      if (payload.model) stats.model = payload.model;
    } else if (type === "event_msg") {
      const mt = payload.type;
      if (mt === "user_message") stats.userMessages.push(payload.message || "");
      else if (mt === "agent_message") stats.agentMessages.push(payload.message || "");
      else if (mt === "task_started") stats.turns++;
      else if (mt === "task_complete") events.push({ type: "task_complete", message: payload.last_agent_message || "" });
      else if (mt === "token_count" && payload.info?.total_token_usage) {
        const t = payload.info.total_token_usage;
        stats.inputTokens = t.input_tokens || 0; stats.outputTokens = t.output_tokens || 0;
      } else if (mt === "patch_apply_end") {
        const changedFiles = Object.keys(payload.changes || {});
        stats.patchesApplied.push({ files: changedFiles, success: payload.success !== false, stdout: payload.stdout || "" });
      } else if (mt === "web_search_end") stats.webSearches.push(payload.query || "");
    } else if (type === "response_item") {
      const ri = payload.type;
      if (ri === "function_call") {
        const name = payload.name || "";
        stats.toolCalls++; stats.toolNames[name] = (stats.toolNames[name] || 0) + 1;
        let parsed = {}; try { parsed = JSON.parse(payload.arguments || "{}"); } catch {}
        if (name === "shell_command" && parsed.command) stats.commands.push(parsed.command);
      } else if (ri === "custom_tool_call") {
        const name = payload.name || "custom_tool";
        stats.toolCalls++; stats.toolNames[name] = (stats.toolNames[name] || 0) + 1;
      }
    }
  }

  if (stats.startTime && stats.endTime) stats.durationSec = Math.round((new Date(stats.endTime) - new Date(stats.startTime)) / 1000);
  stats.repeatedCommands = repeatedFrom(stats.commands);
  return { events, stats };
}

// ── Copilot ──────────────────────────────────────────────────────────────────

export function parseCopilot(lines) {
  const stats = {
    provider: "copilot",
    sessionId: "", model: "", copilotVersion: "", cwd: "", branch: "", startTime: "", endTime: "", durationSec: 0,
    turns: 0, toolCalls: 0, toolNames: {}, commands: [],
    userMessages: [], assistantMessages: [], hooks: 0, shutdownType: "",
    totalApiDurationMs: 0, linesAdded: 0, linesRemoved: 0, filesModified: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj; try { obj = JSON.parse(trimmed); } catch { continue; }
    const type = obj.type, data = obj.data || {}, ts = obj.timestamp;
    if (ts && (!stats.endTime || ts > stats.endTime)) stats.endTime = ts;

    if (type === "session.start") {
      stats.sessionId = data.sessionId || ""; stats.copilotVersion = data.copilotVersion || "";
      stats.cwd = data.context?.cwd || ""; stats.branch = data.context?.branch || "";
      stats.startTime = data.startTime || ts || "";
    } else if (type === "session.model_change") {
      stats.model = data.newModel || stats.model;
    } else if (type === "user.message") {
      stats.userMessages.push(data.content || "");
    } else if (type === "assistant.turn_start") {
      stats.turns++;
    } else if (type === "assistant.message") {
      if (data.content) stats.assistantMessages.push(data.content);
      else if (data.reasoningText) {
        const firstLine = String(data.reasoningText).split("\n")[0];
        if (firstLine) stats.assistantMessages.push(firstLine.slice(0, 300));
      }
      if (data.model && !stats.model) stats.model = data.model;
      if (data.toolRequests) {
        for (const tr of data.toolRequests) {
          stats.toolCalls++;
          stats.toolNames[tr.name] = (stats.toolNames[tr.name] || 0) + 1;
          if ((tr.name === "shell" || tr.name === "bash" || tr.name === "powershell") && tr.arguments?.command) {
            stats.commands.push(tr.arguments.command);
          }
        }
      }
    } else if (type === "tool.execution_start") {
      // tool name tracked via assistant.message toolRequests
    } else if (type === "hook.start") {
      stats.hooks++;
    } else if (type === "session.shutdown") {
      stats.shutdownType = data.shutdownType || "";
      stats.totalApiDurationMs = data.totalApiDurationMs || 0;
      stats.linesAdded = data.codeChanges?.linesAdded || 0;
      stats.linesRemoved = data.codeChanges?.linesRemoved || 0;
      stats.filesModified = data.codeChanges?.filesModified || [];
    }
  }

  if (stats.startTime) {
    const start = new Date(stats.startTime).getTime();
    const end = stats.endTime ? new Date(stats.endTime).getTime() : start;
    stats.durationSec = Math.round((end - start) / 1000);
  }
  stats.repeatedCommands = repeatedFrom(stats.commands);
  return stats;
}

// ── Event timeline (chronological, typed — for "show me just the X" browsing) ─
//
// One normalized stream across providers so a session reads the same on the CLI
// (`--events --type tool_error`) and in the web UI timeline. Each event:
//   { seq, ts, type, tool, text }
// type ∈ user | assistant | thinking | tool_call | tool_error
//   tool : tool name (tool_call / tool_error only)
//   text : full message / command summary / error text (renderer truncates)

export const EVENT_TYPES = ["user", "assistant", "thinking", "tool_call", "tool_error"];

// Map a tool's input object to a compact one-line argument summary.
const TOOL_ARG_KEYS = ["command", "cmd", "script", "pattern", "query", "url", "file_path", "notebook_path", "path", "description", "prompt", "args"];
function toolArgSummary(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of TOOL_ARG_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  try { const j = JSON.stringify(input); return j === "{}" ? "" : j; } catch { return ""; }
}

export function claudeEvents(lines) {
  const toolNameById = new Map();
  const ev = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj; try { obj = JSON.parse(trimmed); } catch { continue; }
    const ts = obj.timestamp || "";
    const msg = obj.message;
    if (!msg) continue;

    if (obj.type === "assistant") {
      for (const block of msg.content || []) {
        if (block.type === "text" && block.text) ev.push({ ts, type: "assistant", tool: "", text: block.text });
        else if (block.type === "thinking" && block.thinking) ev.push({ ts, type: "thinking", tool: "", text: block.thinking });
        else if (block.type === "tool_use") {
          const name = toolDisplayName(block.name, block.input); // Skill:<name> / Agent:<type>
          toolNameById.set(block.id, name);
          ev.push({ ts, type: "tool_call", tool: name, text: toolArgSummary(block.input) });
        }
      }
    } else if (obj.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (!content.startsWith("<")) ev.push({ ts, type: "user", tool: "", text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.is_error) {
            const text = Array.isArray(block.content) ? block.content.map((c) => c.text || "").join(" ") : String(block.content || "");
            ev.push({ ts, type: "tool_error", tool: toolNameById.get(block.tool_use_id) || "", text });
          } else if (block.type === "text" && block.text && !block.text.startsWith("<")) {
            ev.push({ ts, type: "user", tool: "", text: block.text });
          }
        }
      }
    }
  }
  return ev.map((e, i) => ({ seq: i + 1, ...e }));
}

export function codexEvents(lines) {
  const callNameById = new Map();
  const ev = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj; try { obj = JSON.parse(trimmed); } catch { continue; }
    const ts = obj.timestamp || "", payload = obj.payload || {};

    if (obj.type === "event_msg") {
      const mt = payload.type;
      if (mt === "user_message") ev.push({ ts, type: "user", tool: "", text: payload.message || "" });
      else if (mt === "agent_message") ev.push({ ts, type: "assistant", tool: "", text: payload.message || "" });
      else if (mt === "web_search_end") ev.push({ ts, type: "tool_call", tool: "web_search", text: payload.query || "" });
      else if (mt === "patch_apply_end") {
        const files = Object.keys(payload.changes || {});
        if (payload.success === false) ev.push({ ts, type: "tool_error", tool: "apply_patch", text: `${files.join(", ")} — ${payload.stdout || "patch failed"}` });
        else ev.push({ ts, type: "tool_call", tool: "apply_patch", text: files.join(", ") });
      }
    } else if (obj.type === "response_item") {
      const ri = payload.type;
      if (ri === "function_call" || ri === "custom_tool_call") {
        const name = payload.name || "tool";
        if (payload.call_id) callNameById.set(payload.call_id, name);
        let parsed = {}; try { parsed = JSON.parse(payload.arguments || "{}"); } catch {}
        ev.push({ ts, type: "tool_call", tool: name, text: name === "shell_command" ? (parsed.command || "") : toolArgSummary(parsed) });
      } else if (ri === "function_call_output" || ri === "custom_tool_call_output") {
        let out = payload.output;
        let exit, text = "";
        if (typeof out === "string") { try { out = JSON.parse(out); } catch {} }
        if (out && typeof out === "object") { exit = out.metadata?.exit_code; text = String(out.output || ""); }
        else text = String(out || "");
        if (typeof exit === "number" && exit !== 0) ev.push({ ts, type: "tool_error", tool: callNameById.get(payload.call_id) || "", text: text || `exit ${exit}` });
      }
    }
  }
  return ev.map((e, i) => ({ seq: i + 1, ...e }));
}

export function copilotEvents(lines) {
  const ev = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj; try { obj = JSON.parse(trimmed); } catch { continue; }
    const ts = obj.timestamp || "", type = obj.type, data = obj.data || {};

    if (type === "user.message") ev.push({ ts, type: "user", tool: "", text: data.content || "" });
    else if (type === "assistant.message") {
      if (data.content) ev.push({ ts, type: "assistant", tool: "", text: data.content });
      else if (data.reasoningText) ev.push({ ts, type: "thinking", tool: "", text: String(data.reasoningText) });
      for (const tr of data.toolRequests || []) ev.push({ ts, type: "tool_call", tool: tr.name || "tool", text: toolArgSummary(tr.arguments) });
    } else if (type === "tool.execution_complete" || type === "tool.execution_completed" || type === "tool.execution_end") {
      const errored = data.isError || data.error || data.status === "error" || data.exitCode > 0 || data.result?.exitCode > 0;
      if (errored) {
        const text = data.error || (typeof data.result === "string" ? data.result : data.result?.output) || `tool ${data.toolName || ""} failed`;
        ev.push({ ts, type: "tool_error", tool: data.toolName || "", text: String(text) });
      }
    }
  }
  return ev.map((e, i) => ({ seq: i + 1, ...e }));
}

/** Dispatch to the right provider extractor. Returns [] for unknown providers. */
export function extractEvents(provider, lines) {
  if (provider === "claude") return claudeEvents(lines);
  if (provider === "codex") return codexEvents(lines);
  if (provider === "copilot") return copilotEvents(lines);
  return [];
}

// Type aliases so `--type err,call,asst` Just Works.
const TYPE_ALIASES = {
  call: "tool_call", tool: "tool_call", tools: "tool_call", tool_call: "tool_call", toolcall: "tool_call",
  error: "tool_error", err: "tool_error", errors: "tool_error", fail: "tool_error", failed: "tool_error", tool_error: "tool_error",
  assistant: "assistant", asst: "assistant", agent: "assistant", reply: "assistant",
  user: "user", prompt: "user", prompts: "user",
  think: "thinking", thinking: "thinking", reasoning: "thinking", reason: "thinking",
};
export function resolveTypes(list) {
  const raw = (Array.isArray(list) ? list : [list]).flatMap((s) => String(s || "").split(","));
  const set = new Set();
  for (const t of raw) {
    const k = t.trim().toLowerCase();
    if (k) set.add(TYPE_ALIASES[k] || k);
  }
  return set;
}

/** Filter an event timeline by type set, substring, seq neighborhood, and tail limit. Keeps original seq. */
export function filterEvents(events, { types, grep, limit, around, context = 5 } = {}) {
  let out = events;
  if (around && around > 0) out = out.filter((e) => Math.abs(e.seq - around) <= context);
  if (types && types.size) out = out.filter((e) => types.has(e.type));
  if (grep) { const g = grep.toLowerCase(); out = out.filter((e) => `${e.tool} ${e.text}`.toLowerCase().includes(g)); }
  if (limit && limit > 0 && out.length > limit) out = out.slice(-limit);
  return out;
}

/** Render a timeline to a plain-text block (one line per event, or full text when verbose). */
export function renderTimeline(events, { verbose = false, width = 140 } = {}) {
  if (!events.length) return "  (no matching events)";
  const seqW = Math.max(3, String(events[events.length - 1].seq).length);
  const typeW = Math.max(...events.map((e) => e.type.length));
  const lines = [];
  for (const e of events) {
    const head = `#${String(e.seq).padStart(seqW, "0")}  ${(e.ts || "").slice(11, 19) || "--:--:--"}  ${e.type.padEnd(typeW)}`;
    const body = e.tool ? (e.text ? `${e.tool}: ${e.text}` : e.tool) : e.text;
    if (verbose) {
      lines.push(head);
      lines.push(...String(body || "").split("\n").map((l) => `    ${l}`));
      lines.push("");
    } else {
      const oneLine = String(body || "").replace(/\s+/g, " ").trim();
      lines.push(`${head}  ${oneLine.length > width ? oneLine.slice(0, width - 1) + "…" : oneLine}`);
    }
  }
  return lines.join("\n");
}

/** Count events per type (for UI filter chips). */
export function eventTypeCounts(events) {
  const c = {};
  for (const e of events) c[e.type] = (c[e.type] || 0) + 1;
  return c;
}

/**
 * Shared `--events` CLI mode for all three analyzers. Reads flags from argv:
 *   --type a,b   include only these types (aliases ok: err, call, asst, …)
 *   --grep <s>   substring filter on tool + text
 *   --limit N    keep only the last N matching events
 *   --around N   keep only events within --context of seq N (drill into a moment)
 *   --context N  neighborhood radius for --around (default 5)
 *   --verbose    full multi-line text instead of one truncated line
 *   --json       emit the filtered event array as JSON
 * Returns the text to print.
 */
export function runEventsMode(provider, content, argv) {
  const flagVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const all = extractEvents(provider, content.split("\n"));
  const filtered = filterEvents(all, {
    types: resolveTypes(flagVal("--type") ? [flagVal("--type")] : []),
    grep: flagVal("--grep"),
    limit: Number(flagVal("--limit") || 0),
    around: Number(flagVal("--around") || 0),
    context: Number(flagVal("--context") || 5),
  });
  if (argv.includes("--json")) return JSON.stringify(filtered, null, 2);
  const counts = eventTypeCounts(all);
  const summary = EVENT_TYPES.filter((t) => counts[t]).map((t) => `${t} ${counts[t]}`).join("  ·  ");
  const header = `TIMELINE  ${filtered.length}/${all.length} events${summary ? `   (${summary})` : ""}`;
  return `${header}\n${"─".repeat(Math.min(header.length, 60))}\n${renderTimeline(filtered, { verbose: argv.includes("--verbose") || argv.includes("-v") })}`;
}

// ── Friction moments (single-session "where did it hurt" ranking) ────────────
//
// The per-session counterpart to incidents.mjs (which ranks MANY sessions):
// given ONE session's normalized event stream, find and rank the concrete
// MOMENTS of friction so "what was the most frictionful interaction here?" is
// one command instead of hand-composed timeline queries. Moment kinds:
//   interrupt      the human hit Esc mid-turn (strongest rework signal)
//   correction     a human prompt matching the defect lexicon ("wrong", "still broken", …)
//   error-cluster  one or more tool_error events close together, enriched with the
//                  CAUSING call before the first error and the RECOVERY call after
//                  the last (flagging a near-identical retry = wasted turn)
//   churn          the same tool_call (tool + arg prefix) issued ≥3× (re-run struggle;
//                  threshold 3 so legit before/after measurement pairs don't flag)
// Same defect lexicon family as incidents.mjs so a "correction" means the same
// thing fleet-wide and in-session.

const CORRECTION_RE = /\b(still|again|nope|wrong|broken|doesn'?t|does not|isn'?t|not working|revert|undo|fix|missing|redo|regenerate|stuck|fails?|failing|error|crash|hang|why (isn'?t|does|won'?t)|that'?s not|not what)\b/i;
const INTERRUPT_RE = /\[Request interrupted by user/;

const norm = (s, n = 100) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

export function frictionMoments(events, { top = 10, clusterGap = 8 } = {}) {
  const moments = [];

  // interrupts + corrections (only real human prompts — classify() drops skill
  // preambles and slash-UI noise that would otherwise trip the lexicon). A
  // correction only makes sense AFTER the agent has done something — the initial
  // ask often contains lexicon words ("fix the failing build") without being rework.
  const firstAgentSeq = events.find((e) => e.type !== "user")?.seq ?? Infinity;
  for (const e of events) {
    if (e.type !== "user" || e.seq <= firstAgentSeq) continue;
    if (INTERRUPT_RE.test(e.text)) {
      moments.push({ kind: "interrupt", score: 8, seq: e.seq, seqEnd: e.seq, ts: e.ts, headline: "user interrupted the agent mid-turn", snippet: norm(e.text, 140) });
      continue;
    }
    const c = classify(e.text);
    if (c && c.kind === "human" && CORRECTION_RE.test(c.text)) {
      moments.push({ kind: "correction", score: 6, seq: e.seq, seqEnd: e.seq, ts: e.ts, headline: "human course-correction", snippet: norm(c.text, 140) });
    }
  }

  // error clusters: group tool_errors whose seqs are within clusterGap, then
  // enrich each cluster with cause (last call before) and recovery (first call after)
  const errors = events.filter((e) => e.type === "tool_error");
  let i = 0;
  while (i < errors.length) {
    let j = i;
    while (j + 1 < errors.length && errors[j + 1].seq - errors[j].seq <= clusterGap) j++;
    const cluster = errors.slice(i, j + 1);
    const first = cluster[0], last = cluster[cluster.length - 1];
    const cause = [...events].reverse().find((e) => e.type === "tool_call" && e.seq < first.seq);
    const recovery = events.find((e) => e.type === "tool_call" && e.seq > last.seq);
    const retried = cause && recovery && cause.tool === recovery.tool && norm(cause.text, 4000) === norm(recovery.text, 4000);
    const nearIdentical = !retried && cause && recovery && cause.tool === recovery.tool && norm(cause.text, 40) === norm(recovery.text, 40);
    const tools = [...new Set(cluster.map((e) => e.tool).filter(Boolean))];
    moments.push({
      kind: "error-cluster",
      score: 3 + 2 * (cluster.length - 1) + (retried ? 2 : 0),
      seq: first.seq, seqEnd: last.seq, ts: first.ts,
      headline: `${cluster.length} tool error${cluster.length > 1 ? "s" : ""}${tools.length ? ` (${tools.join(", ")})` : ""}${retried ? " — retried the identical call" : nearIdentical ? " — recovered with a corrected retry" : ""}`,
      snippet: norm(first.text, 160),
      cause: cause ? { seq: cause.seq, tool: cause.tool, text: norm(cause.text, 120) } : null,
      recovery: recovery ? { seq: recovery.seq, tool: recovery.tool, text: norm(recovery.text, 120) } : null,
    });
    i = j + 1;
  }

  // churn: identical (tool + arg prefix) call issued ≥3 times. File tools are
  // excluded — their arg summary is just the path, so repeated edits/reads of
  // one file share a key without being the same action (normal iteration).
  const CHURN_EXEMPT = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookRead", "NotebookEdit", "TodoWrite"]);
  const byKey = new Map();
  for (const e of events) {
    if (e.type !== "tool_call" || CHURN_EXEMPT.has(e.tool)) continue;
    const key = `${e.tool} ${norm(e.text)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  for (const occ of byKey.values()) {
    if (occ.length < 3) continue;
    moments.push({
      kind: "churn",
      score: 1 + 1.5 * (occ.length - 2),
      seq: occ[0].seq, seqEnd: occ[occ.length - 1].seq, ts: occ[occ.length - 1].ts,
      headline: `${occ.length}× same ${occ[0].tool} call (seqs ${occ.map((e) => e.seq).join(", ")})`,
      snippet: norm(occ[0].text, 140),
    });
  }

  moments.sort((a, b) => b.score - a.score || a.seq - b.seq);
  return moments.slice(0, top).map((m, idx) => ({ rank: idx + 1, ...m }));
}

/**
 * Shared `--friction` CLI mode for all three analyzers: rank this session's
 * friction moments. Flags: --top N (default 10), --json. Returns text to print.
 */
export function runFrictionMode(provider, content, argv) {
  const flagVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const events = extractEvents(provider, content.split("\n"));
  const moments = frictionMoments(events, { top: Number(flagVal("--top") || 10) });
  if (argv.includes("--json")) return JSON.stringify(moments, null, 2);
  if (!moments.length) return "FRICTION  none detected — no tool errors, interrupts, corrections, or call churn in this session.";
  const counts = {};
  for (const m of moments) counts[m.kind] = (counts[m.kind] || 0) + 1;
  const lines = [
    `FRICTION  ${moments.length} moment(s), most frictionful first   (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")})`,
    "─".repeat(60),
  ];
  for (const m of moments) {
    const at = m.seq === m.seqEnd ? `#${m.seq}` : `#${m.seq}–#${m.seqEnd}`;
    lines.push(`${m.rank}. [${m.score.toFixed(1)}] ${m.kind}  @${at} ${(m.ts || "").slice(11, 19)}  ${m.headline}`);
    if (m.snippet) lines.push(`     ${m.snippet}`);
    if (m.cause) lines.push(`     cause    #${m.cause.seq} ${m.cause.tool}: ${m.cause.text}`);
    if (m.recovery) lines.push(`     recovery #${m.recovery.seq} ${m.recovery.tool}: ${m.recovery.text}`);
    lines.push(`     drill: --events --around ${m.seq} --context 6 -v`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Normalized cross-provider summary (for server / UI) ──────────────────────

/**
 * Fold any provider's native stats into one shape the web UI renders uniformly.
 * Returns null for unknown providers.
 */
export function summarize(provider, content) {
  const lines = content.split("\n");
  const last = (a) => (a && a.length ? a[a.length - 1] : "");

  if (provider === "claude") {
    const s = parseClaude(lines);
    return {
      provider, sessionId: s.sessionId, model: s.model, cwd: s.cwd,
      startTime: s.startTime, endTime: s.endTime, durationSec: s.durationSec,
      turns: s.assistantTurns, toolCalls: s.toolCalls, failedToolCalls: s.failedToolCalls,
      toolUsePatterns: Object.entries(s.toolNames).map(([tool, v]) => ({ tool, count: v.count, failed: v.failed })).sort((a, b) => b.count - a.count),
      repeatedCommands: s.repeatedCommands,
      commandsRun: s.commands,
      errors: s.errors,
      userMessages: s.userMessages,
      assistantMessages: s.assistantTexts,
      firstUser: s.userMessages[0] || "", lastUser: last(s.userMessages),
      lastAssistant: last(s.assistantTexts),
      inputTokens: s.inputTokens, outputTokens: s.outputTokens, cacheReadTokens: s.cacheReadTokens, totalCostUsd: s.totalCostUsd,
      stopReason: s.stopReason,
      hitLimit: s.hitLimit, endedOnLimit: s.endedOnLimit, endedInterrupted: s.endedInterrupted,
      aiTitle: s.aiTitle, firstPrompt: s.firstPrompt, lastPrompt: s.lastPrompt,
      filesRead: s.filesRead, filesEdited: s.filesEdited, filesWritten: s.filesWritten,
      extra: {},
    };
  }

  if (provider === "codex") {
    const { stats: s } = parseCodex(lines);
    return {
      provider, sessionId: s.sessionId, model: s.model, cwd: s.cwd,
      startTime: s.startTime, endTime: s.endTime, durationSec: s.durationSec,
      turns: s.turns, toolCalls: s.toolCalls, failedToolCalls: 0,
      toolUsePatterns: Object.entries(s.toolNames).map(([tool, count]) => ({ tool, count, failed: 0 })).sort((a, b) => b.count - a.count),
      repeatedCommands: s.repeatedCommands,
      commandsRun: s.commands,
      errors: [],
      userMessages: s.userMessages,
      assistantMessages: s.agentMessages,
      firstUser: s.userMessages[0] || "", lastUser: last(s.userMessages),
      lastAssistant: last(s.agentMessages),
      inputTokens: s.inputTokens, outputTokens: s.outputTokens, cacheReadTokens: 0, totalCostUsd: 0,
      stopReason: "",
      filesRead: [],
      filesEdited: [...new Set(s.patchesApplied.flatMap((p) => p.files))],
      filesWritten: [],
      extra: { cliVersion: s.cliVersion, webSearches: s.webSearches, patchesApplied: s.patchesApplied },
    };
  }

  if (provider === "copilot") {
    const s = parseCopilot(lines);
    return {
      provider, sessionId: s.sessionId, model: s.model, cwd: s.cwd,
      startTime: s.startTime, endTime: s.endTime, durationSec: s.durationSec,
      turns: s.turns, toolCalls: s.toolCalls, failedToolCalls: 0,
      toolUsePatterns: Object.entries(s.toolNames).map(([tool, count]) => ({ tool, count, failed: 0 })).sort((a, b) => b.count - a.count),
      repeatedCommands: s.repeatedCommands,
      commandsRun: s.commands,
      errors: [],
      userMessages: s.userMessages,
      assistantMessages: s.assistantMessages,
      firstUser: s.userMessages[0] || "", lastUser: last(s.userMessages),
      lastAssistant: last(s.assistantMessages),
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0,
      stopReason: s.shutdownType,
      filesRead: [],
      filesEdited: s.filesModified,
      filesWritten: [],
      extra: { copilotVersion: s.copilotVersion, branch: s.branch, linesAdded: s.linesAdded, linesRemoved: s.linesRemoved, totalApiDurationMs: s.totalApiDurationMs },
    };
  }

  return null;
}
