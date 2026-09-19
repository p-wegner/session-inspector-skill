/**
 * The operator-session layer: a long session that drives a local service over HTTP,
 * runs a /loop of scheduled wakeups, and works alongside agents that commit in the
 * same repo. Each test pins one defect the 2026-09-19 kanban lab measured on a real
 * 15-hour brief:
 *   1. 40 of 44 "human prompts" were /loop wakeup markers;
 *   2. vitest's "Duration … tests 6ms" line read as a second run, "4 ms of test" as a count;
 *   3. a `-d` in the NEXT command of a pipeline turned a GET into a POST;
 *   4. a compaction summary cut by position kept tool slips and lost the constraints;
 *   5. an edit to ~/.npmrc was reported without what changed, and its token must never leak;
 *   6. a guard override used on 25 commands was denied by every later summary;
 *   7. the CONTINUE pass on top said what was stuck under a bold lead-in, not at its top.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFacts, tallyRuns, httpActions, routeOf, isLoopWakeup } from "../lib/session-facts.mjs";
import { compactionPick, ticketLedger, newestPassHead } from "../lib/brief.mjs";
import { staleCounts } from "../lib/doc-gaps.mjs";

const J = (o) => JSON.stringify(o);
const asst = (ts, content) => J({ type: "assistant", timestamp: ts, message: { role: "assistant", content } });
const user = (ts, content, extra = {}) => J({ type: "user", timestamp: ts, ...extra, message: { role: "user", content } });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const res = (id, content) => ({ type: "tool_result", tool_use_id: id, content });

test("/loop wakeup markers are counted, not listed as human prompts", () => {
  const f = sessionFacts([
    user("2026-09-16T01:00:00Z", "get more active, we want the backlog to drain"),
    user("2026-09-16T01:10:00Z", "[3 prior /loop wakeups found nothing actionable; loop is healthy.]"),
    user("2026-09-16T01:20:00Z", "[1 prior /loop wakeup found nothing actionable; loop is healthy.]"),
    asst("2026-09-16T01:21:00Z", [use("w", "ScheduleWakeup", { stop: true })]),
  ]);
  assert.equal(f.humanPrompts.length, 1);
  assert.equal(f.loop.wakeups, 2);
  assert.equal(f.loop.lastSchedule.stop, true);
});

test("vitest's timing line is not a run, and a duration is not a count", () => {
  assert.deepEqual(tallyRuns(["Test Files  1 passed (1)", "Tests  5 passed (5)", "Duration  11.30s (tests 10ms)"]),
    [["Test Files  1 passed (1)", "Tests  5 passed (5)"]]);
  const tests = [{ ok: true, command: "vitest run", runs: [["Tests  5 passed (5)"]] }];
  assert.deepEqual(staleCounts("the guard costs 4 ms of test time", tests), []);
});

test("a mutating call is read up to its own pipe, not into the next command", () => {
  const a = httpActions(`curl -s "http://127.0.0.1:3001/api/workspaces/$WS/merge-status" | python -c "x" ; date -d now`);
  assert.deepEqual(a, []);
  const b = httpActions(`curl -s -X POST -H "Content-Type: application/json" -d '{"x":1}' "http://127.0.0.1:3001/api/workspaces/11111111-2222-4333-8444-555555555555/setup" | tail -3`);
  assert.equal(b.length, 1);
  assert.equal(b[0].method, "POST");
  assert.equal(routeOf(b[0].path), "/api/workspaces/:id/setup");
});

test("a compaction summary is picked by kind: constraints and refutations first, tool slips last", () => {
  const pick = compactionPick({
    "primary request and intent": "x\n**Standing constraints in force:**\n- Never delete kanban.db\n- Commit by pathspec",
    "errors and fixes": "- **Python parser assumed a dict** on the output\n- **Merge gate refused a stale branch** on its reversion diff\n**Hypotheses I formed and then publicly refuted:**\n- \"The store is corrupt\" — refuted",
    "pending tasks": "- **#1172**: merge not re-triggered yet, needs a new gate run",
  });
  const names = pick.map(([k]) => k);
  assert.match(names[0], /constraints/);
  assert.match(names[1], /refuted/);
  const errs = pick.find(([k]) => /errors/.test(k))[1];
  assert.ok(errs.indexOf("Merge gate") < errs.indexOf("Python parser"), "a system error outranks a tool slip");
  assert.ok(!/store is corrupt/.test(errs), "the refutation block is not repeated as an error");
});

test("an edit outside the repo keeps what changed, with its reason, and never a credential", () => {
  const f = sessionFacts([
    asst("2026-09-16T01:46:00Z", [{ type: "text", text: "apply the store-dir switch, the object cannot be removed" }]),
    asst("2026-09-16T01:47:00Z", [use("e", "Edit", { file_path: "C:\\Users\\x\\.npmrc", old_string: "store-dir=A\n//reg/:_authToken=npm_SECRET123", new_string: "store-dir=B\n//reg/:_authToken=npm_SECRET123" })]),
  ]);
  const e = f.edits["C:\\Users\\x\\.npmrc"];
  assert.match(e.new, /store-dir=B/);
  assert.ok(!JSON.stringify(e).includes("SECRET123"));
  assert.match(e.reason, /store-dir switch/);
});

test("a guard override on a command is recorded, however often a summary denies it", () => {
  const f = sessionFacts([
    asst("2026-09-16T01:23:00Z", [use("a", "Bash", { command: "ALLOW_CROSS_WORKTREE_WRITE=1 bash -c 'cd ../wt && git rebase master'" })]),
    asst("2026-09-16T02:13:00Z", [use("b", "Bash", { command: "ALLOW_CROSS_WORKTREE_WRITE=1 pnpm install" })]),
  ]);
  assert.equal(f.bypasses.ALLOW_CROSS_WORKTREE_WRITE.n, 2);
});

test("tickets are tied to later commits by subject, and a merge after the end says so", () => {
  const led = ticketLedger([{ n: "1172", mentions: 9, context: "" }], [{ n: "1176", title: "reaper cap" }], [],
    [{ sha: "a1", when: "2026-09-16T22:23", subject: "Merge branch 'feature/ak-1172-pre-merge-gate'" },
     { sha: "b2", when: "2026-09-16T22:24", subject: "fix(#1174): note names the writer", body: "follows #1176" }]);
  const t1172 = led.find((t) => t.n === "1172"), t1176 = led.find((t) => t.n === "1176");
  assert.equal(t1172.mergedAfter.sha, "a1");
  assert.equal(t1176.filed, true);
  assert.equal(t1176.afterCount, 0, "a body that cites a ticket is not a commit for it");
});

test("a merge into a train branch is not a merge", () => {
  const led = ticketLedger([{ n: "1141", mentions: 5, context: "" }], [], [],
    [{ sha: "c3", when: "2026-09-16T23:00", subject: "Merge branch 'feature/ak-1141-x' into train/7", onHead: false },
     { sha: "d4", when: "2026-09-17T01:00", subject: "Merge branch 'feature/ak-1141-x'", onHead: true }]);
  assert.equal(led[0].mergedAfter.sha, "d4");
  const off = ticketLedger([{ n: "1164", mentions: 5, context: "" }], [], [],
    [{ sha: "e5", when: "2026-09-16T23:00", subject: "Merge branch 'feature/ak-1164-y' into train/7", onHead: false }]);
  assert.equal(off[0].mergedAfter, null);
});

test("a /loop wakeup marker is never the goal", () => {
  assert.equal(isLoopWakeup("[7 prior /loop wakeups found nothing actionable; loop is healthy.]"), true);
  assert.equal(isLoopWakeup("auto merge on?"), false);
});

test("the newest pass is quoted by its open lead-ins, not only its opening", () => {
  const dir = mkdtempSync(join(tmpdir(), "pass-"));
  const p = join(dir, "CONTINUE.md");
  writeFileSync(p, "## 2026-09-13 — old\n\nold text\n\n## 2026-09-18 — train\n\n**On master, not pushed.** Three follow-ups.\n\n**Where the UI lives:** elsewhere.\n\n**Still In Progress on the board:** #1190–#1195, a human runs workspace merge.\n");
  const h = newestPassHead(p);
  assert.equal(h.date, "2026-09-18");
  assert.match(h.text, /Still In Progress/);
  assert.ok(!/Where the UI lives/.test(h.text));
});
