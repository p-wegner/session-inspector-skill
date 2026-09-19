import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { claudeTurns } from "../lib/turns.mjs";
import { classify } from "../lib/prompts.mjs";
import * as cost from "../lib/lenses/cost.mjs";

// Synthetic transcripts only: placeholder ids, no real session content.

const row = (id, ts, usage, content = [{ type: "text", text: "x" }]) => JSON.stringify({
  type: "assistant", timestamp: ts, sessionId: "s-1", cwd: "/tmp/p",
  message: { id, model: "claude-opus-5", content, usage },
});
const u = (o, extra = {}) => ({ input_tokens: 10, output_tokens: o, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, ...extra });

test("a subagent's repeat rows grow output_tokens — the last row's count wins, input is counted once", () => {
  // streaming snapshots of ONE call: output 5 → 40 → 300
  const lines = [row("m1", "2026-01-01T00:00:00Z", u(5)), row("m1", "2026-01-01T00:00:01Z", u(40)), row("m1", "2026-01-01T00:00:02Z", u(300))];
  const { apiCalls } = claudeTurns(lines);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].output, 300);
  assert.equal(apiCalls[0].cacheRead, 100_000);
});

test("identical repeat rows (a main transcript) still count once", () => {
  const lines = [row("m1", "2026-01-01T00:00:00Z", u(50)), row("m1", "2026-01-01T00:00:00Z", u(50))];
  const { apiCalls } = claudeTurns(lines);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].output, 50);
});

test("Stop-hook and goal check-in messages are not human prompts", () => {
  assert.equal(classify("Stop hook feedback: [Goal: finish the backlog] keep going").kind, "automated");
  assert.equal(classify("Goal check-in: «Goal: finish the backlog»").kind, "automated");
  assert.equal(classify("please stop and summarise").kind, "human");
});

test("cost lens: a CLAUDE.md re-attached after a compaction is carried per load, not twice over the same calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "cost-lens-"));
  try {
    const att = (ts) => JSON.stringify({ type: "attachment", timestamp: ts, attachment: { type: "instructions", files: [{ path: "/p/CLAUDE.md", type: "Project", content: "x".repeat(40_000) }] } });
    const lines = [att("2026-01-01T00:00:00Z"),
      ...[1, 2, 3, 4].map((i) => row(`m${i}`, `2026-01-01T00:0${i}:00Z`, u(10))),
      att("2026-01-01T00:05:00Z"),
      ...[6, 7].map((i) => row(`m${i}`, `2026-01-01T00:0${i}:00Z`, u(10)))];
    const main = join(dir, "s-2.jsonl");
    writeFileSync(main, lines.join("\n"));
    const r = cost.analyze({ ...claudeTurns(lines), path: main });
    const prefix = r.sections.find((s) => s.title.startsWith("The fixed prefix"));
    const [name, tok, threads, loads, dollars] = prefix.table.rows[0];
    assert.equal(threads, "1");
    assert.equal(loads, "2");
    // 10k tokens × (4 + 2) calls × $0.50/M = $0.03 — carried over 6 calls, not 4 + 6
    assert.equal(dollars, "$0.03");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cost lens: a nested CLAUDE.md is a prefix part, and a skill-listing delta does not end the full listing's carry", () => {
  const dir = mkdtempSync(join(tmpdir(), "cost-lens-"));
  try {
    const att = (ts, a) => JSON.stringify({ type: "attachment", timestamp: ts, attachment: a });
    const lines = [
      att("2026-01-01T00:00:00Z", { type: "skill_listing", isInitial: true, skillCount: 3, content: "s".repeat(40_000) }),
      row("m1", "2026-01-01T00:01:00Z", u(10)),
      att("2026-01-01T00:01:30Z", { type: "nested_memory", path: "/p/sub/CLAUDE.md", displayPath: "sub/CLAUDE.md", content: "n".repeat(8_000) }),
      att("2026-01-01T00:01:40Z", { type: "skill_listing", isInitial: false, content: "d".repeat(400) }),
      row("m2", "2026-01-01T00:02:00Z", u(10)), row("m3", "2026-01-01T00:03:00Z", u(10)),
    ];
    const main = join(dir, "s-3.jsonl");
    writeFileSync(main, lines.join("\n"));
    const r = cost.analyze({ ...claudeTurns(lines), path: main });
    const rows = r.sections.find((s) => s.title.startsWith("The fixed prefix")).table.rows;
    const byName = Object.fromEntries(rows.map((x) => [x[0], x]));
    assert.ok(byName["sub/CLAUDE.md (nested)"], "nested_memory counted");
    // the full listing (10k tokens) is carried over all 3 calls: 10k × 3 × $0.50/M = $0.015
    assert.equal(byName["skill listing (3 skills)"][4], "$0.01");
    assert.equal(byName["skill listing (3 skills)"][3], "1");
    assert.ok(byName["skill listing updates"], "the delta is its own part");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cost lens: a cache re-write right after a compaction is not charged to idle time", () => {
  const big = (o) => u(o, { cache_creation_input_tokens: 80_000, cache_creation: { ephemeral_1h_input_tokens: 80_000 } });
  const lines = [
    row("m1", "2026-01-01T00:00:00Z", u(10)),
    JSON.stringify({ type: "user", timestamp: "2026-01-01T02:00:00Z", isCompactSummary: true, message: { role: "user", content: "summary" } }),
    row("m2", "2026-01-01T02:00:05Z", big(10)),                         // 2 h gap, but a compaction came first
    row("m3", "2026-01-01T04:00:00Z", big(10)),                         // 2 h gap, idle: counted
  ];
  const r = cost.analyze({ ...claudeTurns(lines), path: "" });
  assert.match(r.questions.find((q) => q.q === "Did idle time cost anything?").a, /^1 cold re-write /);
});

test("cost lens: subagents are part of the total, and their output is read from the last row", () => {
  const dir = mkdtempSync(join(tmpdir(), "cost-lens-"));
  try {
    const main = join(dir, "s-1.jsonl");
    writeFileSync(main, [row("m1", "2026-01-01T00:00:00Z", u(1000)), row("m2", "2026-01-01T00:10:00Z", u(1000))].join("\n"));
    mkdirSync(join(dir, "s-1", "subagents"), { recursive: true });
    writeFileSync(join(dir, "s-1", "subagents", "agent-x.jsonl"),
      [row("a1", "2026-01-01T00:05:00Z", u(10)), row("a1", "2026-01-01T00:05:01Z", u(2000))].join("\n"));
    writeFileSync(join(dir, "s-1", "subagents", "agent-x.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Test a thing" }));
    const t = claudeTurns([row("m1", "2026-01-01T00:00:00Z", u(1000)), row("m2", "2026-01-01T00:10:00Z", u(1000))]);
    const r = cost.analyze({ ...t, path: main });
    // opus: out $25/M, in $5/M, cache read 0.1x. main: 2 × (10×5 + 1000×25 + 100k×0.5)/1e6 = 0.15010; sub: (50 + 50000 + 50000)/1e6 = 0.10005
    const q = r.questions.find((x) => x.q === "What did it cost?").a;
    assert.match(q, /\$0\.25 at list price/);
    assert.match(q, /1 subagent/);
    const subs = r.sections.find((s) => s.title.startsWith("Subagents"));
    assert.equal(subs.table.rows[0][0], "Test a thing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
