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

`reread-causes.mjs` answers **"are the re-reads waste.mjs flags actually avoidable?"**
— waste's dup-read number is an UPPER BOUND: it charges every 2nd+ touch of a file.
This tool classifies each re-read by what happened between the two reads:
**after-own-edit** (an Edit/Write landed in between — refreshing own changes),
**post-compaction** (the earlier copy was summarized away), **pre-edit-refresh**
(the read enables an edit within `--edit-window` turns), **different-view** (another
Read range or another shell command over the same file — pagination is the
recommended pattern, not a duplicate; only the exact same view repeating counts),
**distant** (same view, > `--distant` turns old — attention refresh, gray), and
**pure-dup** (same view, recent copy still in context — the only clearly avoidable
class). Also measures the edit→re-read rate ("does Claude Code re-read after every
edit?" — measured ~6% fleet-wide, so no) and counts harness-forced re-reads (Edit
rejected as stale/unread). Claude only.

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

## cache-health — is the prompt cache being hit at all, and if not, why not

`node scripts/cache-health.mjs --session <id|path>` prints one session's per-call
input / cache_read / cache_write, the TTL in use (5m or 1h, read from
`usage.cache_creation.ephemeral_*`), every call that followed a gap longer than the TTL, which
backend answered (`anthropic`, `vertex`, `bedrock`, from the message-id prefix), the list-price
cost, and the cost the same context would have had with healthy caching. `--days N` runs the
fleet and lists sessions worst first. Verdicts:

| verdict | shape | fix lives |
|---|---|---|
| `HEALTHY` | on big calls (above 100k for Claude, 20k for codex/opencode, `--min-ctx`), cache_read is 85%+ of context, input a handful | nowhere |
| `PLATEAU` | cache_read stops at a fixed ceiling (system prompt + tools) while input grows with the conversation | in the proxy/gateway between the client and the API, not in the TTL |
| `TTL-EXPIRY` | caching works, but idle gaps outlive the TTL and the prefix is re-written after each pause | shorter pauses, or the 1h TTL if the session is on 5m |
| `MIXED` / `SHORT` | partially cached / fewer than three big calls | look at the table / nothing to judge |

Measured 2026-09-18: one session through a nexos.ai gateway (Sonnet 5, served by Vertex) was
`PLATEAU` at 21% cache read on 180 big calls, $81 at list against $14 healthy. 436 sessions on
subscription logins in the same four days: 0 `PLATEAU`, 14 `TTL-EXPIRY`, the rest healthy or
short — including sessions routed to Bedrock with the 5m TTL, which cache the history fine. So a
plateau is a routing problem, and a TTL problem shows up as a different verdict.

**Codex and OpenCode get the same verdict.** `--agent codex` reads rollout files from
`~/.codex/sessions`, `CODEX_HOME` and `CODEX_HOMES` (a `;`-separated list of further codex homes;
a gateway key's home is invisible from `~/.codex`). One `token_count` event per API response;
its `input_tokens` includes the cached part (OpenAI semantics), so the table's "uncached" column
is input minus cached minus cache_write, and there is no TTL field (gaps are judged against 5
minutes). `--agent opencode` reads the SQLite store (`~/.local/share/opencode/opencode.db`, or
`OPENCODE_DB`; Node 22.5+ for `node:sqlite`), one assistant message per API call. A provider
driven by `@ai-sdk/openai-compatible` records cache writes as 0, so a call's context is
under-counted by that turn's delta; reads are exact and the verdict is unaffected. Both agents
default to `--min-ctx 20000` for a "big" call (Claude: 100k), because their contexts stay
smaller; `--min-ctx` overrides. Models without a list price (the GPT line) print cost `n/a`.

Measured 2026-09-18 through the same nexos.ai gateway that plateaued Claude Code: a 38-call
codex session (GPT 5.6 Terra) read 99% of its context from cache, and a 38-call opencode
session (Claude Sonnet 5 over chat completions, no `cache_control` sent by the client) read 100%
of a context that grew to 294k — the gateway adds caching itself on that path. Neither harness
sends the trailing `role: "system"` entry Claude Code does, which is the one shape the gateway
loses; so `cache-health` on the three agents together tells "the gateway breaks caching" from
"one client's request shape breaks through this gateway".

**Every tool here counts usage once per API call** (`lib/usage.mjs`). Claude Code writes one
transcript row per content block, all carrying the same `message.id` and the same usage; summing
over rows over-counted by 1.8x to 3x (measured: 344 rows / 188 calls, 196 / 64, 153 / 65). Verified
that input, cache_read, cache_creation and output_tokens are identical across the rows of one id,
so first-row-wins is exact **for a main transcript**. A subagent transcript is different: its
rows are streaming snapshots and `output_tokens` grows row by row (measured 2026-09-19: 109k
output tokens from first rows against 647k from last rows over nine subagents), so
`lateOutput()` in `lib/usage.mjs` adds the growth. `token-sinks`, `lib/quota.mjs` and
`lib/turns.mjs` use it; `cache-health`, `cold-cache`, `context-growth`, `fleet-stats`,
`quota-report` and `parse.mjs` do not yet (BACKLOG). `fleet-stats` and `parseClaude` still report `assistantTurns` as rows
(that is the loop length people mean by "turns"); token sums and the new `apiCalls` are per call.
