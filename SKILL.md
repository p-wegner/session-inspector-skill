---
name: session-inspector
description: Inspect agent session transcripts from Claude (~/.claude/projects/), Codex (~/.codex/sessions/), or Copilot (~/.copilot/) to debug why sessions stopped, what they did, and whether they produced output. Self-contained — bundles its own analyzer scripts.
argument-hint: [issue-number, keyword, --codex <path>, --copilot]
---

# Session Inspector — Debugging Agent Session Transcripts

Inspect session transcripts across all three supported agents. Each stores data differently:

| Agent | Location | Format |
|-------|----------|--------|
| Claude Code | `~/.claude/projects/` | Full JSONL transcripts per session |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/` | Full JSONL transcripts per session |
| Copilot CLI | `~/.copilot/session-state/<uuid>/events.jsonl` | Full JSONL transcripts per session |

This skill is **self-contained**: the analyzer scripts under `scripts/` and the manual recipes under `references/` are bundled here and depend only on Node builtins (`fs`/`path`/`os`) — no external repo, server, or package install required. All commands below are run from **this skill's directory** (paths are relative to it). If your CWD is elsewhere, prefix with the skill path, e.g. `node <skill-dir>/scripts/analyze-claude-session.mjs --latest`.

## Start here — structured single-session analyzers

For ONE session, this is the fast path for every provider. Each prints a structured summary (model, duration, turns, tool usage, commands run, tool-failure counts, repeated commands, last agent messages):

```powershell
node scripts/analyze-claude-session.mjs  --latest   # or <path> | --list [--worktrees] | --json
node scripts/analyze-codex-session.mjs   --latest
node scripts/analyze-copilot-session.mjs --latest
```

### Browse the event timeline by type (`--events`)

To step through *what happened in order* — and zoom in on one kind of event — add
`--events` to any analyzer. It prints one chronological, typed stream
(`user` / `assistant` / `thinking` / `tool_call` / `tool_error`) with a `#seq HH:MM:SS type` prefix:

```powershell
node scripts/analyze-claude-session.mjs --latest --events                     # full timeline
node scripts/analyze-claude-session.mjs --latest --events --type tool_error -v # just failures, full text
node scripts/analyze-claude-session.mjs --latest --events --type call,asst     # tool calls + assistant msgs
node scripts/analyze-claude-session.mjs --latest --events --grep git --limit 20 # last 20 mentioning "git"
node scripts/analyze-claude-session.mjs --latest --events --type err --json    # machine-readable
```

Flags: `--type a,b` (aliases: `err`/`call`/`asst`/`user`/`think`), `--grep <substr>`,
`--limit N` (last N), `--verbose`/`-v` (full multi-line text), `--json`. Same flags work
on the Codex and Copilot analyzers. In the **web UI** (session-sync), the detail pane has a
**timeline** button with clickable per-type filter chips + a text filter over the same stream.

When the analyzer isn't enough and you need custom parsing, load the matching **manual recipe file** (PowerShell snippets, loaded on demand):
- `references/claude-recipes.md` — find a session by issue #, quick overview, parse tail, detect "started but never responded", read last message / sent prompt, find by `stop_reason`.
- `references/codex-recipes.md` — Codex `{timestamp,type,payload}` event types, list, parse tail, launch-failure detection, find user messages.
- `references/copilot-recipes.md` — Copilot `events.jsonl` event types, manual parse, workspace correlation, process logs, common-issue symptoms. (Some snippets read an agentic-kanban board API — **optional**, only relevant if you run that board; the local `events.jsonl` path always works.)

**Tip — surface the current session in your statusline.** To make the *current* Claude session one copy-paste away (for inspecting it or handing it to a stronger model mid-task), show its `<project-folder>/<session-id>` locator in the Claude Code statusline. Setup in `references/statusline.md`.

## Per-session vs fleet (aggregate across MANY sessions)

This skill debugs **one** session. For **aggregate, time-scoped questions across MANY sessions** — "which tools fail most in the last 48h", "what's burning tokens", "what did I ask yesterday" — do **not** loop the per-session recipes. Use the bundled standalone fan-out scripts (they stat-filter by mtime FIRST, then parse only in-window files):

```powershell
node scripts/token-sinks.mjs      # biggest token/cost sinks (--by project|day|model|provider|session, --days N, --json)
node scripts/tool-failures.mjs    # failed tool calls ranked (--by tool|project|error|day, --sort rate, --json)
node scripts/user-prompts.mjs     # real human-typed prompts (--date, --today, --days N, --tree, --json)
node scripts/prompt-style.mjs     # PROMPTING-STYLE profile (--project, --provider, --days N, --samples N, --json)
node scripts/incidents.mjs        # FRICTION ranking — which sessions to investigate (--project, --lens, --grep, --top, --json)
```

`incidents.mjs` answers **"which sessions are worth learning from?"** — it ranks
the fleet by friction (human course-corrections matching a defect lexicon,
repeated near-identical complaints, failed tools, wasted command re-runs, and
image-**regeneration churn**) so you deep-dive the few sessions that hit a wall
instead of reading them all. Swap the lexicon with `--lens general|visual|image`
(visual = overlap/cropped/chrome/aspect…; image = crop/aspect/regenerate/refusal…),
narrow with `--project`/`--grep`/`--days`, then it prints the exact
`analyze-*-session.mjs … --events --grep` command to explain the top hit. It's
the discovery half of the loop; the single-session analyzers are the explain half.

