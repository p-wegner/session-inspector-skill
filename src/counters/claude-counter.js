'use strict';
/*
 * Claude-family counter. STUB pending references/tokenizers.md.
 *
 * Two intended modes (final approach TBD by the deep-research pass):
 *   - estimate: a local approximation (likely o200k_base + a calibration factor,
 *     or a bundled Claude vocab if a public one exists).
 *   - exact:    Anthropic Messages `count_tokens` API (needs ANTHROPIC_API_KEY,
 *     one network call, no token generation cost). Used only with --exact.
 *
 * Until finalized, this module intentionally does NOT export a working counter
 * so index.js degrades to the heuristic. Flip ENABLED to true once implemented.
 */

const ENABLED = false;

async function exactViaApi(text, model = 'claude-opus-4-8') {
  // Lazy placeholder. Real impl:
  //   const Anthropic = require('@anthropic-ai/sdk');
  //   const client = new Anthropic();
  //   const r = await client.messages.countTokens({ model, messages:[{role:'user', content:text}] });
  //   return r.input_tokens;
  throw new Error('claude exact counter not implemented yet — see references/tokenizers.md');
}

module.exports = ENABLED
  ? {
      name: 'claude',
      exact: true,
      count() { throw new Error('wire up exactViaApi / local estimate'); },
      exactViaApi,
    }
  : undefined; // registry treats undefined as "not available" → heuristic fallback
