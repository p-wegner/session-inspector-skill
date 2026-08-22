# session-inspector

A self-contained agent skill for **inspecting coding-agent session transcripts** —
debug why a session stopped, what it did, whether it produced output, where tokens
went, and which tools keep failing. Works across three agents:

| Agent | Transcript location | Format |
|-------|--------------------|--------|
| **Claude Code** | `~/.claude/projects/` | JSONL per session |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/` | JSONL (`{timestamp,type,payload}`) |
| **GitHub Copilot CLI** | `~/.copilot/session-state/<uuid>/events.jsonl` | JSONL events |

Everything depends only on **Node builtins** (`fs`/`path`/`os`/`http`) — no package
install, no server, no monorepo checkout, no board required. Requires **Node 18+**
(uses global `fetch`).

## Three altitudes

The skill works at three levels, smallest to largest:

1. **One session** — `analyze-*-session.mjs`: a structured summary of a single run
   (model, duration, turns, tool usage, failed calls, repeated commands, last messages).
2. **Many sessions (your machine)** — `token-sinks.mjs` / `tool-failures.mjs` /
   `user-prompts.mjs`: time-scoped fan-out across your whole local session tree to
   find aggregate friction and cost. *The unit of compounding engineering is the
   population over a window, not the single run.*
3. **Across machines** — `sync-*.mjs`: push raw transcripts from every device you
   work on into one small server, then browse/search the combined set from a web UI
   or the CLI. (See [Cross-machine sync](#cross-machine-sync-session-sync).)

## "What should I pick up next?" — and spawning it

The question that motivated this section is not *"which session broke?"* but
*"which work is still open, and can you start sessions for it?"* — and the answer
was **not** in the transcripts. It was in each repo's own `CONTINUE.md`.

`continuations.mjs` joins the two halves — sessions (who worked where, what a
limit cut off, what a human last asked) × repos (what their docs still list as
open, what git says is unpushed or dirty) × the present (which repos already have
a live session, which account has quota headroom) — and ranks the result with the
reasoning shown.

Nothing launches on its own. It writes a **plan** in which every candidate is
`approved: false`, and [spawn-session](https://github.com/p-wegner/spawn-session)
launches **only** approved entries. That is the human gate: it can be answered,
never skipped.

```bash
node scripts/continuations.mjs                       # ranked shortlist, with reasons
node scripts/continuations.mjs --plan plan.json      # write the plan (all unapproved)
node scripts/continuations.mjs --review plan.json    # walk it interactively (y/n/a/q)
node scripts/continuations.mjs --approve plan.json --pick 1,3
& "C:\projects\andrena\spawn-session\spawn.cmd" -batch plan.json
```

### How to ask an agent for it

You do not need the commands. Say what you want and the skill's own docs route it:

| Say this | What the agent runs |
|---|---|
| "what should we continue working on?" | `continuations.mjs` — ranked, with reasons |
| "what could we pick up, and spawn sessions for the good ones" | plan → shows you the summaries → gate → `-batch` |
| "spread them across my profiles" | `--profiles`, one account per candidate |
| "only this repo" | `--project <name>` |
| "I got rate-limited — continue that session" | `resumable.mjs` — which recommends a **handoff**, not a resume (see below) |
| "which sessions hit a wall?" | `incidents.mjs` (friction), not this |

Because an agent's stdin is not a terminal, an agent cannot answer `--review`
itself. It presents the summaries, asks **you**, and records your answer with
`--approve --pick 1,3`. If it never asks, the plan stays all-`false` and the
launcher refuses — the gate holds either way.

**What the summary tells you per candidate**, so the decision is one read: the
repo and its git state, why it surfaced, its top open items *quoted from its own
docs*, the last human instruction, the session that is the evidence, whether a
cut-off session there was already picked up by someone else, and any conflict
(a live session in that checkout).

### Continuing a cut-off session: hand off, don't resume

`claude --resume` looks like the obvious way to continue a session a usage limit
killed. It is usually the expensive way, for two reasons that both bite hardest in
that exact case:

- **It cannot cross profiles.** The session is pinned to the account it ran on —
  which is the account that just ran out of quota.
- **The cache is dead.** Claude Code's prompt cache has a 1-hour TTL. Resuming
  after that re-writes the whole context at 2x base input instead of reading it at
  0.1x: a **20x** multiplier on the first turn, before any new work.

Measured across this machine's five real cut-offs (103k–295k context): resuming
them cold costs **$11.24** versus **$0.56** warm. A brief is cents.

So the tools recommend a handoff and show you the number. Resume is still
recommended where it wins — same account, still-warm cache, or a small context.

## Layout

```
SKILL.md                          # skill entrypoint (frontmatter name: session-inspector)
references/
  claude-recipes.md               # manual PowerShell recipes for Claude transcripts
  codex-recipes.md                # Codex {timestamp,type,payload} event format + recipes
  copilot-recipes.md              # Copilot events.jsonl format + recipes
  aggregate-tools.md              # usage for the fleet-wide fan-out scripts
  session-sync.md                 # full setup/config/API for cross-machine sync
  statusline.md                   # show the current session locator in the Claude Code statusline
