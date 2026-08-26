# Fleet: what did it cost, and what filled the context

_session-inspector reference — token-sinks, waste, context-growth, cold-cache, context-spikes, and the cost-optimization loop that chains them. Commands run from the skill directory (`node scripts/…`); all take `--json`, `--days N`, `--project <substring>`._

**Cost-optimization loop** — these five compose into one workflow: `token-sinks.mjs`
(what did it cost, where) → `context-growth.mjs` (what SHAPE ran it up) → then the
two levers: `cold-cache.mjs` (idle/resume waste — a *timing* fix: keep sessions
warm, `/compact` or finish before a break) and `context-spikes.mjs` + `waste.mjs`
(injection waste — a *representation* fix: ranged reads, quiet flags, log levels,
jq-select at the source). Scope any of them to one repo with `--project <substr>`
or `--cwd` and a `--days` window.

`waste.mjs` answers **"what cost unnecessary tokens?"** — it attributes each
session's content to buckets (tool_result by tool, Write/Edit args, user
prompts/pastes, …) weighted by **persistence** (tokens × turns-survived, because
cost is cache-read dominated — an early dump is re-billed every later turn), then
flags the avoidable waste: **re-reading a file already in context**, repeated
identical Bash output, and **node_modules leaking into Glob/Read**. Companion to
`token-sinks.mjs` (which gives the billing total); this explains what ran it up.
Claude transcripts only; chars/4 token estimate (≈1.5% of exact tiktoken).

`context-growth.mjs` answers **"why did this cost so much?"** — agent cost is
cache-read dominated (every turn re-bills the ENTIRE current context), so a
session's spend is roughly the **area under its context-growth curve**. It reads
per-turn `message.usage` (exact billed tokens, not estimated) and reports:
**auto-compacts** — how many `isCompactSummary` boundaries fired (the safety
valve; few compacts + huge maxCtx means it never tripped, often because the 1M
context window pushed the compact threshold up near the window size); a
**context histogram + percentiles**; the **long-context tax** — the
price-independent share of turns and of cache-read tokens sitting above 200k
(the premium pricing tier); and the **point of no return** — the turn context
first crossed 200k and never came back (everything after is premium-tier).
`--session <id>` focuses one session and prints its sampled growth curve.
Companion to `token-sinks.mjs` (billing total) and `waste.mjs` (what fills the
context) — this explains the SHAPE that multiplies both. Claude only.

`cold-cache.mjs` answers **"what did idle time / resuming cost me?"** — the prompt
cache is ephemeral (Claude Code uses a **1-hour** TTL here; the transcript proves
it via `usage.cache_creation.ephemeral_1h_input_tokens`). While warm, every turn
re-bills the whole context as cache_read at **0.1×** base input; but if a session
sits idle past the TTL and is then continued (or a long session is `--resume`d
after a break), the next turn finds the cache expired and must **re-write the
entire prefix** as cache_creation — billed at **2× base input** for a 1h write.
That one cold turn can cost ~20× a warm turn: a 400k-token Opus context refilled
cold ≈ `400k × $5/M × 2 = $4.00` vs ≈ $0.20 warm. The tool walks per-turn
timestamps, and when the **gap** since the previous turn exceeds the TTL *and* the
turn shows a large `cache_creation`, records a COLD event and quantifies the
**avoidable premium** — the cold re-write cost minus what a warm cache_read would
have cost (`creation_1h × in × (2.0−0.1) + creation_5m × in × (1.25−0.1)`). The
first turn of a session (initial build) is never counted — nothing to keep warm.
It ranks the worst sessions and the worst single refills; `--session <id>` lists
every cold event in one session; `--gap` tunes the idle threshold (default 60m).
This is the avoidable slice that `context-growth.mjs`'s SHAPE makes expensive.
Claude only. Note: its write multipliers (2× for 1h) are more precise than the
flat 1.25× in `token-sinks.mjs`/`quota.mjs`, which assume 5m writes.

`context-spikes.mjs` answers **"which single injection bloated the context, and
WHY — so I can fix the source?"** — most context bloat is one tool_result: a huge
whole-file Read, a verbose command dump, a JSON blob, node_modules noise, a log
wall, a minified one-liner. It finds each large injection (≥`--min` tokens,
default 5k), weights it by **persistence** (tokens × turns-survived — an early
dump is re-billed every later turn), and **classifies the reason** it was
expensive with a concrete fix: `huge-file` (→ read a range / grep first),
`verbose-output` (→ quiet flag / head), `log-wall` (→ raise log level), `json-blob`
(→ jq-select), `long-lines` (→ don't inline a minified blob), `node-modules`
(→ exclude the dir), `repeated` (→ reuse the copy already in context),
`user-paste` (→ attach a file). `--by class` shows the biggest lever; `--by file`
names the exact files/commands to target (e.g. a big shared doc read whole in 100
sessions). Companion to `waste.mjs` (buckets ALL content by kind) — this one is
spike-first: it names the few concrete sources whose representation you can change.
Claude only; chars/4 estimate.
