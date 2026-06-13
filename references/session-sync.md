# Session sync — share transcripts across your machines

Per-session and aggregate inspection both assume the transcripts are on **this**
machine. Session-sync lifts that to **all your machines**: each device pushes its
raw transcripts to one small server, and you browse/search the combined set from
a web UI or the CLI. This is the infrastructure side of "the unit of compounding
engineering is the population over a window, not the single run" — but for a
**solo developer across multiple devices** (laptop + desktop + …), where
"user isolation" is just a **device tag** (hostname) on every session.

Three Node files, builtins only (no install):

| File | Role |
|------|------|
| `scripts/sync-server.mjs` | REST + web-UI service. Stores raw transcripts + a metadata index. Run on the box you want as the hub. |
| `scripts/sync-push.mjs` | Client. Walks this machine's Claude/Codex/Copilot session roots and uploads (incremental). |
| `scripts/sync-query.mjs` | CLI browse/search/fetch — the terminal counterpart to the web UI (also what the agent uses). |

Shared helpers: `scripts/lib/sessions.mjs` (discovery + metadata + git-remote project identity), `scripts/lib/config.mjs` (URL/port/device/data-dir resolution).

## Configuration (host-agnostic)

| Knob | Env var | Flag | Default |
|------|---------|------|---------|
| Server URL (clients) | `SESSION_SYNC_URL` | `--server <url>` | `http://127.0.0.1:8765` |
| Listen port (server) | `SESSION_SYNC_PORT` | `--port N` | `8765` |
| Bind host (server) | — | `--host <ip>` | `0.0.0.0` (tailnet-reachable) |
| Device tag (clients) | `SESSION_SYNC_DEVICE` | `--device <name>` | OS hostname |
| Storage dir (server) | `SESSION_SYNC_DATA` | — | `~/.session-sync` |

Develop everything on one machine first (server on `127.0.0.1`, push to it, browse
`localhost:8765`). To go multi-device later, run the server on the hub and point
each client at it — nothing else changes:

```powershell
# on the hub (e.g. the desktop, reachable on the tailnet):
node scripts/sync-server.mjs                       # binds 0.0.0.0:8765

# on every machine (incl. the hub itself):
$env:SESSION_SYNC_URL = "http://100.80.175.96:8765"
node scripts/sync-push.mjs
```

> Tailnet note: `--host 0.0.0.0` makes the server reachable to any device on the
> tailnet. Open the matching firewall rule on the hub for the chosen port (same
> pattern as the ACP server's 9876 rule). Keep it tailnet-only — there is no auth.

## Pushing (manual, incremental)

```powershell
node scripts/sync-push.mjs                  # all providers, only new/changed since last run
node scripts/sync-push.mjs --provider claude
node scripts/sync-push.mjs --days 7         # only sessions touched in the last 7 days
node scripts/sync-push.mjs --dry-run        # show what would upload, send nothing
node scripts/sync-push.mjs --force          # re-evaluate every file (ignore local push-state)
```

- **Incremental**: a local `push-state-<device>.json` (under the data dir) records
  each file's `(mtime,size)` last pushed; unchanged files are skipped without
  reading them.
- **Continued sessions don't duplicate**: the server keys every session on
  `(device, provider, sessionId)` and dedups by content hash. Re-pushing a session
  that grew **updates it in place** — never a second entry.
- **Project identity across machines**: each session's `cwd` (read from the
  transcript) is resolved to its `git remote get-url origin`, normalized to e.g.
  `github.com/p-wegner/agentic-kanban`. That key is stable even when the repo lives
  at a different path on each machine. No git remote (or deleted worktree) → falls
  back to the cwd basename.

## Browsing — web UI

Open `http://<server>:<port>/`. Single page: keyword box (with a **deep** toggle
that greps full transcript text, not just metadata), device/agent/project filters,
a result list (provider badge · project · first-prompt preview · time · size), and
a detail pane (metadata, first/last prompt, raw transcript, download-raw).

## Browsing — CLI (`sync-query.mjs`)

```powershell
node scripts/sync-query.mjs meta                          # devices / providers / projects / count
node scripts/sync-query.mjs list --provider claude --limit 20
node scripts/sync-query.mjs search "leaderboard" --deep   # full-text across transcripts
node scripts/sync-query.mjs list --project agentic-kanban --device desktop-13vrhen
node scripts/sync-query.mjs get <key>                     # print raw transcript ("key" shown by list/search)
node scripts/sync-query.mjs get <key> --save out.jsonl
node scripts/sync-query.mjs get <key> --analyze           # fetch + run the matching analyze-<provider>-session.mjs
```

`get --analyze` is the **cross-machine model-handover / deep-dive** path: pull a
session that ran on another device and run the same structured analyzer on it as
if it were local. Add `--json` to `list`/`search` for machine-readable output.

## REST API (for other tooling)

```
GET  /api/health
GET  /api/meta                                    -> {devices, providers, projects, count}
GET  /api/manifest?device=&provider=              -> [{key,hash,bytes,mtime}]
POST /api/sessions                                upload one session (envelope: device,provider,sessionId,content,…)
GET  /api/sessions?device=&provider=&project=&q=&deep=1&since=&until=&limit=   -> [record]
GET  /api/sessions/get?key=<device/provider/sessionId>   -> {record, content}
GET  /api/sessions/raw?key=...                    -> text/plain transcript
```

`key` = `device/provider/sessionId`. Timestamps are ISO; `since`/`until` compare
against each session's source-file `mtime`.

## Privacy / scope

Designed for a **single trusted operator on a private tailnet**: full raw
transcripts move unmodified, no redaction, no auth. That's fine inside your own
tailnet — do **not** expose the port publicly. Extending this to a multi-developer
team would add the harder pieces the original idea flagged (redaction, auth,
per-user privacy) — out of scope here.
