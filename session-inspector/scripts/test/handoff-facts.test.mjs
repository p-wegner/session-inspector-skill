/**
 * The handoff-facts layer: what a successor needs from a transcript that the
 * summary drops, and what the tracking files fail to record. Each test pins one
 * defect the 2026-09-19 lab measured on a real brief:
 *   1. the last "message" of a cut-off session was the limit banner;
 *   2. two runs in one command read as a contradiction (`pass 6 · fail 0 · fail 1`);
 *   3. the human's answers and the session's own diagnosis were not captured;
 *   4. a junction script's target was reported as `$target`;
 *   5. a WebFetch that returned a 404 notice was listed as a source;
 *   6. a stale "5 tests" in CONTINUE.md beat the last run's 6;
 *   7. later commits matched open items on words every commit shares;
 *   8. wrapped CONTINUE items were cut at their first line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFacts, tallyRuns, parseAnswers, checklistOf } from "../lib/session-facts.mjs";
import { matchOpenToLater } from "../lib/brief.mjs";
import { staleCounts, mentioned, docGaps } from "../lib/doc-gaps.mjs";
import { parseContinueDoc } from "../lib/repo.mjs";

const J = (o) => JSON.stringify(o);
const asst = (ts, content) => J({ type: "assistant", timestamp: ts, message: { role: "assistant", content } });
const user = (ts, content) => J({ type: "user", timestamp: ts, message: { role: "user", content } });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const res = (id, content, is_error = false) => ({ type: "tool_result", tool_use_id: id, content, is_error });

function transcript() {
  return [
    user("2026-09-19T10:00:00Z", "build a remediation skill for the scanner"),
    asst("2026-09-19T10:00:01Z", [use("q1", "AskUserQuestion", { questions: [] })]),
    user("2026-09-19T10:00:02Z", [res("q1", 'Your questions have been answered: "Is there a server?"="No server, docs only", "Where?"="Own repo". You can now continue with these answers in mind.')]),
    asst("2026-09-19T10:00:03Z", [use("w1", "WebFetch", { url: "https://docs.example.com/missing" })]),
    user("2026-09-19T10:00:04Z", [res("w1", "The server returned HTTP 404 Not Found.")]),
    asst("2026-09-19T10:00:05Z", [use("t1", "Bash", { command: "cd /c/p/repo && timeout 60 node --test test/ 2>&1 | tail" })]),
    user("2026-09-19T10:00:06Z", [res("t1", "Error: Cannot find module 'C:\\p\\repo\\test'\nℹ tests 1\nℹ pass 0\nℹ fail 1")]),
    asst("2026-09-19T10:00:07Z", [{ type: "text", text: "node --test needs a glob here, not a directory. Fixing it." }]),
    asst("2026-09-19T10:00:08Z", [use("t2", "Bash", { command: "cd /c/p/repo && node --test test/*.test.mjs; git stash; node --test test/*.test.mjs; git stash pop" })]),
    user("2026-09-19T10:00:09Z", [res("t2", "ℹ pass 6\nℹ fail 0\nℹ fail 1")]),
    asst("2026-09-19T10:00:10Z", [use("l1", "PowerShell", { command: '$target = "C:\\p\\repo"\nforeach ($p in (Get-ChildItem $env:USERPROFILE -Directory -Filter ".claude*")) { New-Item -ItemType Junction -Path x -Target $target }' })]),
    user("2026-09-19T10:00:11Z", [res("l1", ".claude: True .claude-b: True")]),
    asst("2026-09-19T10:00:12Z", [use("c1", "Edit", { file_path: "C:\\p\\repo\\CONTINUE.md", old_string: "a", new_string: "## 2026-09-19 - the scanner skill\n- built it" })]),
    user("2026-09-19T10:00:13Z", [res("c1", "ok")]),
    asst("2026-09-19T10:00:14Z", [{ type: "text", text: "Done.\n- [x] skill built\n- [ ] namespace: your call\n**Next:** decide the namespace." }]),
    asst("2026-09-19T10:00:15Z", [{ type: "text", text: "You've hit your session limit · resets 10:50pm" }]),
  ];
}

test("the last real message skips the limit banner and keeps the closing checklist", () => {
  const f = sessionFacts(transcript());
  assert.match(f.lastReal, /^Done\./);
  assert.deepEqual(f.closingChecklist.done, ["skill built"]);
  assert.deepEqual(f.closingChecklist.open, ["namespace: your call"]);
  assert.equal(f.closingChecklist.next, "decide the namespace.");
});

test("answers, prompts and the session's own diagnosis are captured", () => {
  const f = sessionFacts(transcript());
  assert.deepEqual(f.answers.map((a) => a.answer), ["No server, docs only", "Own repo"]);
  assert.equal(f.humanPrompts[0].text, "build a remediation skill for the scanner");
  const failing = f.tests.find((t) => t.diagnosis);
  assert.match(failing.diagnosis, /needs a glob/);
  assert.match(failing.firstError, /Cannot find module/);
});

test("two runs in one command stay two runs, and a stash marks the second", () => {
  assert.deepEqual(tallyRuns(["ℹ pass 6", "ℹ fail 0", "ℹ fail 1"]), [["ℹ pass 6", "ℹ fail 0"], ["ℹ fail 1"]]);
  const t = sessionFacts(transcript()).tests.at(-1);
  assert.equal(t.runs.length, 2);
  assert.equal(t.stashed, true);
});

test("a junction's target is resolved through its variable, with the command's output", () => {
  const [k] = sessionFacts(transcript()).links;
  assert.equal(k.target, "C:\\p\\repo");
  assert.equal(k.perProfile, true);
  assert.match(k.result, /\.claude-b: True/);
});

test("a fetch that returned a 404 notice is not a source", () => {
  const [s] = sessionFacts(transcript()).sources;
  assert.equal(s.ok, undefined);
  assert.equal(s.failedFetches, 1);
});

test("the session's own tracking-file entry is kept verbatim", () => {
  const [w] = sessionFacts(transcript()).trackingWrites;
  assert.match(w.text, /## 2026-09-19 - the scanner skill/);
});

test("parseAnswers and checklistOf read the harness's own formats", () => {
  assert.deepEqual(parseAnswers('Your questions have been answered: "A?"="yes". You can now continue'), [{ question: "A?", answer: "yes" }]);
  assert.deepEqual(checklistOf("x\n- [ ] one\n- [x] two").open, ["one"]);
});

test("a stale count in the tracking file is caught against the last passing run", () => {
  const tests = [{ ok: true, command: "node --test", runs: [["ℹ pass 6", "ℹ fail 0"], ["ℹ fail 1"]] }];
  const w = staleCounts("Offline tests: 5 tests pass against fixtures.", tests);
  assert.equal(w.length, 1);
  assert.equal(w[0].docSays, "5 tests");
  assert.equal(w[0].lastRun, "6");
  assert.deepEqual(staleCounts("6 tests pass", tests), []);        // matching count: nothing to say
  assert.deepEqual(staleCounts("400 tests elsewhere", tests), []);  // a different suite, not a stale one
});

test("an open item matches a later commit only on words that are rare across them", () => {
  const commits = [
    { sha: "a1", subject: "codex harness: opencode support", body: "" },
    { sha: "a2", subject: "codex harness: hooks pre-trusted, guard hook", body: "" },
    { sha: "a3", subject: "codex harness: statusline", body: "" },
    { sha: "a4", subject: "codex harness: docs", body: "" },
  ];
  const m = matchOpenToLater(["pre-trusted hooks for codex harness", "codex harness polish"], commits);
  assert.equal(m.length, 1);
  assert.equal(m[0].commits[0].sha, "a2");
});

test("a word match that lands only on docs-only commits is dropped, not shown", () => {
  const commits = [
    { sha: "d1", subject: "archive the trigger drill harness notes", body: "" },
    { sha: "c1", subject: "statusline", body: "" }, { sha: "c2", subject: "hooks", body: "" },
    { sha: "c3", subject: "docs", body: "" },
  ];
  const item = ["trigger drill harness, packaging decided"];
  assert.equal(matchOpenToLater(item, commits).length, 1);                                  // no code check: kept
  assert.deepEqual(matchOpenToLater(item, commits, { touchesCode: (sha) => sha !== "d1" }), []); // docs only: dropped
});

test("matchLanded ties an item to a struck heading, measured against the heading", async () => {
  const { matchLanded } = await import("../lib/brief.mjs");
  const landed = "## ~~Codex: ship the spend hooks pre-trusted~~ - **DONE** (2026-09-18)\n## ~~Budget guard as a hook~~ - **DONE**";
  const m = matchLanded(["pre-trusted hooks: needs the hash form from codex source", "a statusline for opencode"], landed);
  assert.equal(m.length, 1);
  assert.match(m[0].landed, /spend hooks pre-trusted/);
});

test("docGaps reports what the files lack and not what they have", () => {
  const f = sessionFacts(transcript());
  const g = docGaps(f, "The answer was: no server, docs only.");
  const decision = g.items.find((i) => i.kind === "human decision" && /No server/.test(i.fact));
  assert.equal(decision.found, true);
  assert.ok(!g.items.some((i) => i.kind === "source relied on"), "a 404'd URL is not a candidate");
  assert.ok(mentioned("see `iq.mjs` and realpath", "compare against realpath in `iq.mjs`").found);
});

test("parseContinueDoc keeps a wrapped item whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "cont-"));
  const p = join(dir, "CONTINUE.md");
  writeFileSync(p, "## Next steps\n\n1. `agent-pick`: the adapter that launches a home (`EnvMap` shape,\n   that repo's BACKLOG). The listing half is done.\n2. An archive pass.\n");
  const d = parseContinueDoc(p);
  assert.equal(d.open.length, 2);
  assert.match(d.open[0].text, /that repo's BACKLOG\)\. The listing half is done\.$/);
});
