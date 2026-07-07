---
name: session-inspector
description: Inspect and edit agent session transcripts from Claude (~/.claude/projects/), Codex (~/.codex/sessions/), or Copilot (~/.copilot/) — debug why sessions stopped, what they did, and whether they produced output; or rewrite the user/assistant messages of a Claude session in place. ALWAYS use this — never hand-read, grep, or hand-patch transcript .jsonl files directly — whenever asked about a specific session by id/path, "what was session X doing", or to edit/fix/rewrite what was said in a session. Self-contained — bundles its own analyzer scripts.
argument-hint: [issue-number, keyword, --codex <path>, --copilot, edit]
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

### AT A GLANCE — what's interesting about a session (Claude)

The Claude summary leads with an **at-a-glance panel** so you can triage a session
in one look without reading the transcript — designed for the "was this session's
work finished, and what was it even trying to do?" question:

- **Goal** — the agent-generated session title (`aiTitle`), i.e. the objective in a phrase.
- **First ask / Last ask** — the human's first and most recent real prompts, run through
  the same `classify()` filter the fleet tools use, so injected skill preambles
  (`Base directory for this skill:`), continuation handoffs, and slash-UI noise never
  masquerade as the human's intent.
- **Signals** — a one-line health verdict flagging the things you'd want to know:
  `⛔ HIT USAGE LIMIT (work likely unfinished)` / `⛔ RATE-LIMITED` (the session was cut
  off — its work is probably incomplete and needs continuing), `✋ ended on user interrupt`,
  `🗜 N compactions` (auto-compact fired), `⚠ N% tool failures`, and
  `… ended mid-tool-call`. Plus **peak ctx** (largest single-turn context) on the tokens line.

All of these are also in `--json` (`aiTitle`, `firstPrompt`, `lastPrompt`, `compactions`,
`maxContextTokens`, `hitLimit`, `endedInterrupted`) for scripting. The `hitLimit` flag keys
on assistant-authored text ("you've hit your session limit"), so a session that merely
*quotes* that phrase (e.g. one analyzing other sessions) can read as a limit hit — treat
it as a strong hint, not proof.

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

## Edit a session's user/assistant messages (`session-edit.mjs`)

The analyzers above are read-only. To **change what a session says** — fix a
misleading prompt before handing the transcript to a stronger model, redact a
secret you pasted, correct an assistant message that poisoned the rest of the
run — use `scripts/session-edit.mjs`. Raw `.jsonl` is far too noisy to hand-edit
(one line per content block, escaped JSON, uuid chains), so this is a **two-phase
extract → edit-in-your-editor → apply** flow. Claude transcripts only.

```powershell
node scripts/session-edit.mjs extract --latest -o edits.md    # 1. flatten to a readable file
#  … open edits.md in your editor, change the text under any [edit] header …
node scripts/session-edit.mjs apply edits.md --dry-run        # 2. preview the diff
node scripts/session-edit.mjs apply edits.md                  # 3. write it back, in place
```

`extract` takes `<path.jsonl>`, `--latest`, or `--session <id-prefix>`, plus the
same `--profile <name>` / `--config-dir <path>` resolution the analyzers use.

**The extracted format.** One `@@@ <seq> <kind> <uuid>#<blockIndex> [edit|read-only]`
header per block, body underneath:

```
@@@ 4 user d5109c08-…#0 [edit]
unzip all files in this folder, dedupe images…

@@@ 5 assistant.thinking 20683a7e-…#0 [read-only]
Let me check what's in the folder first…
… [truncated, 12 more line(s)]

@@@ 6 assistant.tool_use:Bash 9e7730b0-…#0 [read-only]
{ "command": "ls -la" }
```

**What's editable.** By default only human prompts (`user`) and assistant `text`
blocks. `thinking`, `tool_use`, and `tool_result` blocks are emitted as
**truncated `[read-only]` context** — they're there so you edit with the
conversation in view, and their bodies are never written back. Widen the scope
with `--include-thinking` / `--include-tool-results` (tool_result payloads are
huge; prefer targeting them one session at a time).

**It never deletes or reorders lines.** Text is rewritten in place, so `uuid` /
`parentUuid` stay intact and `claude --resume <id>` still walks the transcript.
Only the edited lines are re-serialized; every other byte passes through
untouched, and key order within a line is preserved.

