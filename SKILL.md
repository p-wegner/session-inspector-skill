---
name: spawn-session
description: Open a NEW interactive Claude session in another repo, in a Windows Terminal tab, without disturbing the current session. Use when work belongs in a different repo than the one you are in — continuing code-metrics-skill from an agentic-kanban session, handing a repo its own driver, or parking a follow-up somewhere it can actually be done. Default target is code-metrics-skill.
---

# spawn-session

Start a **fresh, interactive** Claude session in another repo, in its own Windows
Terminal tab. The current session keeps running, untouched.

This is not a fork and not a resume: the new session has its own id and its own
transcript. Use `cfork` (claude-pick) when you want *this* conversation continued
elsewhere; use this when you want *that repo* worked on.

## Use it

```powershell
& "C:\projects\andrena\spawn-session\spawn.cmd" [target] [flags]
```

The human spelling from inside a session is `! spawn` once the repo is on PATH.

| | |
|---|---|
| `spawn` | code-metrics-skill, seeded to continue its own `CONTINUE.md` work |
| `spawn code-metrics` | the same, named |
| `spawn agentic-kanban -m "fix the flaky base-branch test"` | a specific task |
| `spawn C:\projects\some-client\pulse` | any path |
| `-b` | bare — no seed prompt, just an empty session in that repo |
| `-W` | a new **window** instead of a tab |
| `-p 5x_4` | a specific Claude profile. Short names work: `5x_4`, `team5x_4`, `team_5x_4` all find `.claude-andrena_team_5x_4` |
| `-safe` | do **not** inherit this session's permission mode |
| `-detect` | resolve profile + permission mode, print them, launch nothing |
| `-n` | dry run — print what would be launched, spawn nothing |
| `-dsp` | forward `--dangerously-skip-permissions` |

Anything unrecognised is forwarded to `claude` verbatim.

**Target resolution**, in order: an existing path → `C:\projects\andrena\<name>` →
`C:\projects\andrena\<name>-skill`. That last hop is why `code-metrics` finds
`code-metrics-skill`. An unresolvable target exits 1 and says what it tried, rather
than starting a session somewhere unintended.

**The default seed prompt** asks the new session to read `CONTINUE.md`, `BACKLOG.md`
and `CLAUDE.md`, report the current state — separating verified from merely claimed —
and *propose* next steps without editing until confirmed. Override with `-m`, or drop
it with `-b`. It is deliberately non-committal: a spawned session that starts editing
unattended is a worse outcome than one that waits.

## Two things this exists to get right

**1. Windows Terminal eats `;`.** It treats the semicolon between PowerShell
statements as its own command separator, so an inline `-Command` string gets torn
apart mid-launch. The only spelling that survives is a real script file invoked as
`powershell -File` with discrete arguments — which is why the work is split across
`spawn.cmd` (opens the tab) and `spawn-session.ps1` (runs inside it). Same trap, same
fix, as `claude-pick/cfork-profile.ps1` and `session-inspector`'s launcher. Don't
collapse them back into one inline command.

**2. `wt.exe` hands the launching process's environment to the new tab.** Verified,
not assumed — a probe tab reported `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
`CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_MESSAGING_TOKEN` all arriving SET. Left
alone that produces three failures, two of them silent:

- `CLAUDECODE=1` / `CLAUDE_CODE_ENTRYPOINT` make the child think it is nested, so it
  drops to **plain uncoloured output**;
- `CLAUDE_CODE_CHILD_SESSION=1` **turns transcript saving off** — the spawned session's
  work would not be resumable, which defeats the entire point of spawning it to carry
  work forward;
- `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN` are the launching session's IPC pipe and
  its token. A second session should not be holding them.

So the launcher **scrubs** those markers (and `CLAUDE_PID`, `CLAUDE_EFFORT`) before
starting `claude`, sets `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, and reports what it
scrubbed in its banner — a silent scrub is indistinguishable from a launcher that
forgot. `CLAUDE_CONFIG_DIR` is deliberately **kept**: it is how the profile travels.

`TERM` arrives **unset** in the tab even when the launching shell had
`xterm-256color`, so the launcher supplies it. That line is load-bearing, not
decoration.

## Permission mode is inherited

There is no environment variable for it, so the launcher reads `permissionMode` from
the **launching session's transcript** (last value wins) and maps it to a launch flag:
`bypassPermissions` → `--dangerously-skip-permissions`, `acceptEdits`/`plan` →
`--permission-mode <mode>`. Same technique as `session-inspector`'s
`session-resume.mjs`, which relaunches a session the way it was actually running.

This matters more than it sounds: a session spawned from a bypass-mode parent that
comes up in default mode **stalls on the first tool call**, waiting for a human who is
looking at a different tab. The mode is printed in the banner every time — yellow when
it is permissive — because an inherited bypass nobody announced is the one outcome here
worth being loud about. `-safe` opts out.

The transcript is looked up under the **launching** session's config dir, not
`$env:CLAUDE_CONFIG_DIR`, which by that point may already have been repointed by `-p`.
That ordering was a real bug: `-p 5x_4` from a `5x_2` session searched 5x_4's
`projects\` directory, found nothing, and silently lost the inherited mode. It now
falls back to sweeping every `.claude*` profile, since a session id is unique across
them.

## Profile

The new session inherits the launching session's `CLAUDE_CONFIG_DIR`, so it lands on
the same account and sees the same skills. This is passed as an **argument**, not left
to the environment — relying on inheritance here would work by accident today and
break the moment `wt` stops forwarding env.

Override with `-p`. It matches on a **normalised** form (lowercase, `-`/`_` removed),
so every spelling a human actually types resolves: `5x_4`, `team5x_4`, `team_5x_4`,
`andrena_team_5x_4`, `.claude-andrena_team_5x_4`, or a full path. An exact normalised
name always wins outright, so `.claude` itself can never be shadowed by a longer
sibling.

Requiring the exact directory name is what an earlier version did, and it made every
short spelling fall back silently to the inherited profile — indistinguishable from the
flag being ignored. An **ambiguous** prefix (`5x`, which matches four profiles) is
refused with the candidates listed rather than resolved by guess: landing on the wrong
account is the failure this flag exists to prevent. An unresolvable name falls back to
the inherited profile and says so out loud.

## When NOT to use it

- **You want this conversation continued elsewhere** → `cfork` (claude-pick).
- **You want a headless/scripted run** → `claude -p` directly; this is interactive by
  design.
- **You are inside a worktree of a board project** → the board owns agent launching
  there (`POST /api/workspaces`, `workspace resume`). Spawning a loose session in a
  worktree bypasses the board's session tracking.
