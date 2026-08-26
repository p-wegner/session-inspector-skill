# Resume vs. hand off — resumable.mjs, session-resume.mjs, spawn-session

_session-inspector reference. Moved verbatim out of `SKILL.md` on 2026-08-26 so the skill body stays small; commands are run from the skill directory (`node scripts/…`)._

## RESUME is usually the WRONG tool — hand off instead

**Read this before recommending `claude --resume` to anyone, including yourself.**
Two structural reasons, both of which bite hardest in exactly the case that makes
you want to resume:

1. **`--resume` cannot cross profiles.** A session lives under one
   `~/.claude[-suffix]` home and `--resume` resolves against `CLAUDE_CONFIG_DIR`,
   so the work is pinned to that account. But a session is normally cut off
   *because that account hit its limit* — so the one profile resume can use is
   the one you cannot.
2. **The cache is dead by the time you come back.** Claude Code's prompt cache
   has a **1-hour TTL**. Warm, each turn re-reads the context at 0.1x base input;
   past the TTL the next turn re-**writes** the whole prefix at 2x. That is a
   **20x** multiplier on the first turn, paid before any new work happens.

Measured on this box's five real cut-off sessions (103k–295k peak context):
resuming them cold costs **$11.24** against **$0.56** warm. A handoff brief is
2–5k tokens — cents — and runs on any account with headroom.

So `resumable.mjs` and `session-resume.mjs` now **recommend a handoff by default**
and print the priced reason. Resume is recommended only where it genuinely wins:
same profile, cache still warm (< 60m idle), or a small context (< 50k). The rule
and the pricing live in `lib/resume-economics.mjs` (`recommendMode()`), so both
tools agree; `recommendMode` also returns `priced: false` when the transcript has
no per-turn usage, and callers then fall back to their own heuristic instead of
trusting a $0.00 estimate.

**The handoff command**, which is what to hand a human:

```powershell
& "<repo>\spawn-session\spawn.cmd" "<cwd>" -p auto -handoff -from <session-id> -m "why you are stopping"
```

`-from` is load-bearing: without it the brief describes the **calling** session
rather than the cut-off one. `-p auto` picks the account with the most headroom,
which is the whole point — a handoff can go anywhere, a resume cannot.

## Resume sessions after a crash / reboot / rate-limit

When a batch of sessions dies at once (hard reboot, power loss) or a session is
cut off by a Claude usage limit, `scripts/session-resume.mjs` turns "what was I
running and how do I pick it back up" into one command. It classifies each
session and decides — per a simple rule — whether to **resume in place** or
**start fresh from a written handoff brief**, then prints the exact launch
command (or opens a dedicated Windows Terminal tab per session).

> **If the cut-off session dispatched subagents, run `subagent-results.mjs`
> first** (`single-session.md`). Resuming re-dispatches the whole fan-out; that tool
> tells you which subagent outputs already survive on disk (act on / re-inject
> them) versus which were themselves cut off and must actually be re-run — so the
> continuation doesn't pay for work that's already done.

```powershell
# Plan the most recent crash cluster (auto-detects the near-simultaneous kill):
node scripts/session-resume.mjs --profile andrena_team_5x --project acme --reboot

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
rate-limited → **FRESH** (hand off; resume is pinned to the exhausted account and reloads cold); last activity < 60m → **RESUME**
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

## `resumable.mjs` in depth

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
**Instant deaths are grouped, not listed**: a session that died within seconds with
zero tool calls (a fleet launched into an exhausted profile window — e.g. a kanban
board relaunching 38 ticket agents straight into the limit banner) has NOTHING to
resume, so `--resume`-ing it reopens an empty session. These collapse into one
summary line per launch directory with relaunch-not-resume advice (individually
listable with `--include-instant`; in `--json` they're the `instantDeaths` groups
next to `resumable`).

**Subagents are excluded by default.** A subagent is not independently resumable
(`claude --resume` takes the PARENT's id), and a shared-account limit kills parent
and children together — so one cut-off orchestrator used to contribute its whole
fan-out of look-alike rows. Measured: 9 of the top 10 rows were one parent's 20
research subagents, burying the 3 real cut-offs — and every one of those rows
printed an **unusable** resume command, because the profile home was derived by
counting `dirname` hops and a nested transcript sits two levels deeper, so
`CLAUDE_CONFIG_DIR` pointed at the *project dir*. Both are fixed: the home is now
anchored on the `projects` path segment, and `--include-subagents` shows them
labelled, pointing at the parent + `subagent-results.mjs` rather than at a resume
command that cannot work.

**Already-continued sessions are separated out** (`lib/successor.mjs`). A cut-off
session whose work another session already finished is noise that outranks
everything real, since severity and recency both favour it. Evidence is graded, and
only the strong kinds may HIDE a row: `ledger` (spawn-session's own record of the
handover, `~/.spawn-session/ledger.jsonl`) and `brief` (a handoff brief naming its
source session, whose filename a later transcript quotes). A same-repo **id
mention** is a hint only, annotated in place — treating it as fact suppressed two
genuinely open cut-offs, because a session that merely *analyzed* the fleet mentions
every id. So a would-be successor naming 3+ distinct candidates is reclassified as
analysis and dropped. `--include-continued` ranks them anyway.
