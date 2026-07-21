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
  `⛔ HIT USAGE LIMIT (cut off — resumable)` / `⛔ RATE-LIMITED (cut off — resumable)` (the
  session was actually cut off here — its work is probably incomplete and needs continuing),
  `⚠ usage/rate limit mentioned (not terminal)` (a limit was mentioned but the session kept
  working — NOT cut off), `✋ ended on user interrupt`, `🗜 N compactions` (auto-compact fired),
  `⚠ N% tool failures`, and `… ended mid-tool-call`. Plus **peak ctx** (largest single-turn
  context) on the tokens line.

All of these are also in `--json` (`aiTitle`, `firstPrompt`, `lastPrompt`, `compactions`,
`maxContextTokens`, `hitLimit`, `endedOnLimit`, `endedInterrupted`) for scripting. **Two
distinct limit fields:** `endedOnLimit` (`""|"usage-limit"|"rate-limit"`) is the trustworthy
one — the limit banner was the session's **FINAL** assistant message, i.e. it was genuinely
cut off there and is resumable. `hitLimit` is the weak any-mention flag (banner text appeared
*anywhere*), so a session that merely *quotes* or *analyzes* the phrase trips `hitLimit` but
not `endedOnLimit`. Rank/branch on `endedOnLimit`; treat `hitLimit` as a hint only.

**Find & resume a cut-off session in one command** — for the recurring "I got rate-limited,
continue that session" case, don't hand-scan: `node scripts/resumable.mjs` (below) ranks every
cut-off session across all profile homes and prints the exact profile-aware `claude --resume`
command.

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
`--limit N` (last N), `--around <seq> [--context N]` (only events within N seqs of a
moment — the drill-down companion to `--friction` below), `--verbose`/`-v` (full
multi-line text), `--json`. Same flags work on the Codex and Copilot analyzers. In the
**web UI** (session-sync), the detail pane has a **timeline** button with clickable
per-type filter chips + a text filter over the same stream.

### Rank the friction moments in ONE session (`--friction`)

"What was the most frictionful interaction in this session?" is one command — don't
hand-compose error/repeat/user timeline queries. `--friction` (all three analyzers)
ranks the session's concrete friction MOMENTS, most painful first: **interrupts**
(user hit Esc mid-turn), **corrections** (human prompts matching the incidents.mjs
defect lexicon), **error-clusters** (tool errors grouped by proximity, enriched with
the CAUSING call before and the RECOVERY call after — flagging whether the agent
retried the identical call or recovered with a corrected one), and **churn** (the same
non-file tool call issued ≥3×). Each moment prints a ready `--events --around <seq>`
drill-down. This is the per-session counterpart to `incidents.mjs` (which ranks MANY
sessions); use incidents to find the session, `--friction` to find the moment in it.

```powershell
node scripts/analyze-claude-session.mjs <path|sessionId> --friction            # ranked moments
node scripts/analyze-claude-session.mjs --latest --friction --top 5 --json     # machine-readable
node scripts/analyze-claude-session.mjs <path> --events --around 21 --context 6 -v  # zoom into moment @#21
```

When the analyzer isn't enough and you need custom parsing, load the matching **manual recipe file** (PowerShell snippets, loaded on demand):
- `references/claude-recipes.md` — find a session by issue #, quick overview, parse tail, detect "started but never responded", read last message / sent prompt, find by `stop_reason`.
- `references/codex-recipes.md` — Codex `{timestamp,type,payload}` event types, list, parse tail, launch-failure detection, find user messages.
- `references/copilot-recipes.md` — Copilot `events.jsonl` event types, manual parse, workspace correlation, process logs, common-issue symptoms. (Some snippets read an agentic-kanban board API — **optional**, only relevant if you run that board; the local `events.jsonl` path always works.)

