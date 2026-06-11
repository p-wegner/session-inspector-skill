# Tokenizer landscape (2026) — bundled-counter decision

> **STATUS: PENDING.** This file is the landing zone for the ChatGPT deep-research
> pass on current token-counting tooling. The skill's counter interface is final;
> this doc decides *which concrete tokenizer* each `src/counters/*` file uses.
> Fill in the verified findings + the chosen stack, then implement
> `claude-counter.js` / `gemini-counter.js` accordingly and flip their `ENABLED`.

## Decisions to record (from research)
- [ ] **Claude (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 / Fable 5)** — is there a public
      local tokenizer? Tokenizer family? Use `count_tokens` API for `--exact`?
      Local estimate = o200k_base × calibration factor? Record the factor + drift.
- [ ] **OpenAI (GPT-5.4 / 5.5)** — does `gpt-tokenizer` / tiktoken o200k_base still
      cover them in 2026, or is there a newer encoding? Confirm offline JS path.
- [ ] **Gemini** — countTokens API vs a local SentencePiece option.
- [ ] **`simonw/ttok`** — still maintained in 2026? Keep as inspiration or replace?
- [ ] **Cross-model single estimator** — how far does o200k_base drift from each
      family's real count (record %)? Is one shared offline tokenizer good enough
      for *relative* comparison (the skill's actual need)?
- [ ] **Chosen portable stack** — the concrete deps to `npm install` (or bundle),
      and the fallback chain.

## Current scaffold assumptions (to confirm/replace)
- OpenAI/shared estimate: `gpt-tokenizer` → `o200k_base` (pure JS, offline). ✅ usable now.
- Claude: heuristic estimate (chars/token ≈ 3.6) until a local/API counter lands.
- Gemini: heuristic estimate until decided.
- Universal fallback: `heuristic-counter.js` (no deps).

## Why offline-first
The skill scans whole codebases/docs repeatedly while iterating on a rewrite —
a per-file network round-trip would be slow, rate-limited, and may cost money.
Exact (API) counting is opt-in via `--exact` for billing-grade Claude numbers.
