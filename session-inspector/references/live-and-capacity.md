# Live sessions (live.mjs) and subagent capacity (fleet capacity)

_session-inspector reference. Moved verbatim out of `SKILL.md` on 2026-08-26 so the skill body stays small; commands are run from the skill directory (`node scripts/…`)._

## Live sessions — who is running RIGHT NOW (`live.mjs`)

Everything else in this skill is post-hoc: it reads transcripts of sessions that
already happened. `live.mjs` answers the *present-tense* question — which Claude
processes exist this second, and is each one working or waiting on a human.

```bash
node scripts/live.mjs              # human table
node scripts/live.mjs --json       # machine-readable
node scripts/live.mjs --watch      # redraw every 2s
```

The source is a store most tooling does not know exists:

```
<CLAUDE_CONFIG_DIR>/sessions/<PID>.json
```

One file per running CLI process, deleted on exit, carrying `pid`, `sessionId`,
`cwd`, a friendly `name`, and a `status` of `busy` / `idle` / `shell`. The
**profile is whichever config dir the file was found in**, so no environment
inspection is needed — which matters, because reading another process's env on
Windows is not feasible (the obvious PowerShell approach,
`(Get-Process).StartInfo.EnvironmentVariables`, silently returns *your own*
environment).

**Two traps this module exists to encapsulate:**

1. **`status` is latched, not a heartbeat.** The file is rewritten only when the
   status *changes*. Measured live, a session sat at `"busy"` with `updatedAt` 39
   minutes old while genuinely working. Treating that timestamp as a staleness
   signal misclassifies every session within a minute. The transcript tail is the
   primary active/idle signal; the registry supplies identity and the `shell` state.
2. **Registry files survive a kill.** They are deleted on graceful exit only, so a
   crashed session leaves a stale file forever. `readLiveSessions()` cross-checks
   every `pid` and reports leftovers as `orphan` — and reports the converse,
   `unattributed`, when the process table holds a `claude.exe` with no registry file.

Library API (`scripts/lib/live.mjs`):

| Function | Returns |
|---|---|
| `claudeProfileHomes()` | `[{id, dir}]` — every profile root, main first |
| `readLiveRegistry()` | raw registry records across all profiles |
| `readLiveSessions()` | the reconciled picture: state, uptime, idle-for, subagents |
| `classifyFromTranscript(path)` | `idle` / `active` / `unknown` from the transcript tail |
| `countActiveSubagents(transcript)` | `{total, active, ids}` — **approximate**, see below |
| `pidAlive(pid)` | ~0ms liveness via signal 0 (vs ~420ms for `tasklist`) |

`classifyFromTranscript` walks **backwards** past the timestamp-less sentinel
records (`last-prompt`, `mode`, `permission-mode`, `ai-title`, `queue-operation`,
`attachment`) that are rewritten in place mid-turn — reading the last line naively
reports a busy session as idle.

**Subagents are in-process.** They spawn no OS process, so the only signal is the
mtime of `<session>/subagents/agent-*.jsonl`. That over-counts one that finished
quietly and under-counts one blocked in a long tool call: treat it as "recently
active", never as a fact.

## Before fanning out: how many subagents are feasible? (`fleet capacity`)

**Use this whenever you are about to spawn parallel subagents.** It is one command
and it prevents both failure modes: fanning out into a nearly-exhausted rate-limit
window, and serialising work when there was plenty of room.

`fleet` is **not on PATH by default** — invoke it by full path (works from any cwd):

```bash
FLEET=/c/projects/andrena/claude-pick/fleet/fleet.cmd     # git-bash
# PowerShell/cmd: C:\projects\andrena\claude-pick\fleet\fleet.cmd

"$FLEET" capacity --field recommended     # -> 6
"$FLEET" gate --count 8                   # exit 0 = go, 3 = not enough room
"$FLEET" capacity --json                  # full reasoning
```

(Adding `C:\projects\andrena\claude-pick\fleet` to PATH makes the bare `fleet`
command work; the examples below assume `$FLEET` so they run either way.)

It works with or without its background daemon — never start one just to ask.

**Recommended pattern** — ask, then scale the fan-out to the answer:

```bash
N=$("$FLEET" capacity --field recommended)
if [ "$N" -lt 1 ]; then
  "$FLEET" capacity       # prints why, and what to do instead
else
  # spawn min(N, what you actually wanted) subagents
fi
```

### Do NOT use `headroomProcesses` for this

The snapshot's `system.headroomProcesses` answers a *different* question — how many
more whole `claude.exe` **sessions** fit in RAM — and reaching for it here is the
obvious mistake. Subagents run **in-process**: they spawn no OS process, so their
marginal cost is only the tool children they launch (measured: ~6MB for bash/cmd,
~88MB for powershell), not a 520MB session. Observed side by side on this box:
`headroomProcesses: 2` while subagent capacity was **24** on the RAM axis alone.
It also ignores the constraint that actually binds a fan-out: **token quota**.

### What it returns

| Field | Meaning |
|---|---|
| `recommended` | how many MORE subagents to start now (already subtracts running ones) |
| `limitedBy` | `quota` / `ram` / `cpu` / `none` (`none` = capped by the fan-out ceiling, nothing scarce) |
| `limits` | the raw per-axis allowance, uncapped, so the recommendation is auditable |
| `basis` | `measured` (burn rate observed from history) or `policy` (conservative tiers) |
| `confidence` | `high` / `medium` / `low` |
| `reason`, `advice` | one-line explanation, and what to do when the answer is 0 |

`basis: "measured"` is the interesting one: with the daemon running, it reads how
much the 5-hour window ACTUALLY moved per agent-minute of observed work, then asks
how many concurrent agents that rate sustains for the time left before reset. With
no history it falls back to conservative tiers on 5h utilization and says so.

When quota is the binding limit and another profile has headroom, `advice` names it
— fan-out often just needs a different `CLAUDE_CONFIG_DIR`.

> Related: `fleet status` answers the broader question — "what is limiting me right
> now: RAM, CPU, quota, or nothing because every agent is idle waiting on me?"
