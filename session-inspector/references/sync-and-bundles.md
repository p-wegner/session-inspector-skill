# Share sessions: session-sync, bundles, hub service

_session-inspector reference. Moved verbatim out of `SKILL.md` on 2026-08-26 so the skill body stays small; commands are run from the skill directory (`node scripts/…`)._

## Share sessions across your machines (session-sync)

The analyzers and fleet tools (`single-session.md`, `fleet-tools.md`) read **local** transcripts. To inspect sessions
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

Every record also carries **`user`** (which human) and **`profile`** (which
`~/.claude-*` auth profile / account) — filter with `--user` / `--profile` on
`sync-query.mjs`, or the dropdowns in the web UI. `--profile` matches as a
substring, so `--profile andrena` selects the whole `andrena_team_5x*` family.

## Hand sessions over as a file: bundles (`session-bundle.mjs`)

Session-sync is the live path between *your* machines. A **bundle** is the
offline form — one zip of selected transcripts plus a manifest — for archiving a
slice, or for **pooling corpora across several people** so compounding-engineering
analysis runs over the whole population rather than one person's sessions.

```powershell
node scripts/session-bundle.mjs export --profile andrena --out team.zip   # from this box's profiles
node scripts/session-bundle.mjs export --from server --days 30 --out last30.zip  # across ALL synced devices
node scripts/session-bundle.mjs export --profile andrena --dry-run        # what would go in
node scripts/session-bundle.mjs inspect team.zip                          # manifest summary, imports nothing
node scripts/session-bundle.mjs import alice.zip --as-user alice          # merge someone else's corpus
```

- **Attribution survives the trip.** `import` stamps every record with the
  bundle's `user` and tags foreign devices as `alice@LAPTOP`, so two people's
  identical hostnames or sessionIds can't overwrite each other. Re-importing the
  same bundle is a no-op (content-hash dedup).
- **Sensitive projects are withheld by default.** Transcripts are raw and
  unredacted, so export drops sessions whose project/cwd matches a deny pattern
  (client work under NDA) and reports what it dropped. The persistent list lives in
  `~/.session-inspector/bundle-deny.txt` (one regex per line, # comments) — outside
  the repo, so client names never appear in this source. `--deny <regex>` /
  `SESSION_BUNDLE_DENY` extend it; `--include-denied` overrides deliberately.
  The manifest records only the *count* withheld, never the project names.
- Filters mirror the query API: `--profile --provider --project --device --user
  --days/--since/--until --limit`. `--format dir` skips the archiver entirely.

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
