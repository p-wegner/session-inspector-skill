/**
 * node --test scripts/test/reach.test.mjs
 *
 * The reach record is what makes a fleet number checkable, so its own counts must
 * not drift: read is found minus excluded, a file read twice reports its bad lines
 * and folded rows once, and a ranked table says it is a slice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reach } from "../lib/reach.mjs";
import { firstRowOf } from "../lib/usage.mjs";
import { parseClaude } from "../lib/parse.mjs";

test("read is found minus excluded, per agent and profile", () => {
  reach.begin("t", { days: 7 });
  reach.found("claude", "default", "a");
  reach.found("claude", "work", "b");
  reach.exclude("outside the --days window");
  reach.found("codex", "", "c");
  const j = reach.toJSON();
  assert.equal(j.transcriptsFound, 3);
  assert.equal(j.transcriptsRead, 2);
  assert.deepEqual(j.read, { claude: { default: 1 }, codex: { "-": 1 } });
  assert.deepEqual(j.excluded, { "outside the --days window": 1 });
});

test("a bulk exclude drops the last n still in, not ones already out", () => {
  reach.begin("t");
  for (const id of ["a", "b", "c", "d"]) reach.found("claude", "p", id);
  reach.exclude("filtered");            // d
  reach.exclude("other profile", 2);    // c, b
  const j = reach.toJSON();
  assert.equal(j.transcriptsRead, 1);
  assert.deepEqual(j.excluded, { filtered: 1, "other profile": 2 });
});

test("a file read twice counts its bad lines and folded rows once", () => {
  reach.begin("t");
  const row = JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 1 }, content: [] } });
  const lines = [row, row, "{not json", ""];
  for (let pass = 0; pass < 2; pass++) {
    reach.file("x.jsonl");
    parseClaude(lines);
  }
  const j = reach.toJSON();
  assert.equal(j.unparseableLines, 1);
  assert.deepEqual(j.unparseableFiles, ["x.jsonl"]);
  assert.equal(j.duplicateUsageRowsFolded, 1);
  assert.match(reach.line(), /1 unparseable line skipped in 1 file/);
});

test("firstRowOf reports every fold to reach", () => {
  reach.begin("t");
  reach.file("y.jsonl");
  const seen = new Set();
  assert.equal(firstRowOf({ id: "m" }, seen), true);
  assert.equal(firstRowOf({ id: "m" }, seen), false);
  assert.equal(firstRowOf({ id: "m" }, seen), false);
  assert.equal(firstRowOf({}, seen), true); // no id: counted, never dropped
  assert.equal(reach.toJSON().duplicateUsageRowsFolded, 2);
});

test("the measuring session is named, included or not", () => {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = "own-123";
  try {
    reach.begin("t");
    reach.found("claude", "p", "own-123");
    assert.match(reach.line(), /includes this session/);
    reach.exclude("filtered");
    assert.match(reach.line(), /this session not included/);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
});

test("a ranked table says it is a slice", () => {
  reach.begin("t");
  reach.shown(20, 55);
  assert.match(reach.line(), /showing 20 of 55 rows/);
  reach.shown(80, 55);
  assert.doesNotMatch(reach.line(), /showing/);
});