**Tip — surface the current session in your statusline.** To make the *current* Claude session one copy-paste away (for inspecting it or handing it to a stronger model mid-task), show its `<project-folder>/<session-id>` locator in the Claude Code statusline. Setup in `references/statusline.md`.

## Recover & continue a cut-off session's SUBAGENTS (`subagent-results.mjs`)

When an orchestrator session spawns `Agent`/`Task` subagents and is then cut off
(usage/rate limit, crash, interrupt), the subagents' work is **stranded** — and
naively resuming re-dispatches them, paying the whole fan-out again. This tool
enumerates every subagent the session dispatched, joins each back to the parent
transcript by its `toolUseId`, and classifies **what actually happened to its
result** so you continue from the real state instead of from zero:

```powershell
node scripts/subagent-results.mjs <path|sessionId|--latest>        # summary table + recovered results
node scripts/subagent-results.mjs <locator> --unresolved           # only the ones needing action
node scripts/subagent-results.mjs <locator> --full                 # full recovered text (no truncation)
node scripts/subagent-results.mjs <locator> --id <agent-id>        # dump ONE subagent's full result/trail
node scripts/subagent-results.mjs <locator> --brief -o cont.md     # write a continuation brief (markdown)
node scripts/subagent-results.mjs <locator> --json                 # machine-readable
```

Subagent transcripts live at `<session-dir>/<sessionId>/subagents/agent-<id>.jsonl`
with a sibling `agent-<id>.meta.json` (`{agentType, description, toolUseId,
spawnDepth}`); `toolUseId` is the join key back to the parent's `Agent` tool_use.
Resolves a bare session id / `projectDir/sessionId` locator / path across all
profile homes, same as the analyzers (`--profile`/`--config-dir` to prefer one).

**The classification and what to do with each** — this is the whole point; the
statuses tell you *not to re-run* when the answer is already on disk:

| Status | Meaning | Action |
|---|---|---|
| ✅ `processed` | Result was delivered **and** a substantive parent turn acted on it | none |
| 📥 `delivered-unprocessed` | Subagent finished; result reached the parent but it was cut off **before adjudicating** (e.g. an async `<task-notification>` at the very tail) | **ACT on the recovered result — do NOT re-run** |
| 📤 `undelivered-complete` | Subagent finished cleanly, but the parent never received it (async still-in-flight at cutoff) | **RE-INJECT the recovered result** |
| ⚠️ `delivered-partial` / ⛔ `self-cutoff` | Subagent hit **its own** limit mid-work (shared-account limits cut parent *and* children together) — only a partial trail exists | **CONTINUE / RE-RUN from the partial trail** (not from scratch) |

**The async trap it handles for you:** a background agent's *immediate*
tool_result is only the `Async agent launched successfully` ACK — the real
result arrives later as a `<task-notification>` user message. A "is there a
tool_result for this id?" check therefore lies (everything looks delivered). This
tool distinguishes ack → delivery (sync tool_result **or** notification) →
whether a real assistant turn followed, and reads each subagent's own transcript
to tell a clean finish (`end_turn`) from a self-cutoff (trailing limit banner).

Pair it with the resume flow: run this **first** on a cut-off orchestrator to
harvest any recoverable subagent output, feed the `--brief` into the continuation,
and only re-run the subagents this tool marks `self-cutoff`/`delivered-partial`.
The single-session analyzer (`--friction`, `--events`) explains where the *parent*
stopped; this explains where its *children* stopped and which of their outputs
survive.

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