**Guard rails** (all fire before anything is written):
- **block-level conflict detection** — the edit file records a sha256 of the whole
  transcript *and* an `h=<hash>` of each editable block's original text. A session
  routinely flushes a final turn on exit, so a whole-file mismatch alone means
  little. `apply` therefore asks the narrower question: *did a block **you edited**
  change?* If not, it applies and prints a note (appended turns are preserved,
  since blocks are addressed by `uuid`, not line offset). If yes — the block was
  rewritten, or has vanished — it refuses and names the blocks (re-extract to
  rebase, or `--force`). v1 edit files have no per-block hashes and keep the old
  strict refusal.
- **live-session guard** — refuses a source modified in the last 120s, since a running agent could append a turn between the read and the write. Exit that session first, or `--force`.
- **backup** — copies to `<transcript>.jsonl.bak-<timestamp>` before writing (`--no-backup` to skip); the write itself is atomic (tmp + rename).

`--dry-run` bypasses the guards with a warning and prints a per-block before/after
diff without touching disk. A round-trip with no edits always reports **0 changes**,
so an untouched `apply` is a no-op. Body lines that look like a `@@@` header are
dot-stuffed on extract and unescaped on apply — message text can safely contain
the delimiter.

**Editing the session you're currently in won't work** the way you'd hope: the
live agent holds the transcript open and rewrites it on every turn, so your edits
are overwritten. Edit a *finished* session, then `claude --resume` it.

## Resume sessions after a crash / reboot / rate-limit

When a batch of sessions dies at once (hard reboot, power loss) or a session is
cut off by a Claude usage limit, `scripts/session-resume.mjs` turns "what was I
running and how do I pick it back up" into one command. It classifies each
session and decides — per a simple rule — whether to **resume in place** or
**start fresh from a written handoff brief**, then prints the exact launch
command (or opens a dedicated Windows Terminal tab per session).

```powershell
# Plan the most recent crash cluster (auto-detects the near-simultaneous kill):
node scripts/session-resume.mjs --profile andrena_team_5x --project papershift --reboot

node scripts/session-resume.mjs --profile <name> --between 16:45-17:30   # scope by wall-clock window
node scripts/session-resume.mjs --profile <name> --rate-limited          # only usage/rate-limit cutoffs
node scripts/session-resume.mjs ... --write-briefs <dir>                 # write <id8>.brief.md handoffs
node scripts/session-resume.mjs ... --print-commands                     # just the wt launch lines
node scripts/session-resume.mjs ... --launch resume                      # spawn WT tabs: RESUME/CONTINUE only
node scripts/session-resume.mjs ... --launch all                         # also open FRESH tabs (seeded w/ brief)
```

**Profile-aware:** reads transcripts from the chosen auth profile via
`--profile <name>` (⇒ `~/.claude-<name>`), `--config-dir <path>`, or
`$CLAUDE_CONFIG_DIR` (default `~/.claude`). The same `--profile`/`--config-dir`
flags now also work on `analyze-claude-session.mjs --list`/`--latest`, so those
see non-default profiles instead of only `~/.claude`.

**Decision rule** (tunable via `--fresh-age`/`--short-turns`/`--short-min`):
rate-limited → **CONTINUE** (resume + handoff); last activity < 60m → **RESUME**
(context warm); short session → **RESUME** (cheap to reload even if old); old &
long → **FRESH** (a brief + new session beats reloading a huge stale context);
cleanly-finished → **DONE** (skipped unless `--include-completed`).

**Crash detection** (`--reboot`): a hard reboot kills several live sessions
within seconds, so it picks the *tightest, largest* end-time cluster — not just
the newest session (work that resumed after the crash is newer but isolated).
The currently-live session is excluded by default (`--include-live` to keep it).

**Same auth profile is guaranteed (vital):** a session is relaunched under the
exact profile it originally ran in — derived from the transcript's own file path
(`<profile>/projects/…`), which is ground truth since Claude writes transcripts to
`$CLAUDE_CONFIG_DIR/projects` at runtime. `claude --resume <id>` resolves the
session from `CLAUDE_CONFIG_DIR`, so a wrong profile silently fails to find it. The
launcher sets `CLAUDE_CONFIG_DIR` per session and the report/JSON show `profile:…`;
a mismatch prints red and (without an override) the tool refuses to guess. Override
deliberately with `--launch-profile <name>` / `--launch-config-dir <path>` — it
warns loudly, since resume then fails for sessions not in that profile.

