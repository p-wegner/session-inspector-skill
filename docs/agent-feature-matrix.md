# Agent feature matrix — session-inspector

**Generated** by `session-inspector/scripts/harness-matrix.mjs --write` from
`scripts/lib/harness.mjs`, and pinned by `scripts/test/harness.test.mjs`. Edit the registry,
not this file. A cell is derived from what the agent's transcript carries crossed with what
the tool needs, so it cannot disagree with the code.

**Policy.** Build a Codex or Copilot variant when that agent has sessions **and** someone asks
a question the tool answers. Symmetry is not a reason. Claude Code is the reference
implementation and stays the most advanced on purpose: a second agent is cheapest to add by
naming what it lacks. Claude-only concepts (subagent transcripts, the skill-listing and
nested-memory attachments, compaction rows, cache pricing, hooks) are deliberately not
abstracted — an interface written for one implementation guesses wrong at the second.

Legend: **y** wired today · **cand** the data is there, nobody has asked for it ·
**n/a** the agent records no such thing (the reason is in the notes).

## What each agent's transcript carries

| Fact | Claude Code | Codex | Copilot |
|---|---|---|---|
| `transcripts` — a transcript on disk that lib/sessions.mjs discovers | y | y | y |
| `events` — prompts, replies and tool calls in a parseable order | y | y | y |
| `perCallUsage` — token usage per API call | y | y | — |
| `cacheRead` — cache-read (or cached-input) tokens per call | y | y | — |
| `cacheWrite` — cache-write tokens, split by TTL | y | — | — |
| `growingOutput` — output_tokens that grow across the rows of one call | y | — | — |
| `pricing` — a model id and token split this skill prices in dollars | y | — | — |
| `toolIo` — tool calls with their file paths and result sizes | y | — | — |
| `toolErrors` — failed tool calls, marked as failures | y | y | y |
| `subagents` — nested subagent transcripts beside the session | y | — | — |
| `skills` — skill invocations visible in the transcript | y | y | y |
| `slashCommands` — slash commands and their expansion | y | — | — |
| `hooks` — hook executions with their latency | y | — | — |
| `compaction` — compaction/summary boundaries in the transcript | y | — | — |
| `limitSignals` — why the session stopped (limit, stop_reason) | y | — | — |
| `handoffArtifacts` — background jobs, monitors and scratchpad state left running | y | — | — |
| `sessionRegistry` — a live registry of running sessions | y | — | — |
| `rateLimits` — subscription rate-limit windows | y | y | — |

Layouts: **Claude Code** `~/.claude*/projects/<slug>/<id>.jsonl, subagents in <id>/subagents/` · **Codex** `~/.codex/sessions/YYYY/MM/DD/<file>.jsonl (plus CODEX_HOME, CODEX_HOMES)` · **Copilot** `~/.copilot/session-state/<uuid>/events.jsonl`.

Read outside this matrix: **opencode** — the OpenCode SQLite store (`cache-health --agent opencode`, Node 22.5+).

## One session

| Tool | Claude Code | Codex | Copilot | Notes |
|---|---|---|---|---|
| `analyze-<agent>-session` | y | y | y | one analyzer per agent; --events and --friction are the same parser |
| `… --handoff` | y | n/a | n/a | codex: background jobs and monitors are a Claude Code layer; copilot: a Claude Code layer |
| `subagent-results` | y | n/a | n/a | codex: Codex runs no nested sessions; copilot: Copilot runs no nested sessions |
| `verify-runs` | y | n/a | n/a | codex: tool output is text inside function_call_output, without the path and size shape these tools read; copilot: tool results are summarised, without sizes |
| `message-stats` | y | cand | n/a | copilot: Copilot writes no usage records at all |
| `session-dashboard` | y | n/a | n/a | codex: tool output is text inside function_call_output, without the path and size shape these tools read; copilot: Copilot writes no usage records at all |
| `session-dashboard --lens cost` | y | n/a | n/a | prices the prefix, the carry and the subagents; codex: rollouts carry no cost, and the gateway that served them prices elsewhere; copilot: no usage records |
| `session-edit` | y | cand | cand | editing a rollout has never been asked for |
| `session-compact` | y | n/a | n/a | codex: tool output is text inside function_call_output, without the path and size shape these tools read; copilot: tool results are summarised, without sizes |
| `resumable, session-resume` | y | n/a | n/a | codex: a rollout records no stop_reason; copilot: no stop reason is recorded |
| `brief` | y | y | y | --for codex|claude |
| `cache-health --session` | y | y | n/a | copilot: no usage records |

## Fleet

| Tool | Claude Code | Codex | Copilot | Notes |
|---|---|---|---|---|
| `token-sinks` | y | y | n/a | Codex counted, not costed (no `pricing`); copilot: Copilot writes no usage records at all |
| `tool-failures` | y | y | cand |  |
| `user-prompts` | y | y | cand |  |
| `incidents, tool-friction, prompt-style` | y | y | y |  |
| `skill-usage` | y | y | y |  |
| `cache-health --days` | y | y | n/a | copilot: no usage records |
| `fleet-stats` | y | cand | n/a | Codex token_count events carry cached tokens since 2026-09-18, so it is buildable; copilot: Copilot writes no usage records at all |
| `context-growth` | y | n/a | n/a | codex: a rollout records no compaction boundary; copilot: no usage records |
| `cold-cache` | y | n/a | n/a | needs the write to price a re-warm; codex: a rollout's token_count event reports cached input, not a write or a TTL split; copilot: no usage records |
| `waste, context-spikes, reread-causes, read-patterns` | y | n/a | n/a | codex: tool output is text inside function_call_output, without the path and size shape these tools read; copilot: tool results are summarised, without sizes |
| `hook-cost` | y | n/a | n/a | codex: Codex has no hooks; copilot: Copilot has no hooks |
| `slash-goals` | y | n/a | n/a | codex: Codex has no slash-command layer in the rollout; copilot: not in the event stream |
| `skill-genesis` | y | n/a | n/a | codex: tool output is text inside function_call_output, without the path and size shape these tools read; copilot: tool results are summarised, without sizes |
| `quota-report, quota-multi, quota-month` | y | cand | n/a | Codex rollouts carry rate_limits; worth building if a Codex limit starts to bind; copilot: no rate-limit window is recorded |
| `live, continuations` | y | n/a | n/a | codex: no per-pid registry is written; copilot: no registry is written |
| `sync-*, session-bundle, hub-service` | y | y | y |  |

## Adding an agent

1. A `HARNESS` entry in `scripts/lib/harness.mjs`: the layout, and a reason string for every
   fact the agent does not record. The reason is what a refusal prints, so write it for
   someone who just got told no.
2. Discovery and parsing: `lib/sessions.mjs` and `lib/parse.mjs` branch per agent today. Split
   them into one module per agent only when a second agent needs a verb — the seam is three
   verbs (discover, meta, events+usage), not thirty.
3. Nothing else. Every tool's cell in the tables above appears on its own, as `cand` or `n/a`,
   and a tool that cannot answer refuses with `refuse(tool, agent)` rather than printing a zero.
