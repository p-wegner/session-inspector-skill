/**
 * node --test scripts/test/brief.test.mjs
 *
 * The cross-harness brief. Four things in it have already been wrong once, and each
 * is wrong in a way a reader cannot see:
 *
 *   1. The vocabulary table rewriting a term INSIDE a code span, inventing a flag
 *      that does not exist. The brief still reads fluently, which is the problem.
 *   2. Anchors listing the previous session's temp scratchpad, pointing the new
 *      session at a tree the OS may have cleared and it has no reason to trust.
 *   3. The Goal section coming out empty for a codex session that was SEEDED rather
 *      than typed into — exactly the sessions a handoff is about — because its
 *      prompts arrive on a different channel than an interactive run's.
 *   4. The evidence/assertion split collapsing: a tracking file's claim and the
 *      session's own claim must never render as the same kind of thing, and the
 *      budget must never trim the evidence half to make room.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  makeGloss, repoRelativeFiles, codexHumanPrompts, sectionBullets, buildModel,
  renderBrief, continuationBlock, seedPrompt, estimateTokens, TRIED_REJECTED_RE,
} from "../lib/brief.mjs";

// ── 1. the gloss must not touch code ────────────────────────────────────────
test("gloss translates prose and leaves code spans alone", () => {
  const g = makeGloss("codex");
  assert.equal(g("it dispatched two subagents"), "it dispatched two helper runs the other agent dispatched");
  // The measured defect: a backticked flag name came out rewritten.
  assert.equal(g("no `--subagents` override at all"), "no `--subagents` override at all");
  assert.equal(g("`TodoWrite` vs TodoWrite"), "`TodoWrite` vs its in-session todo list");
  // Several code spans, so the placeholders have to come back in the right order.
  assert.equal(g("`a` then `b` then `c`"), "`a` then `b` then `c`");
});

test("gloss is a no-op for an unknown or neutral target", () => {
  for (const t of ["any", "copilot", "nonsense"]) {
    assert.equal(makeGloss(t)("it dispatched two subagents"), "it dispatched two subagents");
  }
});

// ── 2. anchors are repo paths, relative, and never temp ─────────────────────
test("repoRelativeFiles keeps repo files relative and drops temp/scratchpad ones", () => {
  const cwd = "C:\\projects\\acme\\app";
  const got = repoRelativeFiles([
    "C:\\projects\\acme\\app\\src\\index.ts",
    "C:/projects/acme/app/docs/plan.md",
    "C:/Users/p/AppData/Local/Temp/claude/x/abc/scratchpad/notes.md",
    "C:\\projects\\acme\\other-repo\\file.ts",
    "C:\\projects\\acme\\app\\src\\index.ts",
    "",
  ], cwd);
  assert.deepEqual(got, ["src\\index.ts", "docs/plan.md"]);
});

test("repoRelativeFiles does not treat a sibling with a shared prefix as inside the repo", () => {
  const got = repoRelativeFiles(["C:\\projects\\acme\\app-old\\x.ts"], "C:\\projects\\acme\\app");
  assert.deepEqual(got, []);
});

test("repoRelativeFiles without a cwd passes paths through, minus temp ones", () => {
  const got = repoRelativeFiles(["/srv/app/x.ts", "/tmp/y.ts"], "");
  assert.deepEqual(got, ["/srv/app/x.ts"]);
});

// ── 3. a codex session's prompts, including the seeded case ─────────────────
const codexLine = (role, text) => JSON.stringify({
  type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] },
});

test("codexHumanPrompts finds the prompts a seeded run puts on the response_item channel", () => {
  const transcript = [
    JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "C:/r" } }),
    codexLine("developer", "<skills_instructions> ## Skills ..."),
    codexLine("user", "<recommended_plugins>\nAirtable ..."),
    codexLine("user", "# AGENTS.md instructions for C:\\r\n<INSTRUCTIONS>"),
    codexLine("user", "<skill>\n<name>board-monitor</name>"),
    codexLine("user", "Fix the failing merge reconciler"),
    codexLine("assistant", "on it"),
    codexLine("user", "also update CONTINUE.md"),
    "not json at all",
    "",
  ].join("\n");
  assert.deepEqual(codexHumanPrompts(transcript), ["Fix the failing merge reconciler", "also update CONTINUE.md"]);
});

test("codexHumanPrompts returns nothing for a transcript with only injected envelopes", () => {
  const transcript = [codexLine("user", "<user_instructions>do X</user_instructions>"), codexLine("developer", "hi")].join("\n");
  assert.deepEqual(codexHumanPrompts(transcript), []);
});

// ── the standing "tried and rejected" section ───────────────────────────────
test("sectionBullets reads the do-not-redo section and skips fenced code", () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-test-"));
  const p = join(dir, "CONTINUE.md");
  writeFileSync(p, [
    "# CONTINUE", "", "## 2026-09-15 — a pass", "- did a thing", "",
    "## Tried and rejected", "- pnpm workspaces: the store corrupts on this box",
    "```", "- a bullet inside a fence is not an item", "```",
    "- a second rejected approach", "", "## Next steps", "1. do the next thing",
  ].join("\n"), "utf-8");
  assert.deepEqual(sectionBullets(p, TRIED_REJECTED_RE), [
    "pnpm workspaces: the store corrupts on this box",
    "a second rejected approach",
  ]);
  assert.deepEqual(sectionBullets(join(dir, "nope.md"), TRIED_REJECTED_RE), []);
});

// ── 4. evidence and assertion never merge, and the budget never eats evidence ──
const summaryStub = (over = {}) => ({
  provider: "claude", sessionId: "abc12345-0000", model: "claude-opus-5", cwd: "C:\\projects\\acme\\app",
  startTime: "2026-09-15T08:00:00Z", endTime: "2026-09-15T09:00:00Z", turns: 12, toolCalls: 30,
  stopReason: "end_turn", userMessages: ["build the thing"], assistantMessages: [],
  firstUser: "build the thing", lastUser: "build the thing", lastAssistant: "I finished the migration and it works.",
  filesEdited: ["C:\\projects\\acme\\app\\src\\a.ts"], filesWritten: [], filesRead: [],
  ...over,
});

const docsStub = {
  continueDoc: { exists: true, path: "C:\\projects\\acme\\app\\CONTINUE.md", passes: [{ title: "2026-09-15 — pass" }], done: [{ text: "migration landed, verified by the 41-test suite" }] },
  backlogDoc: { exists: false },
  hasLocal: false,
  open: [{ text: "wire the second adapter", section: "Next steps", doc: "CONTINUE.md" }],
  blocked: [],
  warnings: [],
};

test("a recorded claim and an asserted claim are rendered as different kinds of thing", () => {
  const m = buildModel({
    provider: "claude", target: "codex", sessionId: "abc12345-0000", transcript: "C:\\t.jsonl",
    summary: summaryStub(), cwd: "C:\\projects\\acme\\app",
    git: { exists: true, dir: "C:\\projects\\acme\\app", branch: "main", dirty: 2, ahead: 1, behind: 0, tracked: true, lastCommit: "abc1234 do it", lastCommitAt: "2026-09-15T09:00:00Z" },
    docs: docsStub, triedRejected: ["do not re-run the pnpm migration"],
  });
  const md = renderBrief(m);

  // The doc's claim carries its source; the session's claim carries the warning.
  assert.match(md, /## Recorded in the repo's tracking files/);
  assert.match(md, /migration landed, verified by the 41-test suite/);
  assert.match(md, /## Asserted by the prior session — unverified/);
  assert.match(md, /No check backs any of it/);
  assert.match(md, /I finished the migration and it works\./);
  // The do-not-redo list is present and named as such.
  assert.match(md, /## Do not redo — tried and rejected/);
  // Anchors are repo-relative, not absolute.
  assert.match(md, /`src\\a\.ts`/);
  assert.doesNotMatch(md, /C:\\projects\\acme\\app\\src\\a\.ts/);
});

test("a codex source says explicitly that there is no background state to inherit", () => {
  const m = buildModel({
    provider: "codex", target: "claude", sessionId: "01a0", transcript: "C:\\c.jsonl",
    // A seeded codex run has no `user_message` events at all, so the parsed
    // firstUser/lastUser are empty and the recovered prompts are the only source.
    summary: summaryStub({ provider: "codex", lastAssistant: "done", firstUser: "", lastUser: "", userMessages: [] }),
    cwd: "", git: null, docs: null, machine: null, scratch: null, humanPrompts: ["fix the reconciler"],
  });
  const md = renderBrief(m);
  assert.match(md, /A codex session has no background tools/);
  assert.match(md, /fix the reconciler/);
  // No tracking files → the brief says so instead of leaving the section blank.
  assert.match(md, /this repo has no `CONTINUE\.md`/);
});

test("a CONTINUE.md with no itemisable content refuses to imply that nothing is open", () => {
  const m = buildModel({
    provider: "claude", target: "any", sessionId: "abc", transcript: "C:\\t.jsonl",
    summary: summaryStub(), cwd: "C:\\projects\\acme\\app",
    docs: { ...docsStub, open: [], continueDoc: { ...docsStub.continueDoc, done: [] } },
  });
  assert.match(renderBrief(m), /no conclusion about what is open can be drawn from this brief/);
});

test("the budget trims the recoverable sections and never the recorded evidence", () => {
  const m = buildModel({
    provider: "claude", target: "any", sessionId: "abc", transcript: "C:\\t.jsonl",
    summary: summaryStub({ lastAssistant: "x".repeat(900), filesEdited: Array.from({ length: 12 }, (_, i) => `C:\\projects\\acme\\app\\src\\f${i}.ts`) }),
    cwd: "C:\\projects\\acme\\app", docs: docsStub, triedRejected: ["do not re-run the pnpm migration"],
    machine: { background: [{ how: "run_in_background", command: "node long.mjs", paths: [] }], monitors: [], services: {}, notifications: [], todos: null },
    scratch: { dir: "C:\\t\\s", files: 3, bytes: 1024 },
  });
  const tight = renderBrief(m, { budget: 220 });
  assert.match(tight, /dropped for the token budget/);
  assert.match(tight, /migration landed, verified by the 41-test suite/);   // evidence survives
  assert.match(tight, /## Do not redo — tried and rejected/);               // so does the constraint list
  assert.ok(estimateTokens(tight) < estimateTokens(renderBrief(m, { budget: 99999 })));
});

// ── the target-specific instructions ────────────────────────────────────────
test("the continuation block addresses the target harness, and always demands a state check first", () => {
  for (const t of ["codex", "claude", "any"]) {
    assert.match(continuationBlock(t), /Re-establish state before editing anything/);
    assert.match(continuationBlock(t), /State the next step and the constraints/);
  }
  assert.match(continuationBlock("codex"), /You are codex/);
  assert.match(continuationBlock("codex"), /AGENTS\.md/);
  assert.match(continuationBlock("claude"), /You are Claude Code/);
  assert.doesNotMatch(continuationBlock("any"), /You are /);
});

test("the seed prompt is a pointer with no shell metacharacters of its own", () => {
  const seed = seedPrompt("claude", "C:/tmp/briefs/abc.md");
  assert.match(seed, /Read the handoff brief at C:\/tmp\/briefs\/abc\.md/);
  assert.doesNotMatch(seed, /[;`]/);
});