**Permission mode is inherited:** each session's `permissionMode` is read from its
transcript (last value wins) and mapped back to the launch flag — so a session that
ran with `--dangerously-skip-permissions` (`bypassPermissions`) relaunches the same
way, `acceptEdits`/`plan` map to `--permission-mode …`, and `default` gets none.
Force it with `--skip-perms` / `--safe-perms`.

**Briefs** capture goal, last instruction, where it left off, open todos/tasks
(pulled from `TodoWrite`/`Task*` calls), the last error, and a **reboot warning**
when a session was parked waiting on a background job the crash killed (re-run
it — don't wait for a notification that will never come). FRESH tabs launch
`claude` seeded with a prompt pointing at the brief; RESUME tabs run
`claude --resume <id>` with the profile's `CLAUDE_CONFIG_DIR` set. `--json` for
the machine-readable plan.

## Per-session vs fleet (aggregate across MANY sessions)

This skill debugs **one** session. For **aggregate, time-scoped questions across MANY sessions** — "which tools fail most in the last 48h", "what's burning tokens", "what did I ask yesterday" — do **not** loop the per-session recipes. Use the bundled standalone fan-out scripts (they stat-filter by mtime FIRST, then parse only in-window files):

```powershell
node scripts/token-sinks.mjs      # biggest token/cost sinks (--by project|day|model|provider|session, --days N, --json)
node scripts/tool-failures.mjs    # failed tool calls ranked (--by tool|project|error|day, --sort rate, --json)
node scripts/user-prompts.mjs     # real human-typed prompts (--date, --today, --days N, --tree, --json)
node scripts/prompt-style.mjs     # PROMPTING-STYLE profile (--project, --provider, --days N, --samples N, --json)
node scripts/incidents.mjs        # FRICTION ranking — which sessions to investigate (--project, --lens, --grep, --top, --json)
node scripts/waste.mjs            # CONTEXT-TOKEN waste — where tokens go + what's avoidable (--project, --days, --top, --json)
node scripts/skill-usage.mjs      # SKILL audit — which .claude/.codex skills never fire (--days N, --provider, --include-plugins, --unused-only, --json)
node scripts/context-growth.mjs   # CONTEXT growth + auto-compacts + long-context (>200k) tax (--project, --session, --days, --threshold, --json)
node scripts/slash-goals.mjs      # SLASH-command usage + skill invocations + per-session goals (--project, --days, --top, --json)
```

`waste.mjs` answers **"what cost unnecessary tokens?"** — it attributes each
session's content to buckets (tool_result by tool, Write/Edit args, user
prompts/pastes, …) weighted by **persistence** (tokens × turns-survived, because
cost is cache-read dominated — an early dump is re-billed every later turn), then
flags the avoidable waste: **re-reading a file already in context**, repeated
identical Bash output, and **node_modules leaking into Glob/Read**. Companion to
`token-sinks.mjs` (which gives the billing total); this explains what ran it up.
Claude transcripts only; chars/4 token estimate (≈1.5% of exact tiktoken).

`incidents.mjs` answers **"which sessions are worth learning from?"** — it ranks
the fleet by friction (human course-corrections matching a defect lexicon,
repeated near-identical complaints, failed tools, wasted command re-runs, and
image-**regeneration churn**) so you deep-dive the few sessions that hit a wall
instead of reading them all. Swap the lexicon with `--lens general|visual|image`
(visual = overlap/cropped/chrome/aspect…; image = crop/aspect/regenerate/refusal…),
narrow with `--project`/`--grep`/`--days`, then it prints the exact
`analyze-*-session.mjs … --events --grep` command to explain the top hit. It's
the discovery half of the loop; the single-session analyzers are the explain half.

