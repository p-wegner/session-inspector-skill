'use strict';
/*
 * Per-model price table (USD per 1M tokens), for ESTIMATING cost from a raw
 * transcript — which records tokens but not dollars. The `claude -p
 * --output-format json` envelope already carries Anthropic-computed
 * `costUSD`/`total_cost_usd`; prefer that (see claude-run.js). This table is a
 * fallback for `tokt session` on transcripts that were never captured with
 * --output-format json (e.g. interactive sessions).
 *
 * Rates sourced from the claude-api skill, re-verified 2026-09-08 against its
 * model table + shared/models.md + shared/prompt-caching.md (skill cache date
 * 2026-06-24). Cache reads bill at ~0.1x input (0.025x on Fable/Mythos 5.1);
 * cache writes at 1.25x (5m TTL) or 2x (1h TTL).
 *
 * Notes that cost real debugging time at least once:
 *  - A 1M-context model is NOT a premium tier. Opus 5's 1M window is its default
 *    and maximum at standard pricing, so a `claude-opus-5[1m]`-style id needs no
 *    separate rate — matching on `opus-5` is correct and complete.
 *  - Fast mode IS a premium tier: Opus 5 / Opus 4.8 at `speed: "fast"` bill
 *    $10/$50 instead of $5/$25. The transcript records it as `usage.speed`, so
 *    ignoring it silently halves the estimate for any /fast session.
 *  - Sonnet 5 is $2/$10, NOT the $3/$15 it shared with Sonnet 4.6 — those two
 *    must not sit behind one pattern.
 * Update when pricing moves; this is an estimate only.
 */

// [inputPerM, outputPerM] in USD/1M tokens. Cache rates derived from input.
// First match wins, so keep the more specific pattern above the broader one
// (sonnet-5 before sonnet-4 — they price differently).
const RATES = [
  [/fable-5|mythos-5|mythos-preview/, [10, 50]],
  [/opus-5|opus-4/, [5, 25]],
  [/sonnet-5/, [2, 10]],
  [/sonnet-4/, [3, 15]],
  [/haiku-4/, [1, 5]],
  [/haiku-3/, [0.8, 4]],
];

// Fast mode (research preview) is a genuine premium tier, unlike a big context
// window. Only Opus 5 and Opus 4.8 offer it; every other model ignores `speed`.
const FAST_RATES = [
  [/opus-5|opus-4-8/, [10, 50]],
];

const CACHE_READ_MULT = 0.1;
const CACHE_READ_MULT_BY_MODEL = [
  [/fable-5-1|mythos-5-1/, 0.025], // a quarter of the usual rate: $0.25/MTok
];
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

// `speed` comes from the transcript's usage block (usage.speed), so callers that
// already pass the raw usage record get fast-mode pricing for free.
function ratesFor(model, speed) {
  const id = String(model || '').toLowerCase();
  if (speed === 'fast') {
    for (const [re, r] of FAST_RATES) if (re.test(id)) return r;
  }
  for (const [re, r] of RATES) if (re.test(id)) return r;
  return null; // unknown model — caller reports cost as unavailable
}

function cacheReadMultFor(model) {
  const id = String(model || '').toLowerCase();
  for (const [re, m] of CACHE_READ_MULT_BY_MODEL) if (re.test(id)) return m;
  return CACHE_READ_MULT;
}

/*
 * Estimate USD for one usage record. `u` uses raw-transcript field names
 * (input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens, and optional cache_creation.ephemeral_{5m,1h}).
 */
function costForUsage(model, u) {
  const r = ratesFor(model, u.speed);
  if (!r) return null;
  const cacheReadMult = cacheReadMultFor(model);
  const [inPerM, outPerM] = r;
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreate = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens;
  const w1 = cc.ephemeral_1h_input_tokens;
  // Use the 5m/1h split when present; otherwise treat all creation as 5m.
  let writeCost;
  if (w5 != null || w1 != null) {
    writeCost = ((w5 || 0) * CACHE_WRITE_5M_MULT + (w1 || 0) * CACHE_WRITE_1H_MULT) * inPerM / 1e6;
  } else {
    writeCost = cacheCreate * CACHE_WRITE_5M_MULT * inPerM / 1e6;
  }
  return (
    (inTok * inPerM + outTok * outPerM + cacheRead * inPerM * cacheReadMult) / 1e6 +
    writeCost
  );
}

module.exports = { ratesFor, cacheReadMultFor, costForUsage };
