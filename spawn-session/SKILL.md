---
name: spawn-session
description: Open a NEW interactive Claude session in another repo, in a Windows Terminal tab, without disturbing the current session. Use when work belongs in a different repo than the one you are in — continuing code-metrics-skill from an agentic-kanban session, handing a repo its own driver, or parking a follow-up somewhere it can actually be done. Default target is code-metrics-skill. ALSO launches a whole APPROVED batch of sessions from a spawn-plan file (`-batch`, the human gate for session-inspector's continuations.mjs — only entries a person marked approved are started), RESUMES an existing session id (`-resume`), picks the account with the most quota headroom (`-p auto`), takes its seed prompt from a FILE (`-mf`, required from a script or agent), and REFUSES by default to open a second session in a checkout that already has one or to launch with no RAM headroom.
---

# spawn-session

Start a **fresh, interactive** Claude session in another repo, in its own Windows
Terminal tab. The current session keeps running, untouched.

This is not a fork and not a resume: the new session has its own id and its own
transcript. Use `cfork` (claude-pick) when you want *this* conversation continued
elsewhere; use this when you want *that repo* worked on.

## Use it

```powershell
& "C:\projects\andrena\session-inspector-skill\spawn-session\spawn.cmd" [target] [flags]
```

The human spelling from inside a session is `! spawn` once the folder is on PATH.

This skill lives **inside the session-inspector repo** (`session-inspector-skill/spawn-session/`)
and is junctioned separately, so `skills\spawn-session\spawn.cmd` resolves too.
Scripts on the session-inspector side never hardcode this path — they call
`spawnCmdPath()` from `../scripts/lib/spawn-plan.mjs`, which resolves it relative
to the repo. Do the same rather than pasting an absolute path.

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
| `-handoff` | write a brief, seed the new session with it, then **wait and report which session took over**. Implies `-wait`. The quota-handoff mode |
| `-wait` | wait for the new session to register on ACP and name it |
| `-notrust` | do not pre-accept the folder-trust dialog |
| `-mf <file>` | seed from a FILE. **Use this, not `-m`, from a script or another agent** — a long `-m` cannot survive bash → cmd (parentheses alone killed a real launch) |
| `-m -` | read the seed from stdin; fails loudly on empty rather than seeding a blank session |
| `-batch <plan.json>` | launch every entry of a spawn plan marked `approved: true`, and nothing else. Exits 3 if none are |
| `-resume <id>` | reopen an existing session instead of starting a fresh one (this is what session-inspector's `session-resume --launch` now calls) |
| `-p auto` | the account with the most quota headroom right now, instead of whichever this shell is on |
| `-force` | skip the preflight refusals (duplicate session in the checkout, no RAM headroom) |
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

## Three traps this exists to get right

**1. Windows Terminal eats `;` — and not only between PowerShell statements.** It treats
the semicolon as its own command separator, so an inline `-Command` string gets torn apart
mid-launch. The only spelling that survives is a real script file invoked as
`powershell -File` with discrete arguments — which is why the work is split across
`spawn.cmd` (opens the tab) and `spawn-session.ps1` (runs inside it). Same trap, same fix,
as `claude-pick/cfork-profile.ps1` and `session-inspector`'s launcher. Don't collapse them
back into one inline command.

wt splits on `;` **after** cmd and PowerShell quoting are already satisfied, so a
perfectly-quoted *prompt* containing a semicolon is torn in half too. Measured while
building the handoff mode: the default handoff prompt said "reachable over ACP; the brief
says how", and wt failed with `0x80070002` trying to start a program called
`" the brief says how." -ProfileDir 5x_4 ...`. Escaping the one character would leave the
class open, so **prompt text never travels on the wt command line** — `write-text.mjs`
stages it to a file passed as `-PromptFile`. A path contains nothing wt reinterprets, and
semicolons, quotes, ampersands, newlines and non-ASCII all ride inside the file untouched.

**2. `$ErrorActionPreference = 'Stop'` is wrong for a launcher.** Under `Stop`, PS 5.1 turns
any line a native command writes to **stderr** into a *terminating* ErrorRecord. That killed
this launcher on first use in the most confusing way available: `trust-folder.mjs` printed a
**success** message, PowerShell raised `NativeCommandError`, and the tab dropped to a bare
prompt with `claude` never started. The script now runs under `Continue`, handles errors by
exit code, and the node helpers put their status on **stdout** so no caller needs `2>&1`.
The agentic-kanban CLAUDE.md warns about this exact trap; it is easy to walk into anyway.

**3. `wt.exe` hands the launching process's environment to the new tab.** Verified, not
assumed — a probe tab reported `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
`CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_MESSAGING_TOKEN` all arriving SET. Left alone that
produces three failures, two of them silent:

- `CLAUDECODE=1` / `CLAUDE_CODE_ENTRYPOINT` make the child think it is nested, so it drops to
  **plain uncoloured output**;
- `CLAUDE_CODE_CHILD_SESSION=1` **turns transcript saving off** — the spawned session's work
  would not be resumable, which defeats the entire point of spawning it to carry work
  forward;
- `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN` are the launching session's IPC pipe and its
  token. A second session should not be holding them.

So the launcher **scrubs** those markers (and `CLAUDE_PID`, `CLAUDE_EFFORT`) before starting
`claude`, sets `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, and reports what it scrubbed in
its banner — a silent scrub is indistinguishable from a launcher that forgot.
`CLAUDE_CONFIG_DIR` is deliberately **kept**: it is how the profile travels.

`TERM` arrives **unset** in the tab even when the launching shell had `xterm-256color`, so
the launcher supplies it. That line is load-bearing, not decoration.

## Handing work over — `-handoff`

The case this was extended for: **this session is out of budget, continue the work on
another subscription.** A plain spawn opens a session; a handoff transfers work and tells
you who has it.

```powershell
& "...\spawn.cmd" code-metrics -p 5x_4 -handoff -m "what I was doing and why I am stopping"
```

Three things happen that a plain spawn does not do.

**1. A brief is written** to `~/.spawn-session/handoffs/<ts>--<slug>.md` — durable, never
`%TEMP%`, because it must outlive the session that wrote it. It carries the `-m` note (the
only source that knows *intent*), the target repo's measured git state, and — if
`session-inspector` is installed — its `--handoff` panel: background/detached processes,
armed monitors, the scratchpad, the last TodoWrite, unadjudicated subagent results. That
panel is what stops the new session redoing work a detached driver already finished. Each
section names its source, and a missing analyzer degrades to "note + git state" **and says
so** rather than quietly shipping half of what it promised.

**2. The new session is seeded to take over** — read the brief, then `CONTINUE.md` /
`BACKLOG.md` / `CLAUDE.md`, report what it actually finds, separating verified from merely
claimed, and propose before editing.

**3. The launcher waits and names the recipient.** `spawn.cmd` cannot know the child's
session id — `claude` has not started yet — but every session registers on the ACP bus from
its `SessionStart` hook as `<cwd-slug>--<sid8>`, so the identity is read back from the
roster (snapshot before, diff after). The receipt is what makes a handoff *verifiable*
rather than hopeful:

```
[spawn] HANDOFF RECEIPT
  continued by : C--projects-andrena-code-metrics-skill--20189b4c
  brief        : C:\Users\pwegner\.spawn-session\handoffs\...md
  reach it     : node ".../acp.js" send --to C--...--20189b4c --msg "..."
```

The id half of that name is the new session's **real session id prefix**, so the receipt
is also a resume handle: `claude --resume 20189b4c…` in that profile, or a
`session-inspector` locator.

**Failure is reported, never papered over.** A timeout, an unreachable bus, or two new
sessions appearing at once all exit non-zero and say "do NOT treat this as a completed
handoff". Naming the wrong recipient — or claiming a handoff that did not happen — is worse
than naming none.

### Closing the outgoing session

`-handoff` ends with *"safe to close once you have nothing else in flight"*, and the tool
stops there on purpose. **Closing the session is the human's `/exit`.** An agent should not
end its own conversation because it judged its work transferred, and the one tool that ends
a conversation is reserved for situations that have nothing to do with handoffs. What the
receipt provides is exactly what is needed to close it safely: the name of the session that
now holds the work, and the command to ask it anything.

One thing the outgoing session cannot verify for you: from inside a session, neither ANSI
colour rendering nor the startup banner is observable — asked directly, the handoff
recipient correctly refused to certify either. If you need to confirm the new tab is
healthy, look at it.

## The folder-trust prompt

"Do you trust the files in this folder?" is a **blocking** first-run prompt, per (profile,
folder). Spawning into a profile that has never opened the target repo — the normal case
when handing to another subscription — parks the new session on a question nobody is
watching, turning an unattended handoff into a silent hang. Observed on first real use.

`trust-folder.mjs` pre-accepts it by setting
`projects["<path>"].hasTrustDialogAccepted = true` in `<profile>/.claude.json` (forward
slashes; merged into any existing entry so siblings like `allowedTools` survive; atomic
write; one `.spawn-session.bak` kept). `-notrust` opts out. If it cannot write, the banner
says **"COULD NOT PRE-ACCEPT - expect a trust prompt"** rather than launching into what
looks like a hang.

It is node and not PowerShell for a specific reason: **PS 5.1's `ConvertTo-Json` defaults
to `-Depth 2`**, so a round-trip would silently truncate a 60–100 KB nested `.claude.json`
into rubbish. Verified on a copy of a real 99 KB config: exactly one entry changed, one
flag flipped, all 45 projects and everything outside `projects` byte-identical.


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

## Spawning a BATCH — capture each identity as you go

Spawning several sessions and then diffing the ACP roster at the end tells you *that* N
sessions came up, but **not which is which**: registration order does not follow spawn
order. Measured — four sessions launched in the order `5x, 5x_2, 5x_3, 5x_4` registered as
`42249379, 1a3df5b9, c54904dc, 56c2b369`, and asking them directly showed the first two
were the reverse of the order they were launched in. All four profiles were covered exactly
once; only the inferred name-to-profile mapping was wrong.

So for a batch, pass **`-wait` per spawn** — it snapshots and diffs around that one launch,
so the name it prints belongs to that profile. Do not reconstruct the mapping afterwards
from ordering.

If you must confirm placement after the fact, ask the sessions over ACP; a live session's
profile is not readable from disk (`lastSessionId` in `.claude.json` is written at
shutdown, so it names the PREVIOUS session).

## What a spawned session cannot tell you about itself

Two questions to stop asking a spawned session, because its answer will be confidently
wrong:

**Colours.** A session reports the environment of its own *tool subprocesses*, and Claude
Code sets `NO_COLOR=1` there deliberately so tool output is not ANSI-polluted. Asked
whether it has colours, all four batch sessions answered "no - NO_COLOR=1 is set", which is
true of their tool env and says nothing about the TUI. (Verified: this launching session's
PowerShell tool env also carries `NO_COLOR=1`, unset by anyone here.) The TUI's rendering
is only observable by a human looking at the tab.

**The startup banner.** Not visible from inside either. Confirm transcript saving instead by
checking that `<profile>/projects/<slug>/<sid>.jsonl` exists and is growing — that is a fact
on disk rather than a self-report.

A spawned session declining to certify these is the correct answer, not an unhelpful one.

## When NOT to use it

- **You want this conversation continued elsewhere** → `cfork` (claude-pick).
- **You want a headless/scripted run** → `claude -p` directly; this is interactive by
  design.
- **You are inside a worktree of a board project** → the board owns agent launching
  there (`POST /api/workspaces`, `workspace resume`). Spawning a loose session in a
  worktree bypasses the board's session tracking.