`prompt-style.mjs` answers "how do I talk to the agent?" — it aggregates every
real human prompt into a length distribution, tone/format signals (lowercase
start %, question %, terse one-liners %, approval-only %, German/umlaut %, …),
opening-word frequencies, and representative samples. Scope it with
`--project <substr>` (matches the Claude projects-dir folder, the session cwd,
or the git remote), `--provider`, and `--days N`; run bare for an all-time,
all-projects profile (with a busiest-projects breakdown). It shares the
human-vs-noise `classify()` filter with `user-prompts.mjs` (both live in
`scripts/lib/prompts.mjs`), so the two tools always agree on what a prompt is.

Full usage + caveats for the other three in `references/aggregate-tools.md`. (That file also mentions a server-side `fleet-analysis` roll-up — that path needs an agentic-kanban board and is **optional**; the bundled scripts above need nothing but Node.)

## Share sessions across your machines (session-sync)

The analyzers and fleet tools above read **local** transcripts. To inspect sessions
from **other machines** too (laptop + desktop + …), run the bundled session-sync
service: each device pushes its raw transcripts to one small server, and you
browse/search the combined set from a web UI or the CLI. Built for a **solo dev
across devices on a private tailnet** — "user isolation" is a per-device hostname
tag; full raw transcripts, no auth (tailnet-only). Node builtins, no install.

```powershell
node scripts/sync-server.mjs                 # run on the hub box (binds 0.0.0.0:8765); open http://localhost:8765/
node scripts/sync-push.mjs                   # on each machine: incremental push of new/changed sessions
node scripts/sync-query.mjs search "<text>" --deep   # CLI browse/search across all synced sessions
node scripts/sync-query.mjs get <key> --analyze      # fetch a remote session and run its analyzer (model-handover)
```

Point clients at a remote hub with `--server <url>` or `SESSION_SYNC_URL`. Incremental
push (local state file), continued sessions dedup in place by `(device,provider,sessionId)`,
and project identity is resolved via `git remote` so it's stable across machines.
Full setup, config knobs, REST API, and privacy scope in `references/session-sync.md`.

### Run the hub as a persistent service

To keep the hub up across logout/reboot instead of babysitting `sync-server.mjs`,
use the lifecycle manager — it spawns the server detached (hidden), tracks pid/log
under the data dir, and installs an OS autostart entry (Scheduled Task on Windows,
launchd on macOS, systemd `--user` on Linux):

```powershell
node scripts/hub-service.mjs status      # running? indexed count? autostart installed?
node scripts/hub-service.mjs start       # spawn detached + hidden, write pid/log
node scripts/hub-service.mjs restart     # stop then start
node scripts/hub-service.mjs install     # register autostart at logon (Windows/macOS: needs an elevated shell)
node scripts/hub-service.mjs logs -n 40  # tail the hub log
```

Tailnet exposure needs one inbound-allow firewall rule for the port (8765); on
Windows the Tailscale adapter is on the *Private* profile, so add the rule once with
an elevated shell. Setup, the firewall one-liner, and per-OS autostart details in
`references/hub-service.md`.

## Directory naming convention (Claude)

Each working directory maps to a session dir by replacing path separators with `--`:
- `C:\andrena\.worktrees\feature_ak-17-...` → `C--andrena--worktrees-feature-ak-17-...`
- `C:\andrena\agentic-kanban\packages\.worktrees\feature_ak-N-...` → `C--andrena-agentic-kanban-packages--worktrees-feature-ak-N-...`

Multiple `.jsonl` files in one dir = multiple sessions (e.g. original run + re-launched review). Sort by `LastWriteTime` descending to find the latest.

## Common stop_reason values and what they mean (Claude)

| stop_reason | Meaning |
|-------------|---------|
| `end_turn` | Agent finished normally — said what it wanted to say |
| `tool_use` | Agent was mid-execution of a tool call when session ended (interrupted or still running) |
| `stop_sequence` | A stop sequence triggered — often auth failure ("Invalid API key") or rate limit |
| `max_tokens` | Hit context/output token limit |
| *(absent)* | Session file has user prompt but no assistant entry — agent never responded |

## Tips

- **Never `Get-Content` a large JSONL without `-Tail`** — some files are 1-2MB+ and will flood the terminal.
- Each line is a self-contained JSON object; parse line-by-line with `ConvertFrom-Json -ErrorAction SilentlyContinue`.
- For **Claude sessions**: the `sessionId` field is on most entries and matches the filename (minus `.jsonl`). `ai-title`, `queue-operation`, `attachment` entries are metadata — only `user` and `assistant` entries carry content.
- For **Codex sessions**: every line wraps in `{ timestamp, type, payload }`. Use the `analyze-codex-session.mjs` script for structured summaries.
- For **Copilot sessions**: full transcripts in `~/.copilot/session-state/<uuid>/events.jsonl`. Use `analyze-copilot-session.mjs` for structured summaries.
- Sessions with 8 lines and no `assistant` entry = the process started but exited before Claude responded. Check for auth errors or process kills.
