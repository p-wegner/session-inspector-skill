import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { FACTS, HARNESS, PROVIDERS, TOOLS, cell, missing, refusal } from "../lib/harness.mjs";
import { render, DOC_PATH } from "../harness-matrix.mjs";

test("the checked-in matrix is what the registry renders", () => {
  const have = readFileSync(DOC_PATH, "utf8");
  assert.equal(have, render(), "run: node scripts/harness-matrix.mjs --write");
});

test("every agent answers every fact, with a reason where it is absent", () => {
  for (const p of PROVIDERS) {
    for (const f of Object.keys(FACTS)) {
      const v = HARNESS[p].facts[f];
      assert.ok(v === true || (typeof v === "string" && v.length > 10),
        `${p}.${f} must be true or a reason sentence, got ${JSON.stringify(v)}`);
    }
  }
});

test("a tool needs only facts that exist, and claims no agent whose data is missing", () => {
  for (const t of TOOLS) {
    for (const f of t.needs) assert.ok(f in FACTS, `${t.tool} needs unknown fact ${f}`);
    for (const p of t.wired) assert.equal(missing(t.tool, p).length, 0, `${t.tool} claims ${p}`);
    for (const p of PROVIDERS) assert.ok(["y", "cand", "n/a"].includes(cell(t.tool, p).state));
  }
});

test("a refusal names the missing fact and why the agent lacks it", () => {
  const line = refusal("session-dashboard --lens cost", "codex");
  assert.match(line, /cannot run on Codex/);
  assert.match(line, /prices in dollars/);          // the fact
  assert.match(line, /rollouts carry no cost/);      // the reason
  assert.equal(refusal("cache-health --session", "codex"), null);
  assert.equal(refusal("brief", "copilot"), null);
});

test("Claude Code is the reference: every fact holds there", () => {
  for (const f of Object.keys(FACTS)) assert.equal(HARNESS.claude.facts[f], true, f);
});
