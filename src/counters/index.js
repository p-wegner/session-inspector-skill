'use strict';
/*
 * Counter registry. A counter is `{ count(text) -> number, name, exact }`.
 *
 * resolveCounter(model, { exact }) returns the best available counter for a
 * model family, degrading gracefully to the dependency-free heuristic if a
 * concrete tokenizer (or its npm dep) isn't installed.
 *
 * The CLI only ever talks to this module — adding a model family means adding
 * one file here, not touching bin/tokt.js.
 */

const heuristic = require('./heuristic-counter');

// model alias -> family key
const FAMILY = {
  'opus-4.8': 'claude', 'sonnet-4.6': 'claude', 'haiku-4.5': 'claude',
  'fable-5': 'claude', 'claude': 'claude',
  'gpt-5.5': 'openai', 'gpt-5.4': 'openai', 'gpt': 'openai', 'openai': 'openai',
  'gemini': 'gemini',
  'heuristic': 'heuristic',
};

function familyOf(model) {
  if (!model) return 'openai'; // sensible default: o200k_base ~ closest shared estimate
  return FAMILY[String(model).toLowerCase()] || 'heuristic';
}

// lazy so a missing optional dep never crashes an unrelated model
function tryLoad(path) {
  try { return require(path); } catch { return null; }
}

function resolveCounter(model, opts = {}) {
  const family = familyOf(model);

  if (family === 'openai') {
    const c = tryLoad('./tiktoken-counter');
    if (c) return c;
  }
  if (family === 'claude') {
    const c = tryLoad('./claude-counter');
    if (c && (!opts.exact || c.exact)) return c;
    // fall through to estimate if exact requested but unavailable
  }
  if (family === 'gemini') {
    const c = tryLoad('./gemini-counter');
    if (c) return c;
  }
  return heuristic.forFamily(family);
}

module.exports = { resolveCounter, familyOf, FAMILY };
