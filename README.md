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

## Layout

```
SKILL.md                          # skill entrypoint (frontmatter name: session-inspector)
references/
  claude-recipes.md               # manual PowerShell recipes for Claude transcripts
  codex-recipes.md                # Codex {timestamp,type,payload} event format + recipes
  copilot-recipes.md              # Copilot events.jsonl format + recipes
  aggregate-tools.md              # usage for the fleet-wide fan-out scripts
  session-sync.md                 # full setup/config/API for cross-machine sync
scripts/
  analyze-claude-session.mjs      # single Claude session  → structured summary
  analyze-codex-session.mjs       # single Codex session   → structured summary
  analyze-copilot-session.mjs     # single Copilot session → structured summary
  token-sinks.mjs                 # rank token/cost sinks across MANY sessions
  tool-failures.mjs               # rank failed tool calls across MANY sessions
  user-prompts.mjs                # extract real human-typed prompts across MANY sessions
  sync-server.mjs                 # REST + web-UI hub: collect transcripts from all machines
  sync-push.mjs                   # client: incremental push of this machine's transcripts
  sync-query.mjs                  # CLI browse/search/fetch over the synced set
  lib/
    sessions.mjs                  # shared discovery, metadata, git-remote project identity
    config.mjs                    # host-agnostic URL/port/device/data-dir resolution
```

## Quick start

```bash
# Inspect one session (newest, or pass a path)
node scripts/analyze-claude-session.mjs  --latest
node scripts/analyze-codex-session.mjs   --latest
node scripts/analyze-copilot-session.mjs --latest

# Aggregate across many local sessions
node scripts/token-sinks.mjs    --days 7        # biggest token/cost sinks
node scripts/tool-failures.mjs  --by error      # most common tool failures
node scripts/user-prompts.mjs   --today         # what you actually asked

# Share across machines (see the dedicated section below)
node scripts/sync-server.mjs                     # run the hub, open http://localhost:8765/
node scripts/sync-push.mjs                       # push this machine's sessions to it
node scripts/sync-query.mjs search "<text>" --deep
```

All read-only tools read from the standard agent home dirs and write only to stdout.

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
