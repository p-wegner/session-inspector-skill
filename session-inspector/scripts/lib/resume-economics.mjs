/**
 * RESUME OR HAND OFF? — the decision every "continue that cut-off session" tool
 * has to make, and which this skill used to answer wrongly by default.
 *
 * `claude --resume <id>` reloads the whole final context of a session. Two things
 * make that a bad default precisely in the case these tools were built for:
 *
 *   1. **It cannot cross profiles.** The session lives under one
 *      `~/.claude[-suffix]` home and `--resume` resolves against
 *      CLAUDE_CONFIG_DIR, so the work is pinned to that account. But the reason
 *      a session was cut off is usually that *that* account hit its limit — so
 *      the one profile you cannot use is the only one resume can use.
 *   2. **The cache is cold by then.** Claude Code's prompt cache has a 1-hour
 *      TTL. While warm, every turn re-reads the context at 0.1x base input; past
 *      the TTL the next turn must re-WRITE the whole prefix at 2x. That is a 20x
 *      swing on the first turn, paid before any new work happens — and you come
 *      back to a rate-limited session hours later by definition.
 *
 * Measured on this box's five real cut-off sessions (peak context 103k–295k):
 * resuming them cold costs **$11.24 before a single new token of work** against
 * $0.56 warm — a 20x multiplier, and the largest single one is $2.95. A handoff
 * brief is 2–5k tokens: cents. (Priced with this repo's own PRICING table, so the
 * figures reconcile with token-sinks.mjs and quota-report.mjs. Note one of the
 * five is Fable at $10/Mtok, which is why its 146k context costs nearly as much
 * as another's 295k — pricing per model matters here, and a `<synthetic>` model
 * tag on the limit banner used to hide it.)
 *
 * So the default recommendation is a HANDOFF — a fresh session, on any account
 * with headroom, seeded with a written brief. Resume stays available for the
 * narrow case where it genuinely wins: same profile, still-warm cache, small
 * context.
 *
 * Node builtins only.
 */
import { priceFor } from "./quota.mjs";

/** Claude Code's ephemeral prompt-cache TTL, in minutes. */
export const CACHE_TTL_MIN = 60;
/** 1h cache WRITE = 2x base input; cache READ = 0.1x. */
export const WRITE_1H = 2.0, READ = 0.1;

/** Context small enough that a cold refill is not worth avoiding (tokens). */
export const SMALL_CTX = 50_000;

/**
 * What the FIRST turn of a resume costs, before any new work.
 * @returns {{cold, warm, ratio}} USD
 */
export function refillCost(contextTokens, model) {
  const base = priceFor(model).in / 1e6;
  const cold = (contextTokens || 0) * base * WRITE_1H;
  const warm = (contextTokens || 0) * base * READ;
  return { cold, warm, ratio: warm > 0 ? cold / warm : 0 };
}

/**
 * Resume, or hand off?
 *
 * @param o.idleMin              minutes since the session's last activity
 * @param o.contextTokens        its peak/final context
 * @param o.model                for pricing
 * @param o.sessionProfile       the profile home the transcript lives under
 * @param o.targetProfile        the profile you intend to run on ("" = same)
 * @param o.sessionProfileUsable false when that account is out of quota
 * @returns {{mode, why:[], cost, crossProfile}}  mode: "resume" | "handoff"
 */
export function recommendMode(o = {}) {
  const {
    idleMin = Infinity, contextTokens = 0, model = "",
    sessionProfile = "", targetProfile = "", sessionProfileUsable = true,
  } = o;

  const cost = refillCost(contextTokens, model);
  const norm = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  const crossProfile = Boolean(targetProfile) && norm(targetProfile) !== norm(sessionProfile);

  const why = [];

  // Hard constraint first: this is not a preference, resume simply cannot do it.
  if (crossProfile) {
    why.push(`resume CANNOT cross profiles — the session lives under ${sessionProfile || "another home"}, so it is unreachable from the target account`);
    return { mode: "handoff", why, cost, crossProfile, priced: true };
  }
  if (!sessionProfileUsable) {
    why.push("the session's own account has no headroom, and that is the only account resume can use");
    return { mode: "handoff", why, cost, crossProfile, priced: true };
  }

  const warm = idleMin <= CACHE_TTL_MIN;
  const small = contextTokens > 0 && contextTokens <= SMALL_CTX;

  // No per-turn usage data (an old or stub transcript) means the refill cannot be
  // priced. Say so and let the caller fall back to its own size heuristic —
  // presenting a $0.00 estimate as a reason would be worse than admitting it.
  if (!contextTokens) {
    why.push(`context size unknown (no per-turn usage in the transcript) — cannot price the refill; ${warm ? "cache is still warm though" : `cache expired ${Math.round(idleMin)}m ago`}`);
    return { mode: warm ? "resume" : "handoff", why, cost, crossProfile, priced: false };
  }

  if (warm) {
    why.push(`cache is still warm (idle ${Math.round(idleMin)}m < ${CACHE_TTL_MIN}m TTL) — the context re-reads at 0.1x instead of being re-written at 2x`);
    return { mode: "resume", why, cost, crossProfile, priced: true };
  }
  if (small) {
    why.push(`context is small (${Math.round(contextTokens / 1000)}k), so the cold refill is only ~$${cost.cold.toFixed(2)}`);
    return { mode: "resume", why, cost, crossProfile, priced: true };
  }

  why.push(`cache expired ${Math.round(idleMin)}m ago (TTL ${CACHE_TTL_MIN}m), so resuming re-writes the whole ${Math.round(contextTokens / 1000)}k context at 2x: ~$${cost.cold.toFixed(2)} before any new work (~${Math.round(cost.ratio)}x the warm cost)`);
  why.push("a brief carries the same state in 2–5k tokens, and can run on any account with headroom");
  return { mode: "handoff", why, cost, crossProfile, priced: true };
}

/** One-line label for a recommendation. */
export function modeLabel(rec) {
  return rec.mode === "resume" ? "▶ RESUME (cheap here)" : "⇥ HAND OFF (resume is the expensive option)";
}