scripts/
  analyze-claude-session.mjs      # single Claude session  → structured summary
  analyze-codex-session.mjs       # single Codex session   → structured summary
  analyze-copilot-session.mjs     # single Copilot session → structured summary
  continuations.mjs               # WHICH WORK to pick up next → ranked candidates → human-gated spawn plan
  session-edit.mjs                # extract → edit → apply: rewrite a Claude session's messages (WRITES)
  token-sinks.mjs                 # rank token/cost sinks across MANY sessions
  tool-failures.mjs               # rank failed tool calls across MANY sessions
  user-prompts.mjs                # extract real human-typed prompts across MANY sessions
  sync-server.mjs                 # REST + web-UI hub: collect transcripts from all machines
  sync-push.mjs                   # client: incremental push of this machine's transcripts
  sync-query.mjs                  # CLI browse/search/fetch over the synced set
  lib/
    sessions.mjs                  # shared discovery, metadata, git-remote project identity
    parse.mjs                     # shared full-transcript parsers (tools/files/tokens/last-msg) — used by analyzers AND the hub UI
    config.mjs                    # host-agnostic URL/port/device/data-dir resolution
    provenance.mjs                # WHO started a session: human / board-launched / handoff-seeded / stop-hook
    successor.mjs                 # has a cut-off session already been picked up? (ledger > brief > mention)
    repo.mjs                      # a repo's own open items: CONTINUE.md / BACKLOG.md parsing + git state
```

## Quick start

```bash
# Inspect one session (newest, or pass a path)
node scripts/analyze-claude-session.mjs  --latest
node scripts/analyze-codex-session.mjs   --latest
node scripts/analyze-copilot-session.mjs --latest

# What should I pick up next? (ranked, then a human-gated spawn plan)
node scripts/continuations.mjs
node scripts/continuations.mjs --plan plan.json

# Aggregate across many local sessions
node scripts/token-sinks.mjs    --days 7        # biggest token/cost sinks
node scripts/tool-failures.mjs  --by error      # most common tool failures
node scripts/user-prompts.mjs   --today         # what you actually asked

# Share across machines (see the dedicated section below)
node scripts/sync-server.mjs                     # run the hub, open http://localhost:8765/
node scripts/sync-push.mjs                       # push this machine's sessions to it
node scripts/sync-query.mjs search "<text>" --deep

# Edit a finished Claude session's messages (two-phase, in your own editor)
node scripts/session-edit.mjs extract --latest -o edits.md
node scripts/session-edit.mjs apply edits.md --dry-run
```

Every tool except `session-edit.mjs` is read-only: it reads from the standard agent
home dirs and writes only to stdout. `session-edit.mjs apply` is the one writer — it
rewrites message text in a transcript in place, guarded by per-block conflict
detection (it refuses only when a block *you edited* changed underneath you, not
merely because the session appended a turn), a live-session check, and a
timestamped backup. Blocks are addressed by `uuid`, never by line offset, so
nothing is deleted or reordered and `claude --resume` still works.

## Cross-machine sync (session-sync)

The analyzers above read **local** transcripts. session-sync lets you inspect
sessions from **every machine you work on** — push each device's raw transcripts to
one small server, then browse/search the combined set from a web UI or the CLI.

Designed for a **single developer across multiple devices on a private tailnet**:
"user isolation" is a per-device hostname tag, full raw transcripts move unmodified,
**no auth — keep it tailnet-only**.

### Run it

```bash
# on the hub box (any machine you want as the collector):
node scripts/sync-server.mjs                 # binds 0.0.0.0:8765; open http://localhost:8765/

