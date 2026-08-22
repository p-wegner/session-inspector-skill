/**
 * node --test scripts/test/locator.test.mjs
 *
 * Locator parsing. The subtle part is that these forms accumulated over time and
 * all of them are pasted by hand, so a new form must not silently change what an
 * old one means. The status line now shows the registered ACP agent name
 * ("<project-slug>--<sid8>") in place of its own "<sid8>/<folder>" locator, so
 * that shape has to resolve too — as a FALLBACK, never as a reinterpretation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLocator, splitAcpAgentName, locatorCandidates } from "../lib/sessions.mjs";

const UUID = "869f8e8a-de60-4026-9f85-85414d54e0fb";
const FOLDER = "C--projects-andrena-acp";

// ── the primary parse must not budge ────────────────────────────────────────
// Every one of these worked before ACP names existed; the id half is the FULL
// uuid wherever it comes from the on-disk layout, because that is the filename.
const UNCHANGED = [
  ["bare full uuid", UUID, { idPart: UUID, dirPart: null }],
  ["folder/full-uuid (on-disk layout)", `${FOLDER}/${UUID}`, { idPart: UUID, dirPart: FOLDER }],
  ["folder/full-uuid.jsonl", `${FOLDER}/${UUID}.jsonl`, { idPart: UUID, dirPart: FOLDER }],
  ["sid8/folder (older status line)", "869f8e8a/andrena-acp", { idPart: "869f8e8a", dirPart: "andrena-acp" }],
  ["full path", `C:/Users/x/.claude/projects/${FOLDER}/${UUID}.jsonl`, { idPart: UUID, dirPart: FOLDER }],
  // A naive folder name on its own stays a folder name: doubled dashes and
  // non-hex letters are exactly what disqualifies it from being an id.
  ["naive folder name alone", FOLDER, { idPart: FOLDER, dirPart: null }],
  ["trimmed folder name alone", "andrena-acp", { idPart: "andrena-acp", dirPart: null }],
];

for (const [label, locator, want] of UNCHANGED) {
  test(`splitLocator unchanged: ${label}`, () => {
    assert.deepEqual(splitLocator(locator), want);
  });
  test(`first candidate is still the primary parse: ${label}`, () => {
    assert.deepEqual(locatorCandidates(locator)[0], want);
  });
}

// ── the ACP agent name ─────────────────────────────────────────────────────
test("ACP agent name splits at the doubled dash", () => {
  assert.deepEqual(splitAcpAgentName(`${FOLDER}--869f8e8a`), { idPart: "869f8e8a", dirPart: FOLDER });
});

test("ACP agent name is offered as a fallback, after the primary parse", () => {
  const c = locatorCandidates(`${FOLDER}--869f8e8a`);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { idPart: `${FOLDER}--869f8e8a`, dirPart: null }); // primary, untouched
  assert.deepEqual(c[1], { idPart: "869f8e8a", dirPart: FOLDER });          // the rescue
});

test("a slug ending in a separator still splits on the LAST doubled dash", () => {
  // cwd "C:\projects\acp\\" slugs to "C--projects-acp-", so the join reads "---".
  assert.deepEqual(splitAcpAgentName("C--projects-acp---869f8e8a"),
    { idPart: "869f8e8a", dirPart: "C--projects-acp-" });
});

// ── what must NOT be treated as an ACP name ────────────────────────────────
for (const [label, input] of [
  ["a bare full uuid", UUID],
  ["a short id stub", "869f8e8a"],
  ["a naive folder name", FOLDER],
  ["a trimmed folder name", "andrena-acp"],
  ["no doubled dash at all", "andrena-acp-869f8e8a"],
  ["nothing after the dashes", "C--projects-acp--"],
  ["a non-hex tail", `${FOLDER}--zzzzzzzz`],
]) {
  test(`declined as an ACP name: ${label}`, () => {
    assert.equal(splitAcpAgentName(input), null);
  });
  test(`no extra candidate for: ${label}`, () => {
    assert.equal(locatorCandidates(input).length, 1);
  });
}
