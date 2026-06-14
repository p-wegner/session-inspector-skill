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
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj; try { obj = JSON.parse(trimmed); } catch { continue; }

    if (obj.timestamp) { if (!stats.startTime) stats.startTime = obj.timestamp; stats.endTime = obj.timestamp; }
    if (obj.sessionId && !stats.sessionId) stats.sessionId = obj.sessionId;
    if (obj.cwd && !stats.cwd) stats.cwd = obj.cwd;
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
      }
      for (const block of msg.content || []) {
        if (block.type === "text" && block.text) {
          stats.assistantTexts.push(block.text);
        } else if (block.type === "tool_use") {
          stats.toolCalls++;
          const name = block.name || "unknown";
          toolNameById.set(block.id, name);
          const e = toolCounts.get(name) || { count: 0, failed: 0 };
          e.count++; toolCounts.set(name, e);
          const fp = block.input?.file_path || block.input?.notebook_path;
          if (fp) {
            if (CLAUDE_READ_TOOLS.has(name)) pushUnique(stats.filesRead, fp);
            else if (CLAUDE_EDIT_TOOLS.has(name)) pushUnique(stats.filesEdited, fp);
            else if (CLAUDE_WRITE_TOOLS.has(name)) pushUnique(stats.filesWritten, fp);
          }
          const cmd = block.input?.command || block.input?.cmd || block.input?.script;
          if (typeof cmd === "string") commands.push(cmd);
        }
      }
    } else if (obj.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (!content.startsWith("<")) stats.userMessages.push(content);
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
  stats.toolNames = Object.fromEntries([...toolCounts.entries()]);
  stats.commands = commands;
  stats.repeatedCommands = repeatedFrom(commands);
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
