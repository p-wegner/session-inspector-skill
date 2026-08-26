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
> first** (section above). Resuming re-dispatches the whole fan-out; that tool
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
