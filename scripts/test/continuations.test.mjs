/**
 * node --test scripts/test/continuations.test.mjs
 *
 * The three libs behind `continuations.mjs`, and the two judgement calls in them
 * that are easy to get subtly wrong:
 *
 *   1. What counts as an OPEN item. A `CONTINUE.md` is mostly struck-through
 *      history; reading a done item as open re-proposes finished work, which is
 *      the failure mode that makes such a tool untrustworthy.
 *   2. What counts as a session having been CONTINUED. A weak signal here is
 *      worse than none: it HIDES real cut-off work. Regression-guarded below —
 *      a session that merely enumerates many ids (a fleet-tool run) must never
 *      be read as having continued them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseContinueDoc, readRepoDocs, gitState } from "../lib/repo.mjs";
import { findSuccessors, strongLinks, successorLabel } from "../lib/successor.mjs";
import { classifyProvenance, isAgentWorkspace } from "../lib/provenance.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "cont-test-"));

// ── CONTINUE.md parsing ─────────────────────────────────────────────────────
test("open vs done: checkboxes, strikethrough, and Done-headed steps", () => {
  const dir = tmp();
  writeFileSync(join(dir, "CONTINUE.md"), [
    "# CONTINUE",
    "",
    "## Next steps",
    "",
    "1. ~~Repair the venv.~~ Done 2026-08-20 — reinstalled.",
    "2. **Run the three blocks against a real Symfony target.**",
    "3. Done 2026-08-21 — landed as `abc123`.",
    "",
    "## Next steps continued",
    "",
    "- [x] Suite verified green",
    "- [ ] Decide whether to push master",
    "- [ ] `pnpm install` so coverage can run",
    "",
    "## Blocked / open questions",
    "",
    "- Waiting on someone else's account access",
    "- [ ] Confirm half B on live data",
    "",
    "## Tried and rejected",
    "",
    "```",
    "1. this is inside a fence and must not parse",
    "```",
  ].join("\n"));

  const d = parseContinueDoc(join(dir, "CONTINUE.md"));
  const texts = d.open.map((i) => i.text);
  assert.ok(texts.some((t) => t.includes("real Symfony target")), "a live numbered step is open");
  assert.ok(texts.some((t) => t.includes("push master")), "an unchecked box is open");
  assert.equal(texts.filter((t) => t.includes("venv")).length, 0, "struck-through step is not open");
  assert.equal(texts.filter((t) => t.startsWith("Done")).length, 0, "a Done-headed step is not open");
  assert.equal(texts.filter((t) => t.includes("inside a fence")).length, 0, "fenced content is not parsed");
  assert.ok(d.done.some((i) => i.text.includes("Suite verified green")), "checked box is done");

  // Blocked items are reported separately — they are not work you can start.
  const blockedTexts = d.blocked.map((i) => i.text);
  assert.ok(blockedTexts.some((t) => t.includes("account access")));
  assert.ok(blockedTexts.some((t) => t.includes("half B")), "an unchecked box under Blocked is blocked, not open");
  assert.equal(d.open.filter((i) => i.text.includes("half B")).length, 0);
});

test("a missing CONTINUE.md is reported, not thrown", () => {
  const d = parseContinueDoc(join(tmp(), "CONTINUE.md"));
  assert.equal(d.exists, false);
  assert.deepEqual(d.open, []);
});

test("readRepoDocs orders CONTINUE before BACKLOG and flags the local layer", () => {
  const dir = tmp();
  writeFileSync(join(dir, "CONTINUE.md"), "## Next steps\n\n- [ ] in flight\n");
  writeFileSync(join(dir, "BACKLOG.md"), "## Next\n\n- [ ] candidate\n");
  writeFileSync(join(dir, "CONTINUE.local.md"), "## Next steps\n\n- [ ] machine-specific\n");
  const docs = readRepoDocs(dir);
  assert.equal(docs.hasLocal, true);
  assert.deepEqual(docs.open.map((i) => i.doc),
    ["CONTINUE.md", "CONTINUE.local.md", "BACKLOG.md"]);
});

test("gitState on a non-repo reports exists:false rather than a clean tree", () => {
  const g = gitState(tmp());
  assert.equal(g.exists, false);
  // The distinction matters: "clean" is a claim, "unknown" is the truth here.
  assert.equal(g.branch, "");
});

// ── successor detection ─────────────────────────────────────────────────────
const rec = (id, path, mtime) => ({ sessionId: id, path, kind: "main", mtime: new Date(mtime) });
const CAND = "aaaa1111-2222-3333-4444-555566667777";
const DIR = "C:\\Users\\x\\.claude\\projects\\C--repo";

test("a same-repo id mention is a WEAK link and cannot hide the session", () => {
  const cands = [{ sessionId: CAND, path: `${DIR}\\${CAND}.jsonl`, endTime: "2026-08-20T10:00:00Z" }];
  const later = rec("bbbb1111-2222-3333-4444-555566667777", `${DIR}\\later.jsonl`, "2026-08-21T10:00:00Z");
  const links = findSuccessors(cands, [later], {
    readFile: () => "we salvaged aaaa1111 and committed its work",
  }).get(CAND);

  assert.equal(links.length, 1);
  assert.equal(links[0].via, "mention");
  assert.equal(strongLinks(links).length, 0, "a mention must never count as strong");
  assert.match(successorLabel(links), /heuristic/);
});

test("a session mentioning MANY candidates is analysis, not continuation", () => {
  // The measured false positive: one fleet-tool run matched every candidate's
  // short id and appeared to have continued all of them.
  const ids = ["aaaa1111", "bbbb2222", "cccc3333", "dddd4444"].map((p) => `${p}-0000-0000-0000-000000000000`);
  const cands = ids.map((id) => ({ sessionId: id, path: `${DIR}\\${id}.jsonl`, endTime: "2026-08-20T10:00:00Z" }));
  const analyst = rec("eeee5555-0000-0000-0000-000000000000", `${DIR}\\analyst.jsonl`, "2026-08-21T10:00:00Z");
  const out = findSuccessors(cands, [analyst], {
    readFile: () => ids.map((i) => i.slice(0, 8)).join(" "),
  });
  for (const id of ids) {
    assert.deepEqual(out.get(id), [], `${id} must not be marked continued by an analysis run`);
  }
  assert.ok(out.analysts.includes("eeee5555-0000-0000-0000-000000000000"));
});

test("a candidate is never its own successor", () => {
  const cands = [{ sessionId: CAND, path: `${DIR}\\${CAND}.jsonl`, endTime: "2026-08-20T10:00:00Z" }];
  const self = rec(CAND, `${DIR}\\${CAND}.jsonl`, "2026-08-21T10:00:00Z");
  assert.deepEqual(findSuccessors(cands, [self], { readFile: () => "aaaa1111" }).get(CAND), []);
});

test("a mention in a DIFFERENT project dir does not count", () => {
  const cands = [{ sessionId: CAND, path: `${DIR}\\${CAND}.jsonl`, endTime: "2026-08-20T10:00:00Z" }];
  const elsewhere = rec("bbbb1111-2222-3333-4444-555566667777",
    "C:\\Users\\x\\.claude\\projects\\C--other\\s.jsonl", "2026-08-21T10:00:00Z");
  assert.deepEqual(findSuccessors(cands, [elsewhere], { readFile: () => "aaaa1111" }).get(CAND), []);
});

// ── provenance ──────────────────────────────────────────────────────────────
const transcript = (...texts) => texts
  .map((t) => JSON.stringify({ type: "user", message: { content: t }, timestamp: "2026-08-20T10:00:00Z" }))
  .join("\n");

test("board-launched sessions are not human-driven", () => {
  const p = classifyProvenance(transcript("You are an AI code reviewer. Review branch 'feature/x'."));
  assert.equal(p.kind, "board");
  assert.equal(p.humanDriven, false);
});

test("a worktree cwd alone marks an agent workspace", () => {
  assert.equal(isAgentWorkspace("C:\\projects\\andrena\\.worktrees\\ak-690"), true);
  assert.equal(isAgentWorkspace("C:\\projects\\andrena\\acp"), false);
  const p = classifyProvenance(transcript("fix the flaky test"), "C:\\projects\\x\\.worktrees\\ak-1");
  assert.equal(p.humanDriven, false);
});

test("a handoff-seeded session becomes human-driven once a person types", () => {
  const seeded = classifyProvenance(transcript("You are TAKING OVER work from another Claude session. Read the handoff brief at C:\\x.md"));
  assert.equal(seeded.kind, "handoff");
  assert.equal(seeded.humanDriven, false, "the seed alone is not a human steering it");

  const steered = classifyProvenance(transcript(
    "You are TAKING OVER work from another Claude session. Read the handoff brief at C:\\x.md",
    "push and update the changelog",
  ));
  assert.equal(steered.humanDriven, true);
  assert.equal(steered.lastHuman, "push and update the changelog");
});

test("a slash/skill invocation counts as human-driven", () => {
  const p = classifyProvenance(transcript("Base directory for this skill: C:\\x\\skills\\session-inspector"));
  assert.equal(p.kind, "skill");
  assert.equal(p.humanDriven, true);
});
