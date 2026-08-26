# One session: analyzers, --events, --friction, --handoff, subagent-results

_session-inspector reference. Moved verbatim out of `SKILL.md` on 2026-08-26 so the skill body stays small; commands are run from the skill directory (`node scripts/…`)._

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
continue that session" case, don't hand-scan: `node scripts/resumable.mjs` (`resume-and-handoff.md`) ranks every
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

### Continue a cut-off session's MACHINE state (`--handoff`)

**Run this FIRST when asked to continue a cut-off session.** The summary explains
what happened; `--handoff` (Claude analyzer only) surfaces what the session left
RUNNING or PARKED on the machine — the load-bearing state a continuation needs
and the at-a-glance panel can't show:

- **Background / detached processes** — every `run_in_background` shell call and
  every detach-shaped command (`Start-Process`, `nohup`, `start /b`,
  `-WindowStyle Hidden`), with the log paths named in the command. A detached
  driver often *finished the work after the cut-off*: read its log before
  re-doing anything.
- **Monitors armed** — each Monitor call's description + watched paths; the
  watched file holds the outcome the session never got to read.
- **The session's TEMP scratchpad** — path, file count, size, newest mtime, plus
  the files the session Write/Edit-ed there. This is OS-clearable storage;
  **salvage anything load-bearing into a durable location first** (measured case:
  the only surviving copy of a deleted run's synthesis returns lived there).
- **Local services touched** (`127.0.0.1:<port>` hit counts), the last
  **TodoWrite snapshot**, **TaskCreate** subjects, the tail **task notifications**
  (delivered results nobody adjudicated), and the **subagent count** with the
  exact `subagent-results.mjs` command.
- Ends with the **last substantive assistant update** — the newest non-banner
  text, i.e. where the narrative actually stopped.

```powershell
node scripts/analyze-claude-session.mjs <path|sessionId> --handoff          # panel
node scripts/analyze-claude-session.mjs <sessionId> --handoff --json       # machine-readable
```

Pairs with `subagent-results.mjs` (children's results) and `resumable.mjs`
(which session to continue): resumable → handoff → subagent-results is the full
"pick a cut-off orchestrator back up" sequence.

When the analyzer isn't enough and you need custom parsing, load the matching **manual recipe file** (PowerShell snippets, loaded on demand):
- `references/claude-recipes.md` — find a session by issue #, quick overview, parse tail, detect "started but never responded", read last message / sent prompt, find by `stop_reason`.
- `references/codex-recipes.md` — Codex `{timestamp,type,payload}` event types, list, parse tail, launch-failure detection, find user messages.
- `references/copilot-recipes.md` — Copilot `events.jsonl` event types, manual parse, workspace correlation, process logs, common-issue symptoms. (Some snippets read an agentic-kanban board API — **optional**, only relevant if you run that board; the local `events.jsonl` path always works.)

**Tip — surface the current session in your statusline.** To make the *current* Claude session one copy-paste away (for inspecting it or handing it to a stronger model mid-task), show its `<session-id>/<project-folder>` locator in the Claude Code statusline — id FIRST, so a narrow terminal truncates the folder rather than the key, and 8 hex digits is enough to resolve. Setup in `references/statusline.md`.

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
Resolves a bare session id (or id *prefix*) / a two-part locator in either order
(`sessionId/projectDir` or `projectDir/sessionId` — Claude's own on-disk layout,
where the id half is the **full** uuid because that is the transcript filename) /
an **ACP agent name** (`projectSlug--sid8`, which is what the status line now
shows — see `statusline.md`) / a path, across all profile homes, same as the analyzers
(`--profile`/`--config-dir` to prefer one). The folder half is a tiebreak, never a
filter, so a shortened or stale folder can't hide a valid id.

**Paste whatever you have.** The status line prints the compact
`🔖 <sid8>/<slug>` form (since 2026-08-21 both halves are split out of the name the
ACP hook registered, so the two agree); `acp list` and the bus itself use the full
`C--projects-andrena-acp--869f8e8a`. Both resolve here. The ACP shape is tried only
as a **fallback**, after the ordinary parse finds nothing, so no locator that worked
before can change meaning — in particular a bare project-folder name
(`C--projects-andrena-acp`, doubled dashes and all) is still read as a folder, not
split into an id. `splitAcpAgentName` / `locatorCandidates` in `lib/sessions.mjs`;
covered by `scripts/test/locator.test.mjs`.

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