> ### ⚠️ Confidentiality rules for the `modify` workflow (MANDATORY)
> When the user asks you to **modify / edit / redact / rewrite** a session, the
> whole point is usually that the content is sensitive (a pasted secret, a
> misleading prompt, a poisoned message). So the modification must NOT bleed back
> into *this* conversation's transcript. Follow these two rules exactly:
>
> 1. **The output must not show the modifications.** Always apply with
>    **`--quiet`**, which suppresses the before/after text and prints only counts
>    (`#seq kind (+N chars) [text hidden]`) plus the confirmation. Do **not** run
>    `apply --dry-run` without `--quiet` (its diff echoes the edited text), and do
>    **not** paste, quote, summarize, or otherwise restate what the edit changed —
>    not the old text, not the new text. Report only *that* it was applied and how
>    many blocks changed. To preview safely, use `apply --dry-run --quiet`.
> 2. **Do not read the file afterward.** After applying, you are **not allowed to
>    Read / Get-Content / grep / cat the transcript `.jsonl`, the `edits.md`, or any
>    `.bak-*` backup** to "verify" the result — that would pull the redacted/edited
>    content straight back into context. `apply` already fails loudly if a write
>    doesn't land (atomic tmp+rename, block-level guards), so its exit code and
>    `Applied N change(s)` line are your confirmation. Trust them; don't re-open the
>    file.
>
> The confidential apply is therefore a single command:
> ```powershell
> node scripts/session-edit.mjs apply edits.md --quiet
> ```

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
diff without touching disk. `--quiet` hides the edited text everywhere (before/after
lines become `[text hidden]`), leaving only per-block counts and the confirmation —
this is what the confidential `modify` workflow above uses, and it composes with
`--dry-run` (`--dry-run --quiet` = a preview that never echoes content). A round-trip
with no edits always reports **0 changes**, so an untouched `apply` is a no-op. Body
lines that look like a `@@@` header are dot-stuffed on extract and unescaped on apply
— message text can safely contain the delimiter.

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

> **If the cut-off session dispatched subagents, run `subagent-results.mjs`
> first** (section above). Resuming re-dispatches the whole fan-out; that tool
> tells you which subagent outputs already survive on disk (act on / re-inject
> them) versus which were themselves cut off and must actually be re-run — so the
> continuation doesn't pay for work that's already done.

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

This skill debugs **one** session. For **aggregate, time-scoped questions across MANY sessions** — "which tools fail most in the last 48h", "what's burning tokens", "what did I ask yesterday", "how did this batch of build-out sessions behave and which stack was cleaner" — do **not** loop the per-session recipes. Use the bundled standalone fan-out scripts (they stat-filter by mtime FIRST, then parse only in-window files).

> **Fleet inspection is a first-class use case.** When the question is about a *batch* of sessions — a build-out, a sprint of tickets, a parallel fleet of builders — start with `fleet-stats.mjs` (distributions + outliers + `--by` comparison) and follow the ordered workflow, metric guide, and **predefined suggestion-category taxonomy** in **`references/fleet-inspection.md`**. That reference is the playbook for turning a fleet scan into ranked, correctly-filed improvement suggestions (generic → per-stack → compounding board features).
>
> **Do not headline cache-read as the cost.** In a multi-turn agentic workflow the raw token volume is cache-read-dominated *by construction* (every turn re-sends the prefix) — that's a tautology, not a finding. Report the things that actually vary: agent turns, peak context, sudden-growth spikes, tool-fail rate, and per-group deltas. `token-sinks.mjs` already prices cache-read in.

