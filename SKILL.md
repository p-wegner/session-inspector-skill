---
name: token-budget
description: Count and analyze LLM token usage across files, codebases, docs, and agent skills — then optimize prose to cut redundant/noisy tokens without losing performance. Use when the user wants to "count tokens", "how many tokens is this", "measure context size", "find the biggest token consumers", "shrink/optimize a prompt/skill/doc", "reduce token count", or audit a CLAUDE.md / skill / docs folder for bloat.
---

# token-budget

Portable, offline-first token counting + prose-optimization for SOTA LLMs
(Claude Opus 4.8 / Sonnet 4.6, GPT-5.x, Gemini). Bundles a self-contained
tokenizer so it works with no per-call network round-trip.

## When to use
- "How many tokens is this file / folder / string?"
- "Which files in this repo eat the most context?"
- "Audit this CLAUDE.md / skill / docs dir and tell me where the bloat is."
- "Shrink this prompt/skill/doc without losing meaning."

## Quick start
```bash
# one-time
cd <skill-dir> && npm install

# count a string or file
node bin/tokt.js count "some text"
node bin/tokt.js count --file path/to/doc.md

# scan a tree → ranked per-file token table + total
node bin/tokt.js scan ./docs --model opus-4.8
node bin/tokt.js scan . --glob "**/*.md" --top 20

# analyze a SKILL/agent dir the way agents pay for it (progressive disclosure)
node bin/tokt.js skill path/to/skill-dir

# optimization report: flags redundancy, filler, restating, dead sections
node bin/tokt.js audit path/to/SKILL.md
```

## Model selection
One shared **offline normalizer — `o200k_base`** (via `gpt-tokenizer`) is the
local metric for every family. It's *exact* for OpenAI and a good *relative*
proxy for Claude/Gemini, which have **no portable local tokenizer** (see
`references/tokenizers.md`). `--model` mainly changes which caveat/exact path applies:
- `gpt-5.5`, `gpt-5.4` → o200k_base, **exact** offline for OpenAI.
- `opus-4.8`, `sonnet-4.6`, `haiku-4.5`, `fable-5` → o200k_base estimate; Claude
  has no public local tokenizer. Keep ~15–20% headroom near a hard limit.
- `gemini` → o200k_base estimate (Gemini's local tokenizer is Python-only).
- `heuristic` → no-dependency chars/token estimate (used automatically if
  `gpt-tokenizer` isn't installed).

Counting is **relative by design** — ideal for ranking the biggest consumers and
measuring before/after a rewrite. For billing-grade exact counts, add `--exact`
(only on `count`): Claude → `count_tokens` API (`ANTHROPIC_API_KEY`), Gemini →
`countTokens` API (`GEMINI_API_KEY`). Without a key it degrades to the estimate.

## Analyzing skills (progressive disclosure)
Agents don't pay for a skill's files equally — `tokt skill <dir>` models the real
tiers instead of a flat sum:
- **Tier 0 — always-on:** the frontmatter `name` + `description`. Injected into
  the system prompt **every turn of every session**, for every registered skill.
  Highest leverage — a token here is paid thousands of times. Keep `description`
  tight (aim <~100 tokens).
- **Tier 1 — on-invoke:** the `SKILL.md` body. Loaded once when the skill triggers.
- **Tier 2 — on-demand:** reference docs the agent reads **only when SKILL.md (or
  another reachable doc) points at them**. Reachability is transitive.
- **Not context:** code/assets (executed, never read into the window) and
  **orphan docs** — reference files no SKILL.md path reaches, so an agent never
  discovers them. Either link them or delete them. (README/LICENSE are recognized
  as human-facing, not flagged.)

When optimizing a skill, cut Tier 0 first (every-turn cost), then Tier 1, and
move rarely-needed detail from Tier 1 down into a Tier 2 reference doc.

## Optimization workflow (the point of the skill)
When asked to shrink a doc/skill without losing performance:
1. `scan` / `audit` to get a baseline count + ranked hotspots.
2. Apply the reductions in `references/optimization-guide.md` (cut restating,
   redundant examples, filler, hedging; tighten tables; dedupe).
3. Re-`count` to report the delta (tokens saved, % reduction).
4. Preserve every load-bearing instruction — never trade tokens for behavior.
   Report what was cut and confirm semantics are intact.

## Architecture
- `bin/tokt.js` — CLI (count / scan / audit).
- `src/counters/` — pluggable counters; `index.js` resolves model → counter
  over the shared o200k_base normalizer. Each exposes `count(text) -> number`
  (+ optional async `exact`). Add a model family = add one file.
- `src/scan.js` — walk a path/glob, count per file, aggregate, rank.
- `src/skill.js` — parse a skill's frontmatter, tier its files by progressive
  disclosure, resolve transitive doc reachability.
- `src/report.js` — formatting (tables, tier breakdown, deltas, audit findings).
- `references/` — tokenizer landscape + optimization guidance (read before
  recommending a tokenizer or doing a rewrite).

> Tokenizer choices are settled (June 2026 research) in `references/tokenizers.md`:
> o200k_base as the shared offline normalizer; Claude/Gemini exact via their
> count APIs (`--exact`). Read it before swapping a tokenizer.
