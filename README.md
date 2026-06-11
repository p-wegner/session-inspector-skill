# token-budget

Portable, offline-first **LLM token counting + prose optimization** for
codebases, docs, and agent skills. Packaged as a reusable Claude/Codex agent
skill (see `SKILL.md`) and usable directly as a CLI (`tokt`).

The point: measure how many tokens a file / folder / prompt costs across SOTA
models (Claude Opus 4.8 / Sonnet 4.6, GPT-5.x, Gemini), find the biggest
consumers, and shrink docs/skills without losing performance.

## Install
```bash
cd token-budget
npm install        # pulls gpt-tokenizer (pure-JS, offline o200k_base)
```

## Use
```bash
node bin/tokt.js count "hello world"
node bin/tokt.js count --file SKILL.md --model opus-4.8
node bin/tokt.js scan ./docs --glob "**/*.md" --top 20
node bin/tokt.js audit path/to/CLAUDE.md
```

Add `--json` for machine-readable output, `--model` to pick a family,
`--exact` for billing-grade Claude counts via the API (needs `ANTHROPIC_API_KEY`).

## Design
- **Pluggable counters** (`src/counters/`): one file per model family, resolved
  by `index.js`. Missing optional deps degrade gracefully to a no-dependency
  heuristic — the tool never hard-fails on a tokenizer that isn't installed.
- **Offline-first:** scanning a tree repeatedly during a rewrite shouldn't make
  network calls. Exact API counting is opt-in.
- The concrete bundled tokenizer per family is being finalized — see
  `references/tokenizers.md`.

## Layout
```
SKILL.md                     agent-facing instructions (name + description frontmatter)
bin/tokt.js                  CLI: count | scan | audit
src/counters/                pluggable counters (heuristic, tiktoken, claude, gemini)
src/scan.js                  tree walk + per-file aggregation
src/audit.js                 static bloat finder
src/report.js                tables / deltas
references/tokenizers.md     tokenizer landscape + bundled-counter decision (research)
references/optimization-guide.md   how to cut tokens without losing behavior
```

## Status
Working. Shared offline normalizer is **o200k_base** (`gpt-tokenizer`) — exact
for OpenAI, a relative proxy for Claude/Gemini (which have no portable local
tokenizer). Optional `--exact` hits the Claude `count_tokens` / Gemini
`countTokens` APIs. Tokenizer rationale: `references/tokenizers.md`.
