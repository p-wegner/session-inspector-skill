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
| `scripts/session-bundle.mjs` | Offline export/import — hand a slice of transcripts to another machine or another person (see "Bundles" below). |

Shared helpers: `scripts/lib/sessions.mjs` (discovery + metadata + git-remote project identity), `scripts/lib/config.mjs` (URL/port/device/user/data-dir resolution), `scripts/lib/archive.mjs` (zip create/extract).

## Who a session belongs to: device, user, profile

Three orthogonal tags, all optional and all defaulting to "unknown" rather than
being dropped:

| Tag | Means | Source | Override |
|-----|-------|--------|----------|
| `device` | which machine | OS hostname | `SESSION_SYNC_DEVICE` / `--device` |
| `user` | which **human** | OS username | `SESSION_SYNC_USER` / `--user` |
| `profile` | which Claude **account** (`~/.claude-<name>`) | derived from the transcript's config dir | — (intrinsic) |

`device` was enough while the corpus was one person's laptop + desktop. `user`
exists so several developers' transcripts can be pooled into one store and still
be told apart; `profile` so "everything that ran under my andrena subscriptions"
is a query rather than a path glob. `profile` matches as a **substring**
(`--profile andrena` → the whole `andrena_team_5x*` family); `device` and `user`
match exactly.

Records written before these fields existed simply have them empty — filters
never implicitly exclude them.

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
node scripts/sync-push.mjs --profile andrena  # only the andrena_team_5x* auth profiles
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
a detail pane.

The detail pane parses the full transcript on demand (server-side, via
`scripts/lib/parse.mjs` — the same parser the `analyze-*-session.mjs` CLIs use) and
shows the kanban-style session summary:

- **stats row** — duration, turns, tool calls (+ failed %), tokens in→out, cache-read,
  cost, stop reason, and for Copilot the `+/-` diff lines.
- **tool usage** — per-tool call counts with failure badges.
- **repeated commands** — the wasted-turn signal (same command run ≥2×).
- **files** edited / written / read (Claude from `Read`/`Edit`/`Write` tool calls,
  Codex from applied patches, Copilot from `codeChanges`).
- **web searches** (Codex) and **error excerpts** (failed tool results).
- **last assistant message** — what the agent actually said last (not just the
  last *prompt*), plus first/last user prompt.
- **raw transcript** — collapsed by default, fetched lazily so opening a session
  is cheap even for multi-MB files.

## Browsing — CLI (`sync-query.mjs`)

```powershell
node scripts/sync-query.mjs meta                          # devices / users / profiles / providers / projects
node scripts/sync-query.mjs list --provider claude --limit 20
node scripts/sync-query.mjs search "leaderboard" --deep   # full-text across transcripts
node scripts/sync-query.mjs list --project agentic-kanban --device desktop-13vrhen
node scripts/sync-query.mjs list --user alice --profile andrena   # one person, one account family
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
GET  /api/meta                                    -> {devices, users, profiles, providers, projects, count}
GET  /api/manifest?device=&provider=              -> [{key,hash,bytes,mtime}]
POST /api/sessions                                upload one session (envelope: device,user,profile,provider,sessionId,content,…)
GET  /api/sessions?device=&user=&profile=&provider=&project=&q=&deep=1&since=&until=&limit=   -> [record]
GET  /api/sessions/get?key=<device/provider/sessionId>   -> {record, content}
GET  /api/sessions/raw?key=...                    -> text/plain transcript
GET  /api/sessions/summary?key=...                -> {record, summary, lines}  (full parse: tools, files, tokens, last assistant message)
GET  /api/sessions/events?key=...                 -> {counts, events:[{seq,ts,type,tool,text}]}  (chronological typed timeline: user/assistant/thinking/tool_call/tool_error)
```

`key` = `device/provider/sessionId`. Timestamps are ISO; `since`/`until` compare
against each session's source-file `mtime`.

## Bundles — the offline path (`session-bundle.mjs`)

Sync needs both machines up, on the same tailnet, at the same time. A **bundle**
drops all three requirements: one zip carrying selected transcripts plus a
manifest, movable by any means (scp, USB, chat). Two jobs:

1. **Archive/share a slice** — "every session from my andrena profiles".
2. **Pool corpora across people** — several developers each export a bundle, one
   person imports them all, and the combined store is queried as a single
   population. This is what makes compounding-engineering analysis work over a
   *team's* sessions rather than one person's.

```
<bundle>/
  manifest.json                                  origin, filters, counts, full record per session
  README.txt                                     install instructions for the recipient
  sessions/<device>/<provider>/<sessionId>.jsonl raw transcripts, unmodified
```

### Export

```powershell
node scripts/session-bundle.mjs export --profile andrena --out team.zip
node scripts/session-bundle.mjs export --from server --days 30 --out last30.zip
node scripts/session-bundle.mjs export --profile andrena --dry-run
node scripts/session-bundle.mjs export --profile andrena --format dir --out ./team
```

`--from local` (default) reads this box's profiles directly — no server needed.
`--from server` pulls from the sync hub, so one bundle can span every device that
ever pushed. Filters: `--profile --provider --project --device --user --days
--since --until --limit`. `--format dir` writes the plain directory and skips the
archiver entirely (always works, even where neither `tar` nor `zip` is usable).

### Import

```powershell
node scripts/session-bundle.mjs inspect team.zip           # manifest summary, imports nothing
node scripts/session-bundle.mjs import team.zip            # merge into the local hub
node scripts/session-bundle.mjs import alice.zip --as-user alice
```

Import POSTs each transcript to the sync server, so bundles and live pushes land
in the same store and are queried identically. Two collision guards:

- **Foreign devices get namespaced.** When the bundle's user differs from yours,
  its device tag becomes `alice@LAPTOP`. Without this, alice's `DESKTOP-ABC`
  would silently overwrite bob's, since the store keys on `(device, provider,
  sessionId)`. `--keep-device` opts out when you know the tags are already unique.
- **Re-import is a no-op.** The server dedups on content hash, so importing the
  same bundle twice reports `unchanged`, and a *grown* session updates in place.

### Sensitive projects are withheld by default

Transcripts are raw and unredacted — a bundle carries whatever was on screen,
including client module names, customer references and secrets. Export therefore
**excludes** sessions whose project/cwd matches a deny pattern and prints what it
dropped. Built-in patterns cover NDA client work; extend with `--deny <regex>`
(repeatable) or `SESSION_BUNDLE_DENY=a,b`; override deliberately with
`--include-denied`.

The manifest records only the *number* withheld, never the project names — a
bundle must not leak what it was filtered against.

## Privacy / scope

Session-sync itself is designed for a **single trusted operator on a private
tailnet**: full raw transcripts move unmodified, no redaction, no auth. That's
fine inside your own tailnet — do **not** expose the port publicly.

Bundles are the one path that deliberately crosses a person boundary, and they
handle only *attribution* (the `user` tag) — not privacy. Pooling several
developers' transcripts means everyone with access to the hub can read everyone's
sessions verbatim. Before pooling across people, agree that this is acceptable,
keep the hub tailnet-only, and check `inspect` output before handing a bundle
over. Real multi-tenant use would still need the harder pieces — redaction, auth,
per-user access control — which remain out of scope.
