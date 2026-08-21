# spawn-session

Open a **new interactive Claude Code session in another repo**, in its own Windows
Terminal tab, without disturbing the session you are in.

Not a fork, not a resume — the new session has its own id and its own transcript.
It is for when the work belongs somewhere else: continuing `code-metrics-skill`
from an `agentic-kanban` session, giving a repo its own driver, or parking a
follow-up somewhere it can actually be done.

## Setup

Clone (or keep) this repo anywhere, then junction it into every Claude profile's
`skills\` directory — profiles do not share skills, and there is no
auto-propagation:

```powershell
$target = "C:\projects\andrena\spawn-session"
foreach ($p in (Get-ChildItem $env:USERPROFILE -Directory -Filter ".claude*")) {
  $link = Join-Path $p.FullName "skills\$(Split-Path $target -Leaf)"
  if (-not (Test-Path $link)) {
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  }
}
```

To remove one link later use `cmd /c rmdir "<link>"` — that deletes the junction
only. Never `Remove-Item -Recurse` a profile's `skills\` folder: it can follow the
junctions and delete the real skill repos.

Optionally put the repo on `PATH` so `! spawn` works from inside a session.

Requires Windows Terminal (`wt.exe`) and `claude` on `PATH`.

## Use

```
spawn                                  code-metrics-skill, seeded to continue its work
spawn code-metrics                     the same, named
spawn agentic-kanban -m "fix the flaky test"
spawn C:\projects\some-client\pulse     any path
spawn code-metrics -b                  bare - no seed prompt
spawn code-metrics -W                  a new WINDOW instead of a tab
spawn code-metrics -p 5x_4             a specific profile (short names work)
spawn code-metrics -safe               do not inherit this session's permission mode
spawn code-metrics -detect             resolve profile+mode, print them, launch nothing
spawn code-metrics -n                  dry run - print, spawn nothing
spawn code-metrics -dsp                forward --dangerously-skip-permissions
```

Anything unrecognised is forwarded to `claude` verbatim. `-h` / `--help` prints the
same list.

**Target resolution**, in order: an existing path → `C:\projects\andrena\<name>` →
`C:\projects\andrena\<name>-skill`. That last hop is why `code-metrics` resolves to
`code-metrics-skill`. An unresolvable target exits 1 and prints what it tried,
rather than starting a session in an unintended directory.

**The default seed prompt** asks the new session to read `CONTINUE.md`,
`BACKLOG.md` and `CLAUDE.md`, report what is actually true today — separating
verified from merely claimed — and *propose* next steps without editing until you
confirm. Replace it with `-m`, or drop it with `-b`.

## Why two files

`spawn.cmd` opens the tab; `spawn-session.ps1` runs inside it. They are split
because Windows Terminal treats the `;` between PowerShell statements as its own
command separator and tears an inline `-Command` string apart. A real script file
invoked as `powershell -File` with discrete arguments is the only spelling that
survives.

## What it inherits from the launching session

**The profile.** `CLAUDE_CONFIG_DIR` is passed as an argument, so the new session lands
on the same account and sees the same skills. Override with `-p`, which matches on a
normalised name — `5x_4`, `team5x_4`, `team_5x_4` and `andrena_team_5x_4` all find
`.claude-andrena_team_5x_4`. An ambiguous prefix like `5x` is refused with the
candidates listed, rather than resolved by guess.

**The permission mode.** No environment variable exposes it, so the launcher reads
`permissionMode` from the launching session's transcript (last value wins) and maps it
to a flag — `bypassPermissions` becomes `--dangerously-skip-permissions`. Without this,
a session spawned from a bypass-mode parent stalls on its first tool call waiting for a
human who is looking at another tab. It is printed in the banner every time, yellow when
permissive; `-safe` opts out.

## The environment leak it handles

`wt.exe` passes the launching process's environment to the new tab. Verified with a
probe tab, not assumed: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
`CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_MESSAGING_TOKEN` all arrive set. Left
alone, a session spawned from inside Claude Code comes up with

- **no colours**, because `CLAUDECODE=1` makes it believe it is nested;
- **transcript saving off**, because of `CLAUDE_CODE_CHILD_SESSION=1` — so its work
  would not be resumable, which defeats the point of spawning it;
- **the launching session's IPC pipe and token** in its environment.

The launcher scrubs those before starting `claude`, sets
`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, supplies a `TERM` (which arrives unset
even when the launching shell had one), and prints what it scrubbed — a silent
scrub is indistinguishable from a launcher that forgot.

`CLAUDE_CONFIG_DIR` is deliberately kept and is passed as an **argument** rather
than left to inheritance, so the profile still travels if `wt` ever stops
forwarding the environment.

## Related

| Tool | For |
|---|---|
| `cfork` (claude-pick) | continue **this conversation** in a new window, optionally under another profile |
| `session-inspector` | inspect, resume, or recover **past** sessions |
| agentic-kanban | launching agents in **worktrees** of a board project — don't bypass it with this |

_Docs last synced with the code at `HEAD` (2026-08-21)._
