/**
 * Shared extraction + classification of REAL human-typed prompts from a session
 * transcript. The hard part is telling a *typed* prompt from the noise that also
 * lands in `type:"user"` entries: tool_results, sidechain/subagent turns, meta
 * entries, slash-command stdout, harness echoes, and injected context blocks.
 *
 * Single source of truth for user-prompts.mjs (per-day listing) and
 * prompt-style.mjs (cross-session style aggregate). Node builtins only.
 */

// ── classify a raw user-entry text as human | automated | noise ──────────────
// Returns { kind, text } with text normalized (slash-command/bash-input unwrapped),
// or null to drop the entry entirely. (Lifted verbatim from user-prompts.mjs so
// both tools agree on what a "prompt" is.)
export function classify(raw) {
  let text = (raw || "").trim();
  if (!text) return null;

  // pure harness/echo noise — never a prompt
  if (/^<task-notification>/.test(text)) return null;
  if (/^<bash-stdout>|^<bash-stderr>/.test(text)) return null;
  if (/^<local-command-stdout>/.test(text)) return null;
  if (/^\[Request interrupted/.test(text)) return null;
  if (/^Caveat: The messages below/.test(text)) return null;

  // user-typed shell command (bash mode) → unwrap to "! cmd"
  const bash = text.match(/^<bash-input>([\s\S]*?)<\/bash-input>\s*$/);
  if (bash) return { kind: "human", text: `! ${bash[1].trim()}` };

  // slash command: <command-name>/x</command-name> ... <command-args>args</command-args>
  if (/<command-name>/.test(text)) {
    const name = (text.match(/<command-name>([^<]*)<\/command-name>/)?.[1] || "").trim().replace(/^\//, "");
    const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || "").trim();
    if (!name) return null;
    if (!args) {
      // bare UI command (/clear, /model, /fast …) — noise unless caller wants it
      return { kind: "noise", text: `/${name}` };
    }
    return { kind: "human", text: `/${name} ${args}` };
  }

  // automated agent traffic that lands in user entries
  if (/^\[SESSION HANDOFF/.test(text)) return { kind: "automated", text };
  if (/^You are the autonomous BOARD MONITOR/.test(text)) return { kind: "automated", text };
  if (/^Base directory for this skill:/.test(text)) return { kind: "automated", text };
  // injected continuation summary (context compaction handoff)
  if (/^This session is being continued from a previous conversation/.test(text)) return { kind: "automated", text };
  // internal LLM utility calls (file prediction, voice-note → ticket, etc.)
  if (/^You are a (project manager assistant|software engineer)/.test(text)) return { kind: "automated", text };
  // builder launch prompt = a ticket body, usually with the workflow preamble
  if (/stage of this issue's workflow/.test(text) || /^##\s+Workflow/m.test(text)) {
    return { kind: "automated", text };
  }
  // image-attachment coordinate marker injected by the harness
  if (/^\[Image: original \d+x\d+/.test(text)) return { kind: "noise", text };

  return { kind: "human", text };
}

// ── per-provider extraction (NO date filter — caller scopes) ──────────────────
// Each returns [{ ts, text, kind }] in file order.

export function extractClaudePrompts(content) {
  const out = [];
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj; try { obj = JSON.parse(s); } catch { continue; }
    if (obj.type !== "user") continue;
    if (obj.isMeta || obj.isSidechain) continue;
    if (obj.toolUseResult !== undefined) continue; // tool result, not a prompt
    const c = obj.message?.content;
    let raw = null;
    if (typeof c === "string") raw = c;
    else if (Array.isArray(c)) {
      if (c.some((b) => b.type === "tool_result")) continue;
      raw = c.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    const cl = classify(raw);
    if (cl) out.push({ ts: obj.timestamp || "", text: cl.text, kind: cl.kind });
  }
  return out;
}

export function extractCodexPrompts(content) {
  const out = [];
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj; try { obj = JSON.parse(s); } catch { continue; }
    if (obj.type !== "event_msg") continue;
    if (obj.payload?.type !== "user_message") continue;
    let text = (obj.payload.message || "").trim();
    if (!text) continue;
    if (/^<environment_context>/.test(text)) continue;
    if (/^<user_instructions>/.test(text)) continue;
    if (/^# AGENTS\.md|^<\/?user_instructions>/.test(text)) continue;
    const cl = classify(text);
    if (cl) out.push({ ts: obj.timestamp || "", text: cl.text, kind: cl.kind });
  }
  return out;
}

export function extractCopilotPrompts(content) {
  const out = [];
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj; try { obj = JSON.parse(s); } catch { continue; }
    if (obj.type !== "user.message") continue;
    const text = (obj.data?.content || "").trim();
    if (!text) continue;
    const cl = classify(text);
    if (cl) out.push({ ts: obj.timestamp || "", text: cl.text, kind: cl.kind });
  }
  return out;
}

/** Extract human/automated/noise prompts from a transcript for any provider. */
export function extractPrompts(provider, content) {
  if (provider === "claude") return extractClaudePrompts(content);
  if (provider === "codex") return extractCodexPrompts(content);
  if (provider === "copilot") return extractCopilotPrompts(content);
  return [];
}
