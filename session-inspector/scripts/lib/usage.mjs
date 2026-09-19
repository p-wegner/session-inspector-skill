/**
 * Billed usage from a Claude transcript — ONE record per API call, not per row.
 *
 * Claude Code writes one `assistant` row per content block of a streamed response
 * (thinking, text, each tool_use), and every one of those rows repeats the SAME
 * `message.id` and the SAME `message.usage`. Summing usage over rows therefore
 * over-counts by the blocks-per-response ratio — measured 2026-09-18 on three
 * sessions: 344 rows / 188 calls, 196 / 64, 153 / 65 (1.8x to 3x). Verified on
 * the same sessions that input, cache_read, cache_creation AND output_tokens are
 * byte-identical across the rows of one id, so first-row-wins loses nothing.
 *
 *   const seen = new Set();                       // one per pass over one file set
 *   ...
 *   if (!firstRowOf(o.message, seen)) continue;   // a repeat of a call already counted
 *
 * Pass an explicit Set per pass: a tool that reads the same file twice (fleet-stats
 * does — parse first, per-turn curve second) must not treat the second pass as
 * duplicates of the first. A row without a message id is counted (never dropped).
 */
import { reach } from "./reach.mjs";

export function firstRowOf(msg, seen) {
  const id = msg?.id;
  if (!id) return true;
  if (seen.has(id)) { reach.dupUsageRow(); return false; }
  seen.add(id);
  (seen.outMax ||= new Map()).set(id, msg.usage?.output_tokens || 0);
  return true;
}

/**
 * Output tokens a REPEAT row adds over the rows of its id seen so far — call it on
 * the rows firstRowOf rejected, and add the result to the output already counted.
 *
 * The identical-usage rule above holds for a main transcript, not for a subagent's:
 * there the rows of one id are streaming snapshots and `output_tokens` grows row by
 * row while input and cache fields stay fixed. Measured 2026-09-19 on one session's
 * 9 subagent transcripts: 847 repeat rows with a larger output, 109k output tokens
 * from the first rows against 647k from the last. First-row-wins alone under-counted
 * a delegating session's output about 6x. Main transcripts of the same sessions: 0.
 */
export function lateOutput(msg, seen) {
  const id = msg?.id;
  const out = msg?.usage?.output_tokens || 0;
  if (!id || !seen.outMax?.has(id)) return 0;
  const prev = seen.outMax.get(id);
  if (out <= prev) return 0;
  seen.outMax.set(id, out);
  return out - prev;
}

/**
 * Which backend answered, read off the message id prefix Anthropic's SDKs emit:
 * `msg_01…` first-party API, `msg_vrtx_…` Vertex AI, `msg_bdrk_…` Bedrock. A gateway
 * that forwards to a cloud backend shows that backend's prefix, which is how a
 * "Claude via gateway" session reveals where the request actually ran.
 */
export function apiProvider(messageId) {
  if (!messageId) return "?";
  if (messageId.startsWith("msg_vrtx_")) return "vertex";
  if (messageId.startsWith("msg_bdrk_")) return "bedrock";
  if (messageId.startsWith("msg_")) return "anthropic";
  return "other";
}
