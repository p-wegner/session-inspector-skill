/**
 * The model-backed depths: `llm` (a model writes the per-call lines) and `summary` (Claude
 * Code's own /compact on a copy). Each test pins one rule the 2026-09-19 build depends on:
 *   1. batches are bounded and ordered; a huge result is trimmed before it reaches the model;
 *   2. the reply is accepted with or without a fence, and a missing id falls back;
 *   3. a failed batch is reported and left to the string cut, never thrown, unless strict;
 *   4. compactTranscript in llm mode uses the narrations by tool_use id, and the string cut
 *      for the rest, and still keeps the pair valid;
 *   5. the config dir of a copy is the parent of its `projects` segment;
 *   6. summarizeCopy reports ok only when a compact_boundary landed in the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchCalls, parseNarrations, narrateCalls, promptFor } from "../lib/narrator.mjs";
import { compactTranscript, collectCalls } from "../lib/compact.mjs";
import { configDirOfTranscript, summarizeCopy } from "../lib/summarize.mjs";

const J = (o) => JSON.stringify(o);
const call = (id, name, input, result, is_error = false) => [
  J({ type: "assistant", uuid: `a${id}`, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }),
  J({ type: "user", uuid: `u${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result, is_error }] } }),
];
const prompt = (t, u) => J({ type: "user", uuid: u, message: { role: "user", content: t } });

function lines() {
  return [
    prompt("do it", "p1"),
    ...call("t1", "Bash", { command: "node --test" }, "ℹ tests 6\nℹ pass 5\nℹ fail 1"),
    ...call("t2", "Read", { file_path: "C:\\r\\a.ts" }, "x".repeat(9000)),
    ...call("t3", "Edit", { file_path: "C:\\r\\a.ts", old_string: "a", new_string: "b" }, "boom", true),
    prompt("and then", "p2"),
    ...call("t4", "Bash", { command: "git status" }, "clean"),
  ];
}

test("collectCalls yields the calls the pass would rewrite, joined with their results", () => {
  const calls = collectCalls(lines(), { recent: 1 });
  assert.deepEqual(calls.map((c) => c.id), ["t1", "t2", "t3"]);
  assert.equal(calls[0].resultText, "ℹ tests 6\nℹ pass 5\nℹ fail 1");
  assert.equal(calls[2].isError, true);
  assert.deepEqual(collectCalls(lines(), { recent: 0 }).map((c) => c.id), ["t1", "t2", "t3", "t4"]);
});

test("batches are bounded, ordered, and trim a huge result before it reaches the model", () => {
  const calls = collectCalls(lines(), { recent: 0 });
  const one = batchCalls(calls, { maxChars: 1_000_000, maxCalls: 2 });
  assert.deepEqual(one.map((b) => b.map((c) => c.id)), [["t1", "t2"], ["t3", "t4"]]);
  const big = one[0][1];
  assert.ok(big.result.length < 4_000, `trimmed to ${big.result.length}`);
  assert.match(big.result, /chars omitted/);
  assert.equal(one[1][0].error, true);
  assert.match(promptFor(one[0]), /oldest first/);
});

test("the reply is accepted with or without a fence; malformed is empty", () => {
  const fenced = "```json\n{\"t1\": {\"did\": \"ran the tests\", \"got\": \"6 tests, 5 pass, 1 fail\"}}\n```";
  assert.deepEqual(parseNarrations(fenced), { t1: { did: "ran the tests", got: "6 tests, 5 pass, 1 fail" } });
  assert.deepEqual(parseNarrations('Sure: {"t2":{"did":"Read a.ts","got":"9000 chars of x"}} done'), { t2: { did: "Read a.ts", got: "9000 chars of x" } });
  assert.deepEqual(parseNarrations("no json here"), {});
  assert.deepEqual(parseNarrations('{"t1": "not an object"}'), {});
});

test("a failed batch is reported and left to the fallback; strict throws", () => {
  const calls = collectCalls(lines(), { recent: 0 });
  let n = 0;
  const run = () => { n++; if (n === 1) throw new Error("rate limited"); return { text: '{"t3":{"did":"Edit a.ts","got":"ERROR: boom"}}', costUsd: 0.01, inputTokens: 100, outputTokens: 20, model: "claude-haiku-4-5" }; };
  const { narrations, report } = narrateCalls(calls, { run, maxCalls: 2, model: "haiku" });
  assert.equal(report.batches, 2);
  assert.equal(report.failedBatches, 1);
  assert.equal(report.narrated, 1);
  assert.equal(report.fallback, 3, "two from the failed batch, one unnamed in the second");
  assert.equal(report.costUsd, 0.01);
  assert.equal(report.model, "claude-haiku-4-5");
  assert.deepEqual([...narrations.keys()], ["t3"]);
  assert.throws(() => narrateCalls(calls, { run: () => { throw new Error("down"); }, strict: true }), /down/);
});

test("llm mode writes the narrations by id and falls back per call", () => {
  const narrations = new Map([["t1", { did: "ran node --test", got: "6 tests: 5 pass, 1 fail" }]]);
  const { lines: out, stats } = compactTranscript(lines(), { recent: 1, mode: "llm", narrations });
  const objs = out.map((l) => JSON.parse(l));
  const uses = objs.flatMap((o) => (Array.isArray(o.message?.content) ? o.message.content.filter((b) => b.type === "tool_use") : []));
  const results = objs.flatMap((o) => (Array.isArray(o.message?.content) ? o.message.content.filter((b) => b.type === "tool_result") : []));
  assert.deepEqual(uses[0].input, { "session-compact": "ran node --test" });
  assert.equal(results[0].content, "[session-compact] 6 tests: 5 pass, 1 fail");
  assert.deepEqual(uses[1].input, { "session-compact": "Read C:/r/a.ts" }, "no narration: the string cut");
  assert.equal(results[1].content, "[session-compact] 1 lines");
  assert.equal(results[2].is_error, true);
  assert.deepEqual(uses[3].input, { command: "git status" }, "after the last prompt: verbatim");
  assert.equal(stats.compacted, 3);
});

test("the config dir of a copy is the parent of its projects segment", () => {
  assert.equal(configDirOfTranscript("C:\\Users\\x\\.claude-work\\projects\\C--repo\\abc.jsonl"), ["C:", "Users", "x", ".claude-work"].join(require_sep()));
  assert.equal(configDirOfTranscript("/home/x/.claude/projects/-home-x-repo/abc.jsonl"), ["", "home", "x", ".claude"].join(require_sep()));
  assert.equal(configDirOfTranscript("/nowhere/abc.jsonl"), null);
});
function require_sep() { return process.platform === "win32" ? "\\" : "/"; }

test("summarizeCopy reports ok only when a compact_boundary landed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-"));
  const path = join(dir, "projects", "p", "abc.jsonl");
  mkdirSync(join(dir, "projects", "p"), { recursive: true });
  writeFileSync(path, lines().join("\n"));
  const seen = [];
  const noWrite = (id, o) => { seen.push([id, o.configDir, o.model, o.settings]); return { costUsd: 0.02, model: "claude-haiku-4-5" }; };
  const r1 = summarizeCopy(path, { run: noWrite, model: "haiku", settings: "C:\\s.json", cwd: dir });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /no compact_boundary/);
  assert.deepEqual(seen[0], ["abc", dir, "haiku", "C:\\s.json"]);
  // The source's cost-state rides along in the copy, and a resumed -p call reports the running total.
  writeFileSync(path, lines().join("\n") + "\n" + J({ type: "cost-state", totalCostUSD: 0.5 }));
  const writes = (id, o) => {
    writeFileSync(path, lines().join("\n") + "\n" + J({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 12345 } }) + "\n" + J({ type: "user", isCompactSummary: true, message: { role: "user", content: "summary" } }));
    return { costUsd: 0.53, model: "claude-haiku-4-5" };
  };
  const r2 = summarizeCopy(path, { run: writes, model: "haiku", cwd: dir });
  assert.equal(r2.ok, true);
  assert.equal(r2.preTokens, 12345);
  assert.ok(Math.abs(r2.costUsd - 0.03) < 1e-9, `the call's own cost, not the running total: ${r2.costUsd}`);
  const failed = summarizeCopy(path, { run: () => { throw new Error("no such session"); }, cwd: dir });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /no such session/);
});