```powershell
node scripts/fleet-stats.mjs      # FLEET SHAPE + COMPARISON — turns/context/duration/fail distributions, sudden-growth & outlier lists, --by stack|project|model|day comparison table (--project, --days, --top, --json)
node scripts/token-sinks.mjs      # biggest token/cost sinks (--by project|day|model|provider|session, --days N, --json)
node scripts/tool-failures.mjs    # failed tool calls ranked (--by tool|project|error|day, --sort rate, --json)
node scripts/user-prompts.mjs     # real human-typed prompts (--date, --today, --days N, --tree, --json)
node scripts/prompt-style.mjs     # PROMPTING-STYLE profile (--project, --provider, --days N, --samples N, --json)
node scripts/incidents.mjs        # FRICTION ranking — which sessions to investigate (--project, --lens, --grep, --top, --json)
node scripts/resumable.mjs        # CUT-OFF sessions to RESUME (rate/usage-limited) + exact resume cmd (--project, --cwd, --days, --latest, --resume, --interrupted, --json)
node scripts/waste.mjs            # CONTEXT-TOKEN waste — where tokens go + what's avoidable (--project, --days, --top, --json)
node scripts/skill-usage.mjs      # SKILL audit — which .claude/.codex skills never fire (--project <substr>|--cwd, --repo-only, --cost, --days N, --provider, --include-plugins, --unused-only, --json)
node scripts/context-growth.mjs   # CONTEXT growth + auto-compacts + long-context (>200k) tax (--project, --session, --days, --threshold, --json)
node scripts/cold-cache.mjs       # COLD-CACHE tax — $ burned re-writing an expired prefix after idle/resume (--project, --cwd, --days, --gap, --session, --min-premium, --json)
node scripts/context-spikes.mjs   # CONTEXT SPIKES — the single injections that bloat context + WHY (huge-file/verbose/log-wall/…) + fix (--project, --cwd, --days, --min, --by class|tool|file, --session, --json)
node scripts/slash-goals.mjs      # SLASH-command usage + skill invocations + per-session goals (--project, --days, --top, --json)
node scripts/quota-report.mjs     # SUBSCRIPTION quota report for ONE profile since its weekly reset → terminal / --json / --html dashboard (--profile <name>, --config-dir, --since <ISO>, --no-auto-reset, --tz N)
node scripts/quota-multi.mjs      # ALL profiles × ALL weekly windows + COMBINED total → one switchable --html dashboard (--profiles a,b, --tz N, --max-windows N, --json)
node scripts/tool-friction.mjs    # TOOLING-IMPROVEMENT candidates — recurring cross-session command CHAINS to fuse/fix (--project, --grep, --n 2,3, --min-sessions, --json)
```

`fleet-stats.mjs` answers **"how did this batch of sessions behave, and which
group was faster / cheaper / cleaner?"** — the orientation pass for any fleet
question. It reports per-session **distributions** (agent turns, wall-clock
duration, peak context, tool-fail rate — mean/median/p90/max), the **outlier
lists** that break the pattern (biggest single-turn context jump = "sudden
growth", longest context, most turns, worst fail rate, most re-runs, cut-offs),
and — with `--by stack|project|model|day` — a **comparison table** (median
turns/duration/context, fail%, re-runs, cut-offs, median+total cost per group)
so "the Kotlin build-out took more turns and had a 2× fail rate vs the TS one"
falls straight out. **`--by stack` is the robust axis for parallel build-outs**:
cleaned worktrees lose their git remote so `--by project` can't separate them,
but the stack is stamped on every command (`lib/stack.mjs`). Deliberately not a
cost report — it surfaces the SHAPE and the group deltas, not the (tautological)
cache-read total. Claude only (per-turn `usage`). Pairs with
`context-spikes.mjs` (explain a sudden-growth outlier) and the taxonomy in
`references/fleet-inspection.md`.

`tool-friction.mjs` answers **"what should we change in the tools
themselves, not in how we prompt?"** — it's the fleet tool for a use case
beyond debugging one session or ranking pain: mining MANY sessions for
recurring ordered chains of *different* commands (e.g. `grep → cd`,
`git status → git add`, `grep → npm run coverage:check`), each a candidate
for a combined verb, a changed default, a preflight guard, or a batch mode.
This is distinct from `repeatedCommands`/`incidents.mjs`'s `reruns` (the same
command re-run in one session — a failure/retry signal); a chain recurring
across MANY sessions is a friction signal from the **tool's own shape**. Full
strategy catalog (8 named patterns, worked examples, and a
detect→validate→prototype→re-measure workflow) in
`references/tooling-improvement.md`.

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