`skill-usage.mjs` answers **"which of my agent skills never get triggered?"** —
it discovers every skill on disk (`~/.claude/skills`, `~/.codex/skills`,
`~/.copilot/skills`, and each repo's `.claude/.codex/skills` reached via session
cwds + `--project-dir`; plugins are opt-in via `--include-plugins`) and cross-
references each against every transcript. It separates a **strong** trigger (an
agent explicitly fired it: Claude `Skill` tool, a `/slash`, or a Copilot skill
field) from a **weak** one (the `SKILL.md` body was merely loaded/read — the only
signal Codex emits). This split matters because skill **materialization** inflates
weak counts: the kanban board copies its built-in skills into every worktree's
`.claude/skills`, so their path appears in thousands of sessions even though no
agent ever invokes them (those are server-triggered, not agent-triggered). The
report buckets skills into **dead** (never invoked but **was available**),
**too-new** (created after ~all scanned sessions — no fair chance to fire),
**loaded-only** (strong=0, present but never agent-invoked), and **agent-invoked**,
plus an orphan list of names triggered in logs with no SKILL.md on disk.
Availability is the fair denominator: a skill's `git` first-add date vs each
session's time gives `avail` = sessions that ran *after* it existed, so a skill
written last week isn't wrongly called dead. Board-independent (no DB). The
git-history pass only runs for never-strong-invoked skills; narrow with `--days`
for a fast windowed audit (`--no-git` skips creation-time entirely).

`prompt-style.mjs` answers "how do I talk to the agent?" — it aggregates every
real human prompt into a length distribution, tone/format signals (lowercase
start %, question %, terse one-liners %, approval-only %, German/umlaut %, …),
opening-word frequencies, and representative samples. Scope it with
`--project <substr>` (matches the Claude projects-dir folder, the session cwd,
or the git remote), `--provider`, and `--days N`; run bare for an all-time,
all-projects profile (with a busiest-projects breakdown). It shares the
human-vs-noise `classify()` filter with `user-prompts.mjs` (both live in
`scripts/lib/prompts.mjs`), so the two tools always agree on what a prompt is.

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

`slash-goals.mjs` answers **"what was the agent asked to do, and how?"** — per
session it surfaces the **goal** (custom title → ai-title → slug → first typed
prompt, sorted by turns so marathon sessions lead), the **slash commands** the
human invoked (flagging session-hygiene ones — `/clear`, `/compact`, `/model` —
whose *absence* explains runaway context), and the **skill invocations** the
agent fired. Goals give intent, slash gives hygiene, skills give mechanism
(a brainstorming → writing-plans → subagent-driven-development workflow
front-loads big design docs and spawns result-dumping Agents — often the *cause*
of the growth `context-growth.mjs` measures). Claude only.

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

## Multiple Claude homes (profiles / teams) — sibling `.claude-*` dirs

Claude Code reads its config dir from `CLAUDE_CONFIG_DIR`; unset, it defaults to
`~/.claude`. Parallel/team setups run with a **per-profile config dir that is a
sibling** of `~/.claude` — e.g. `~/.claude-andrena_team_5x` — so those sessions
land under `~/.claude-<suffix>/projects/…`, **invisible to any tool that hard-codes
`~/.claude/projects`**. If a session you know exists doesn't show up, this is almost
always why.

Every Claude-reading script now discovers **all** of these via
`claudeProjectDirs()` (`scripts/lib/config.mjs`), which returns, deduped:
1. `$CLAUDE_PROJECT_DIRS` — explicit `;`/`:`-separated list (bypasses discovery; use for a mounted/synced copy)
2. `$CLAUDE_CONFIG_DIR/projects` and `$CLAUDE_HOME/projects` — the active profile
3. `~/.claude/projects` **plus every `~/.claude-<suffix>` / `~/.claude_<suffix>` sibling home**

In `--list`, when more than one home exists the dir label is prefixed with the home
tag (`.claude-andrena_team_5x/C--projects-…`) so identically-named project dirs across
profiles stay distinguishable. Codex (`~/.codex`) and Copilot (`~/.copilot`) are
single-home and unaffected.

## Directory naming convention (Claude)

Each working directory maps to a session dir by replacing path separators with `--`:
- `C:\andrena\.worktrees\feature_ak-17-...` → `C--andrena--worktrees-feature-ak-17-...`
- `C:\andrena\agentic-kanban\packages\.worktrees\feature_ak-N-...` → `C--andrena-agentic-kanban-packages--worktrees-feature-ak-N-...`

Multiple `.jsonl` files in one dir = multiple sessions (e.g. original run + re-launched review). Sort by `LastWriteTime` descending to find the latest.

Subagent transcripts live under `<session-dir>/<session-id>/subagents/agent-<id>.jsonl`
and are prefixed `agent-` — pass the full filename to the analyzer (dropping the prefix
gives ENOENT).

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
