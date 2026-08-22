# spawn-session

> **This skill is one of two siblings in [this repo](../README.md)** —
> `spawn-session/` beside `session-inspector/`, neither nested in the other. It was
> its own repo until 2026-08-22; the move brought its history along and the
> per-profile junctions were repointed, so nothing about using it changed. It
> shares `../session-inspector/scripts/lib/spawn-plan.mjs` with the tool that
> writes the plans it launches.

Open a **new interactive Claude Code session in another repo**, in its own Windows
Terminal tab, without disturbing the session you are in.

Not a fork, not a resume — the new session has its own id and its own transcript.
It is for when the work belongs somewhere else: continuing `code-metrics-skill`
from an `agentic-kanban` session, giving a repo its own driver, or parking a
follow-up somewhere it can actually be done.

## Setup

Junction this FOLDER into every Claude profile's `skills\` directory — profiles
do not share skills, and there is no auto-propagation. Note the target is the
`spawn-session` subfolder of the session-inspector repo, not the repo root (that
root is junctioned separately, as the `session-inspector` skill):

```powershell
$target = "C:\projects\andrena\session-inspector-skill\spawn-session"
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
spawn code-metrics -p 5x_4 -handoff -m "..."   hand work over and report WHO took it
spawn code-metrics -notrust            do not pre-accept the folder-trust dialog
spawn code-metrics -n                  dry run - print, spawn nothing
spawn code-metrics -dsp                forward --dangerously-skip-permissions

spawn code-metrics -mf prompt.txt      seed from a FILE (use this from a script/agent)
spawn code-metrics -p auto             the account with the most quota headroom
spawn -batch plan.json                 launch every APPROVED entry of a spawn plan
spawn <repo> -resume <session-id>      reopen an existing session instead of a new one
spawn code-metrics -force              skip the preflight refusals
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

### Pass the prompt as a FILE, not as an argument (`-mf`)

`-m` is fine when **you** type it at a shell. From a script, or from another agent,
use `-mf <file>`. This is not a style preference — a long `-m` cannot reliably cross
`bash → cmd`. A real launch died on nothing but parentheses:

```
"plus" kann syntaktisch an dieser Stelle nicht verarbeitet werden.
```

The launcher already refuses to put prompt text on the `wt.exe` command line (see
[The environment leak it handles](#the-environment-leak-it-handles) and `write-text.mjs`)
because Windows Terminal splits on `;` *after* quoting is satisfied. `-mf` closes
the same class one level up, at the caller. `-m -` reads the prompt from stdin and
fails loudly if stdin is empty, rather than seeding a blank session.

### It refuses two things before launching

A preflight runs unless you pass `-force`:

- **a second session in a checkout that already has one** — two agents in one
  working tree is how you get cross-author commits and a Stop hook handing one
  session another's in-flight work. It names the session that is already there.
- **no RAM headroom for another session** — measured: four sessions were once
  launched into a box already swapping at ~9,500 hard faults/sec, because nothing
  asked. Uses `fleet snapshot`'s `headroomProcesses`, which is the right metric for
  whole sessions (it is the wrong one for in-process subagents).

If `fleet` is not installed the capacity check is **skipped and says so** — an
unavailable check must never read as a passed one.

### Launch a whole approved plan (`-batch`)

Spawning four continuations by hand is four near-identical invocations. Instead,
[session-inspector](../README.md)'s
`continuations.mjs` writes a plan of candidates — each with a target, a profile, a
seed message and a summary — with every entry `approved: false`. A human picks, then:

```powershell
spawn -batch plan.json
```

`-batch` launches **only** entries marked `approved: true`, and exits 3 with the
review instructions if none are. That is the point: the human gate cannot be
forgotten, only answered. Every message travels as a file, each entry gets its own
profile, and the run ends with a receipt table naming the session that took each
piece of work.

### Who took the work: the ledger

Every spawn appends one line to `~/.spawn-session/ledger.jsonl` — source session,
target repo, profile, and (with `-wait`) the ACP name of the session that took over.

This exists because a handoff brief only records the **source** side, so nothing on
disk said who picked the work up, and session tooling was left inferring it from
text. That inference is actively harmful: a session that merely *mentions* another's
id looks identical to one that continued it, and acting on the guess hid two
genuinely open cut-off sessions behind one fleet-tool run. The ledger is the record
that removes the guess — `session-inspector`'s `resumable.mjs` reads it to mark a
session "already continued" instead of recommending it again.

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

## Handing work over to another subscription

The case this exists for: this session is out of budget, and the work should continue on
another account.

```
spawn code-metrics -p 5x_4 -handoff -m "what I was doing and why I am stopping"
```

- A **brief** is written to `~/.spawn-session/handoffs/<ts>--<slug>.md` (durable, never
  `%TEMP%`): your note, the target repo's measured git state, and — if `session-inspector`
  is installed — its `--handoff` panel of background processes, armed monitors, scratchpad
  and unadjudicated subagent results. Every section names its source; a missing analyzer
  degrades to "note + git state" and says so.
- The new session is **seeded to take over**: read the brief, then the repo's own docs,
  report what it actually finds, propose before editing.
- The launcher then **waits and names the recipient**, read back from the ACP roster
  (snapshot before, diff after) because the child's session id does not exist at launch:

```
[spawn] HANDOFF RECEIPT
  continued by : C--projects-andrena-code-metrics-skill--20189b4c
  brief        : C:\Users\pwegner\.spawn-session\handoffs\...md
  reach it     : node ".../acp.js" send --to C--...--20189b4c --msg "..."
```

The id half of that name is the new session's real session-id prefix, so it doubles as a
`claude --resume` handle. A timeout, an unreachable bus, or two new sessions appearing at
once exit non-zero and say "do NOT treat this as a completed handoff".

**Closing the outgoing session is your `/exit`.** The tool reports that the handoff is
complete and who holds the work; it does not close anything itself. Note that a session
cannot self-verify its own colours or transcript banner — only someone looking at the tab
can — so if you want the new tab certified healthy, look at it.

## The folder-trust prompt

"Do you trust the files in this folder?" is a blocking first-run prompt, per (profile,
folder) — so spawning into a profile that has never opened the repo parks the session on a
question nobody is watching. The launcher pre-accepts it in that profile's `.claude.json`
(atomic write, one `.bak`, merged so `allowedTools` and friends survive); `-notrust` opts
out, and a failure is announced rather than left to look like a hang.

Done in node, not PowerShell, because **PS 5.1's `ConvertTo-Json` defaults to `-Depth 2`**
and would truncate a 60–100 KB nested config into rubbish. Verified against a copy of a
real 99 KB config: one entry changed, one flag flipped, everything else byte-identical.

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

_Docs last synced with the code at `c0b8027`+ (2026-08-21)._
