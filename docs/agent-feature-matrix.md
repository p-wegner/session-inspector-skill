# Agent feature matrix — session-inspector

Which tool reads which agent's transcripts, as of 2026-09-18 (`18bfb6f`). Read off each script's
header and its `--provider` / `--agent` flag, not by running every mode per agent. Re-check a cell
against the script before relying on it.

**Policy.** Build a Codex or Copilot variant only when that agent has sessions **and** someone asks
a question the tool answers. Symmetry is not a reason. Usage on the work box, 2026-09-18: Claude
is the bulk. Codex has 224 rollouts in the last 30 days, including gateway runs under `CODEX_HOMES`.
Copilot has 2 session dirs, none in the last 30 days. OpenCode is read by `cache-health` only.

Legend: **y** supported · **—** Claude only today · **n/a** the agent has no such concept or data ·
**cand** a Codex candidate worth building once asked for (reason in the notes).

## One session

| Tool | Claude | Codex | Copilot | Notes |
|---|---|---|---|---|
| `analyze-*-session` (summary, `--events`, `--friction`) | y | y | y | one analyzer per agent |
| `--handoff` (what is left running) | y | — | — | Claude-specific artefacts (bg jobs, monitors, scratchpad) |
| `subagent-results` | y | n/a | n/a | subagent transcripts are a Claude layout |
| `session-edit` | y | — | — | editing a Codex rollout has never been asked for |
| `resumable`, `session-resume` | y | — | — | |
| `brief` (hand to the other agent) | y | y | y | `--for codex\|claude` |
| `cache-health --session` | y | y | — | also OpenCode (`--agent opencode`) |

## Fleet

| Tool | Claude | Codex | Copilot | Notes |
|---|---|---|---|---|
| `token-sinks` | y | y | — | Codex counted, not costed |
| `tool-failures` | y | y | — | |
| `user-prompts` | y | y | — | |
| `incidents`, `tool-friction`, `prompt-style`, `skill-usage` | y | y | y | `--provider` accepts all three |
| `cache-health --days` | y | y | — | plus OpenCode |
| `fleet-stats` | y | cand | n/a | header: "Codex/Copilot don't expose per-turn cache usage". Codex `token_count` events now do (`parseCodex` gained cached tokens 2026-09-18), so this is buildable |
| `context-growth` | y | cand | n/a | same reason; also carries BACKLOG item 4 |
| `cold-cache` | y | cand | n/a | Codex has timestamps plus cached tokens per call |
| `waste`, `context-spikes`, `reread-causes`, `read-patterns` | y | — | — | tool-output shape differs; build only on demand |
| `hook-cost`, `slash-goals`, `skill-genesis` | y | n/a | n/a | Claude Code concepts |
| `quota-report`, `quota-multi`, `quota-month` | y | cand | n/a | Codex rollouts carry `rate_limits` in `token_count`; useful only if a Codex subscription limit starts to bind |
| `live`, `continuations` | y | — | — | `live` reads Claude's session registry |
| sync (`sync-*`, `session-bundle`, `hub-service`) | y | y | y | discovery via `lib/sessions.mjs` |

## Where the description over-promises

`SKILL.md`'s description lists Claude, Codex and Copilot at equal weight, but for fleet questions
Codex is partial and Copilot almost absent. Either narrow the description (BACKLOG item 6), or say
in each fleet tool's reach line which agents it read. Item 1's reach block does the second.
