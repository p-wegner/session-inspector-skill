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
  return true;
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