# on every machine (including the hub itself):
node scripts/sync-push.mjs                   # incremental: only new/changed sessions
```

Point a client at a remote hub with `--server <url>` or `SESSION_SYNC_URL` — nothing
else changes, so you can develop everything on localhost and go multi-device later.

### Persistent hub service

`sync-server.mjs` in the foreground dies with your terminal. To keep the hub up
across logout/reboot, manage it with `scripts/hub-service.mjs` — it spawns the
server detached (no console window), tracks pid/log under the data dir, and
registers an OS autostart entry (Windows Scheduled Task / macOS launchd / Linux
systemd `--user`):

```powershell
node scripts/hub-service.mjs status      # running? indexed count? autostart installed?
node scripts/hub-service.mjs start       # spawn detached + hidden
node scripts/hub-service.mjs restart     # stop then start
node scripts/hub-service.mjs install     # autostart at logon (Windows/macOS: elevated shell)
node scripts/hub-service.mjs uninstall   # remove autostart
node scripts/hub-service.mjs logs -n 40  # tail the hub log
```

For tailnet reach, open one inbound firewall rule for the port (on Windows the
Tailscale adapter is on the *Private* profile, so the rule is required). Full
per-OS detail and the firewall one-liner: [`references/hub-service.md`](references/hub-service.md).

### Browse

- **Web UI** at `http://<hub>:<port>/` — keyword box (with a **deep** toggle that greps
  full transcript text), device/agent/project filters, result list, and a detail pane
  with metadata, first/last prompt, and the raw transcript.
- **CLI** for the terminal and the agent:

  ```bash
  node scripts/sync-query.mjs meta                       # devices / providers / projects / count
  node scripts/sync-query.mjs list --provider claude --limit 20
  node scripts/sync-query.mjs search "leaderboard" --deep
  node scripts/sync-query.mjs get <key> --analyze        # fetch a remote session + run its analyzer
  ```

  `get --analyze` is the cross-machine deep-dive / model-handover path: pull a session
  that ran on another device and run the same structured analyzer on it as if it were local.

### How it behaves

- **Incremental push** — a local state file tracks each file's `(mtime,size)`; unchanged
  sessions are skipped without being read.
- **No duplicates** — sessions are keyed on `(device, provider, sessionId)` and deduped by
  content hash, so a *continued* session updates **in place** rather than creating a second entry.
- **Stable project identity across machines** — each session's `cwd` is resolved to its
  normalized `git remote` (e.g. `github.com/owner/repo`), so the same repo lines up even
  when cloned to different paths; falls back to the cwd basename when there's no remote.

### Configuration

| Knob | Env var | Flag | Default |
|------|---------|------|---------|
| Server URL (clients) | `SESSION_SYNC_URL` | `--server <url>` | `http://127.0.0.1:8765` |
| Listen port (server) | `SESSION_SYNC_PORT` | `--port N` | `8765` |
| Bind host (server) | — | `--host <ip>` | `0.0.0.0` |
| Device tag (clients) | `SESSION_SYNC_DEVICE` | `--device <name>` | OS hostname |
| Storage dir (server) | `SESSION_SYNC_DATA` | — | `~/.session-sync` |

Full setup, REST API, and privacy scope: [`references/session-sync.md`](references/session-sync.md).

## Install as an agent skill

**Claude Code** — clone, then junction/symlink the repo into your skills dir under the
skill's frontmatter name (`session-inspector`):

```powershell
# Windows (junction)
New-Item -ItemType Junction -Path "$HOME\.claude\skills\session-inspector" -Target "C:\path\to\session-inspector-skill"
```
```bash
# macOS / Linux (symlink)
ln -s /path/to/session-inspector-skill ~/.claude/skills/session-inspector
```

**Codex** — junction/symlink the same target into `~/.codex/skills/session-inspector`
so both harnesses share one implementation.

## Notes

- A few snippets in `copilot-recipes.md` and `aggregate-tools.md` reference an
  agentic-kanban **board API** / server-side `fleet-analysis` roll-up. Those paths are
  **optional** and only apply if you run that board — every bundled script works
  standalone with nothing but Node.
- session-sync is built for a single trusted operator on a private network; extending it
  to a multi-developer team would add redaction, auth, and per-user privacy (out of scope).
- Source of truth for the non-portable version lives in
  `agentic-kanban/.claude/skills/session-inspector` + `agentic-kanban/scripts`.

## License

[MIT](LICENSE)

_Docs last synced with the code at `dc7518e` (2026-08-22)._