`resumable.mjs` answers **"I got rate-limited — which session was that, and how
do I continue it?"** — the common case where a usage/rate limit (or an interrupt)
kills a session mid-task and you come back later to pick it up. It scans every
Claude profile home, keeps only sessions whose ending is a genuine cut-off
(`endedOnLimit` — the limit banner as the **final** message, so a session that
merely *mentioned* a limit is excluded), ranks them by severity then recency, and
for each prints the **goal**, the **last human ask**, and a ready-to-run,
profile-aware resume command (`cd <cwd> && CLAUDE_CONFIG_DIR=<home> claude --resume
<id>` — the `CLAUDE_CONFIG_DIR` matters because the session lives under a specific
`.claude[-suffix]` home and resuming under the wrong profile won't find it). Scope
with `--project <substr>` or `--cwd` (only this directory's sessions), widen the
window with `--days N` (default 7). `--latest` prints just the top hit; `--resume`
prints *only* the command (pipe/eval it); `--interrupted` also includes
user-interrupted sessions; `--all-endings` lists normal-ending sessions too. The
discovery half of the resume loop — `analyze-claude-session.mjs <path> --events -v`
is the explain half when you want to see exactly where it stopped first. Claude only.

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
**Repo-scoped audit** — to answer "which of **this** repo's skills are dead weight
/ badly described?" rather than the fleet-wide question, add `--project <substr>`
(or `--cwd` for the current repo). It scopes **both** the session set **and** the
project-skill universe to that one repo — so a Rails app's audit no longer drags
in a sibling project's `.claude/skills`, and `avail` becomes "*this repo's*
sessions since the skill existed". Matching is separator-normalized, so
`--project shift-app` hits both the hyphenated Claude session folder
(`C--…-shift-app`) and the underscored repo path (`…\shift_app`) — a mismatch that
otherwise silently discovers zero project skills. Add `--repo-only` to report just
the skills **defined in** the matched repo (dropping user-level globals) — the
exact *skills-in-repo × sessions-in-repo* intersection. The most actionable signal
this surfaces is **loaded-only** skills (weak>0, strong=0 over hundreds of matched
sessions): present and paying context tax, but no agent ever fired them — a sign
the skill is redundant *here* or its description doesn't match how work is framed
(e.g. shift_app's generic `playwright-test-{planner,generator,healer}` never fire
because the repo's e2e flow goes through `e2e-coverage-lean`/`e2e-test-author`).
**Token tax** — add `--cost` to weight each dead/loaded-only skill by what it
actually costs, because a dead *small* skill is cheap and a dead *large* one is
real waste. It shells out to the `token-budget` skill's `tokt.js skill --json`
(one subprocess per reported skill; opt-in) and reports the progressive-disclosure
tiers the way an agent pays for them: **t0 = alwaysOn** (name+description, in the
system prompt *every turn of every session* whether or not the skill fires) and
**inv = onInvoke** (the SKILL.md body, loaded only when it triggers). The dead and
loaded-only buckets are then ranked by tax (`waste ≈ t0 × avail` — a per-session
lower bound on the always-on tokens paid while it never earned an invocation), and
a headline sums the always-on tax of all never-invoked skills. `tokt.js` is located
via `$TOKT_BIN`, the sibling `token-budget` skill (junctioned next to this one), or
the known repo/profile paths; if none exist, `--cost` degrades to a one-line notice
and the rest of the audit runs unchanged.

`quota-report.mjs` answers **"what did my subscription do this billing week?"** —
it scopes to ONE profile (`--profile <name>` ⇒ `~/.claude-<name>`, or
`--config-dir <path>`) and, unlike `token-sinks.mjs` (which stat-filters whole
FILES by mtime), filters **per turn** by the turn's own timestamp, so a session
straddling the cutoff contributes only its post-cutoff turns. The default cutoff
is the profile's **last weekly reset**, which it **auto-detects per profile** —
different accounts anchor their weekly window on different weekday+times. It reads
the profile's own `"You've hit your weekly limit · resets …"` banners (the
`resets Jul 17, 12pm` / `resets 6am` forms), derives the reset weekday+clock in
Europe/Berlin, and steps back in 7-day multiples to the most recent boundary
at/before now (e.g. `andrena_team_5x` → Tue 6am, `andrena_team_5x_2` → Fri 12pm).
Override the cutoff with `--since <ISO>`, disable detection with
`--no-auto-reset` (falls back to Fri 12:00 Berlin), and set the UTC offset with
`--tz N` (default 2 = CEST). The detected schedule + the banner it came from are
shown in the dashboard's verification callout and in `meta.resetInfo`. **Subagent transcripts are
included** (`<session>/subagents/agent-*.jsonl`) because they hit the API and burn
the same quota. It reports totals (sessions, subagents, assistant turns, tool
calls + errors, tokens, est. USD "subscription value" at pay-go rates), and
breakdowns by model / project / day / hour-of-day (localized) / tool / top
sessions, plus a **usage-limit banner timeline** (collapsed to distinct messages
with a repeat count) that doubles as evidence for the reset window. `--json` for
the full blob; `--html <file>` writes a **self-contained, theme-aware dashboard**
(inline SVG charts, no external assets) you open locally. Cost model matches
`token-sinks.mjs`. Claude only. Example:
`node scripts/quota-report.mjs --profile andrena_team_5x_2 --html quota.html`.

`quota-multi.mjs` is the **"complete picture"** companion to `quota-report.mjs`:
one self-contained, switchable dashboard covering **every** `andrena_team_5x*`
profile (or `--profiles a,b,…`), **every weekly reset window per profile**, plus
a **Combined grand total** across all profiles. It parses each transcript ONCE
(shared core in `lib/quota.mjs` — pricing, per-turn event parse, banner scan,
`detectWeeklyReset`, `weeklyWindows`, `aggregate`) and slices each window in
memory. Per profile it auto-detects the weekly anchor and generates weekly
windows across that profile's data; profiles with **no weekly-limit banner yet**
(only 5-hour session limits) are honestly flagged "anchor unknown" and shown as a
single span. The **Combined** scope sums everything and breaks down **by profile**
(windows are per-profile because each account resets on a different weekday, so
Combined is a total, not a synchronized window). The HTML has a profile tab row
(each with its total value) + per-profile window chips (`Profile total` + one per
week); each view renders KPIs, token composition, value-by-day, hour-of-day, by
model/project(/profile), tool table, top sessions, and a usage-limit timeline.
`lib/quota.mjs` is the single source of truth for the accounting; reuse it for any
new cross-profile quota view. Example:
`node scripts/quota-multi.mjs --html quota-all.html`.

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

**Cost-optimization loop** — these five compose into one workflow: `token-sinks.mjs`
(what did it cost, where) → `context-growth.mjs` (what SHAPE ran it up) → then the
two levers: `cold-cache.mjs` (idle/resume waste — a *timing* fix: keep sessions
warm, `/compact` or finish before a break) and `context-spikes.mjs` + `waste.mjs`
(injection waste — a *representation* fix: ranged reads, quiet flags, log levels,
jq-select at the source). Scope any of them to one repo with `--project <substr>`
or `--cwd` and a `--days` window.

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

**Resolving a session by id is cross-profile by default — `--profile` is a
preference, never a filter.** Because rate limits force frequent mid-work profile
switches, a session id (or `projectDir/sessionId` locator) is *usually* NOT under
your current profile. So `analyze-claude-session.mjs <id>` and `session-edit.mjs
--session <id>` **always search every sibling home** and resolve the (globally
unique) id wherever it lives; passing `--profile`/`--config-dir` only floats that
home's matches first. When a match resolves from a *different* profile than the one
named, both scripts print a one-line `ℹ … (profile switch)` note so the switch is
visible. Don't pre-`find` the `.jsonl` path or guess the profile — just pass the id.

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
