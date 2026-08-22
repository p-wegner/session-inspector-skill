/**
 * node --test scripts/test/resume-economics.test.mjs
 *
 * RESUME OR HAND OFF. This encodes a correction: the tools here used to treat
 * `--resume` as the default way to continue a cut-off session, and that is wrong
 * in exactly the case they were built for. Two independent reasons, and the tests
 * below pin both so the default cannot quietly flip back:
 *
 *   - resume cannot cross profiles, and a rate-limited session's own account is
 *     the one with no quota left;
 *   - past the 1h cache TTL the first turn re-writes the whole context at 2x
 *     instead of reading it at 0.1x — a 20x multiplier, paid before any work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendMode, refillCost, CACHE_TTL_MIN, SMALL_CTX } from "../lib/resume-economics.mjs";

const HOME_A = "C:\\Users\\x\\.claude-team_a";
const HOME_B = "C:\\Users\\x\\.claude-team_b";

test("the cold/warm multiplier is 20x, whatever the model", () => {
  for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", ""]) {
    const c = refillCost(200_000, model);
    assert.equal(Math.round(c.ratio), 20, `${model || "(default)"} should be 20x`);
    assert.ok(c.cold > c.warm);
  }
});

test("model pricing is not flat — a Fable context costs more than an Opus one", () => {
  // Real case from the fleet: a 146k Fable session's cold refill nearly equals a
  // 295k Opus one. Pricing per model is load-bearing, not decoration.
  const fable = refillCost(146_000, "claude-fable-5").cold;
  const opus = refillCost(295_000, "claude-opus-5").cold;
  assert.ok(fable > opus * 0.9, `fable 146k (${fable}) should rival opus 295k (${opus})`);
});

test("crossing profiles makes resume impossible, not merely expensive", () => {
  const r = recommendMode({
    idleMin: 5, contextTokens: 10_000, model: "claude-opus-5",
    sessionProfile: HOME_A, targetProfile: HOME_B,
  });
  assert.equal(r.mode, "handoff");
  assert.equal(r.crossProfile, true);
  assert.match(r.why[0], /CANNOT cross profiles/);
  // Note this beats BOTH of the cheap-resume conditions (warm cache, tiny
  // context) — it is a hard constraint, so it must be checked first.
});

test("the session's own account being out of quota forces a handoff", () => {
  const r = recommendMode({
    idleMin: 1, contextTokens: 1_000, model: "claude-opus-5",
    sessionProfile: HOME_A, sessionProfileUsable: false,
  });
  assert.equal(r.mode, "handoff");
  assert.match(r.why[0], /only account resume can use/);
});

test("a warm cache is the case where resume genuinely wins", () => {
  const r = recommendMode({
    idleMin: CACHE_TTL_MIN - 1, contextTokens: 300_000, model: "claude-opus-5",
    sessionProfile: HOME_A,
  });
  assert.equal(r.mode, "resume");
  assert.match(r.why[0], /still warm/);
});

test("past the TTL a large context hands off, and the reason is priced", () => {
  const r = recommendMode({
    idleMin: CACHE_TTL_MIN + 1, contextTokens: 295_000, model: "claude-opus-5",
    sessionProfile: HOME_A,
  });
  assert.equal(r.mode, "handoff");
  assert.match(r.why[0], /re-writes the whole 295k context at 2x/);
  assert.match(r.why[0], /\$\d+\.\d\d/, "the reason must carry the actual number");
  assert.ok(r.cost.cold > 2, "295k on opus is dollars, not cents");
});

test("a small context resumes even cold — the refill is not worth avoiding", () => {
  const r = recommendMode({
    idleMin: 10_000, contextTokens: SMALL_CTX - 1, model: "claude-opus-5",
    sessionProfile: HOME_A,
  });
  assert.equal(r.mode, "resume");
  assert.match(r.why[0], /context is small/);
});

test("an unpriceable transcript says so instead of implying $0.00", () => {
  const r = recommendMode({ idleMin: 10_000, contextTokens: 0, sessionProfile: HOME_A });
  assert.equal(r.priced, false);
  assert.match(r.why[0], /context size unknown/);
  // Callers use `priced` to fall back to their own heuristic rather than trusting
  // a recommendation derived from a missing number.
  const warmUnpriced = recommendMode({ idleMin: 5, contextTokens: 0, sessionProfile: HOME_A });
  assert.equal(warmUnpriced.priced, false);
  assert.equal(warmUnpriced.mode, "resume");
});

test("every recommendation carries a priced flag and a reason", () => {
  const cases = [
    { idleMin: 5, contextTokens: 1000 },
    { idleMin: 5000, contextTokens: 500_000 },
    { idleMin: 5, contextTokens: 0 },
    { idleMin: 5, contextTokens: 1000, targetProfile: HOME_B, sessionProfile: HOME_A },
  ];
  for (const c of cases) {
    const r = recommendMode({ sessionProfile: HOME_A, ...c });
    assert.ok(typeof r.priced === "boolean", "priced must always be set");
    assert.ok(r.why.length > 0 && r.why[0].length > 10, "a recommendation without a reason is not usable");
    assert.ok(["resume", "handoff"].includes(r.mode));
  }
});
