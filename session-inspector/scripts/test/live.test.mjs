/**
 * node --test scripts/test/live.test.mjs
 *
 * Covers the tail-classification walk, which is the subtle part: transcripts end
 * in timestamp-less sentinel records that are rewritten in place, so the naive
 * "read the last line" approach reports a session as idle while it is mid-tool-call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTailText, cwdToSlug } from "../lib/live.mjs";

const j = (o) => JSON.stringify(o);
/** classifyTailText skips index 0 (assumed a partial record), so pad the front. */
const tail = (...entries) => "\n" + entries.map(j).join("\n") + "\n";

const asst = (stop, ts = "2026-07-27T10:00:00.000Z") =>
  ({ type: "assistant", timestamp: ts, message: { role: "assistant", stop_reason: stop } });

test("turn_duration is the idle marker", () => {
  const r = classifyTailText(tail(asst("end_turn"), { type: "system", subtype: "turn_duration", durationMs: 1200, timestamp: "2026-07-27T10:00:05.000Z" }));
  assert.equal(r.state, "idle");
  assert.equal(r.reason, "system/turn_duration");
});

test("assistant end_turn alone is idle", () => {
  assert.equal(classifyTailText(tail(asst("end_turn"))).state, "idle");
});

test("assistant tool_use is active", () => {
  assert.equal(classifyTailText(tail(asst("end_turn"), asst("tool_use"))).state, "active");
});

test("a tool_result reply is active", () => {
  const r = classifyTailText(tail(asst("tool_use"), {
    type: "user", timestamp: "2026-07-27T10:00:01.000Z",
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  }));
  assert.equal(r.state, "active");
});

test("a streaming assistant message (null stop_reason) is active", () => {
  assert.equal(classifyTailText(tail(asst("end_turn"), asst(null))).state, "active");
});

test("sentinels after a tool_use must NOT read as idle", () => {
  // The regression this whole backwards-walk exists to prevent: these four records
  // are rewritten mid-turn, so a last-line reader sees them and reports idle.
  const r = classifyTailText(tail(
    asst("tool_use"),
    { type: "last-prompt", lastPrompt: "do the thing", leafUuid: "x", sessionId: "s" },
    { type: "mode", mode: "default" },
    { type: "ai-title", title: "Doing the thing" },
    { type: "queue-operation", op: "enqueue" },
  ));
  assert.equal(r.state, "active", "sentinels must be skipped, not treated as the last event");
});

test("sentinels after an end_turn still read as idle", () => {
  const r = classifyTailText(tail(
    asst("end_turn"),
    { type: "last-prompt", lastPrompt: "hi", leafUuid: "x", sessionId: "s" },
  ));
  assert.equal(r.state, "idle");
});

test("non-boundary system subtypes are skipped, not treated as idle", () => {
  const r = classifyTailText(tail(asst("tool_use"), { type: "system", subtype: "local_command", timestamp: "2026-07-27T10:00:02.000Z" }));
  assert.equal(r.state, "active");
});

test("lastRealTs comes from the classified entry, not the sentinels", () => {
  const r = classifyTailText(tail(asst("end_turn", "2026-07-27T10:00:00.000Z"), { type: "mode", mode: "default" }));
  assert.equal(r.lastRealTs, Date.parse("2026-07-27T10:00:00.000Z"));
});

test("nothing classifiable yields unknown, never a guess", () => {
  assert.equal(classifyTailText(tail({ type: "mode", mode: "default" })).state, "unknown");
  assert.equal(classifyTailText("").state, "unknown");
});

test("malformed lines are skipped without throwing", () => {
  const text = "\n{ this is not json\n" + j(asst("tool_use")) + "\n";
  assert.equal(classifyTailText(text).state, "active");
});

test("cwdToSlug matches Claude's project-dir encoding", () => {
  assert.equal(cwdToSlug("C:\\projects\\andrena\\claude-pick"), "C--projects-andrena-claude-pick");
  assert.equal(cwdToSlug("/home/x/my project"), "-home-x-my-project");
  assert.equal(cwdToSlug(null), null);
});
