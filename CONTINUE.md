# CONTINUE — claude-session-tools

Repo-wide pick-up notes. Three sibling skills since 2026-08-26: `session-inspector/`,
`token-budget/`, `spawn-session/`. Candidate work is in [`BACKLOG.md`](BACKLOG.md) (new today),
the per-agent tool coverage in [`docs/agent-feature-matrix.md`](docs/agent-feature-matrix.md).

## 2026-09-18 — published reach on the fleet tools (BACKLOG item 1, in progress)

**Why.** A skill-design shape pass classified `session-inspector` as an Instrument whose numbers
are consumed as data, so a wrong count does not stay in chat. It was missing published reach: parsers
dropped unparseable lines with a bare `catch { continue; }`, and nothing said which profiles, agents
or windows a total covered.

**`scripts/lib/reach.mjs`**, a per-process singleton. Tools call `begin`, `found` and
`exclude(reason)`, and **`read` is computed as found minus excluded**, never reported by the tool. `lib/parse.mjs`,
`lib/quota.mjs` and `lib/usage.mjs` count bad lines and folded usage rows into it, per file and
reset on each read, so a file read twice counts once. Each wired tool prints one `reach:` line under
its header and a `reach` block in `--json`, and names whether the measuring session is included.

**Wired (12):** token-sinks, tool-friction, quota-multi, fleet-stats, waste, context-growth,
cold-cache, context-spikes, reread-causes, slash-goals, incidents, prompt-style.
**Not yet:** tool-failures, user-prompts, read-patterns, hook-cost, skill-usage, skill-genesis,
cache-health, quota-report, quota-month. The same two-pass pattern applies. The script that wired
the `discover()`-based nine was scratch, and the pattern is `found → exclude → file → badLine`.

**Three defects the reach line exposed, all fixed:**
- **`token-sinks` left out subagent and workflow transcripts, and ignored `CODEX_HOMES`.** It had
  its own discovery. It now uses `lib/sessions.mjs` `discover()` and costs nested transcripts to
  their parent. The 3-day Claude total went from $1,726 to $1,910. Session count unchanged (502):
  sessions are distinct ids now, and transcripts are counted separately.
- **`tool-friction` printed the disk-wide file count as "sessions scanned"** (19,130 → 1,019 for 7 days).
- **`--days N` read N+1 days in five tools** (fleet-stats, waste, context-growth, slash-goals,
  incidents). The window had a slack day, and nothing filtered it back out. `prompt-style` keeps it,
  because it filters each prompt by timestamp. With `--days 1`, every wired Claude tool now reads the
  same 305 transcripts (it was 428 against 305).

`quota-multi` now says that `~/.claude` is left out by design, and how to include it.

**Verified:**
- `node --test scripts/test/*.test.mjs`: 87 existing tests plus 6 new in `reach.test.mjs`. The
  double-read test was checked by mutation: removing the per-file reset fails it.
- Each wired tool ran on `--days 1` with exit 0.

**Also fixed in the tree:** the employer's name had come back in two profile names in the passes
below (now `org_team_5x_2`). `docs/analysis/` (skill-analysis over real transcripts) is now gitignored.

## Archive

Passes older than the current day live verbatim in [`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md),
newest first. Nothing there was re-verified on the way in; it is the readable trail, not a
second source of truth.

## spawn-session

The rest of this file concerns `spawn-session/`, one of the three sibling skills in this repo.
Current state, present tense. The repo has a GitHub remote, so anything machine-specific belongs
in a gitignored `*.local.md` beside this file rather than here.

Standard skill layout: `SKILL.md`, `README.md` and the entry point `spawn.cmd` at the skill root,
every helper under `scripts/` (`spawn-session.ps1`, `batch.mjs`, `preflight.mjs`, `make-handoff.mjs`,
`ledger.mjs`, `repo-root.mjs`, `stage-launch.mjs`, `trust-folder.mjs`, `wait-for-agent.mjs`,
`write-text.mjs`). `spawn.cmd` resolves them via `%~dp0scripts\`; `batch.mjs` reaches the sibling
skill via `../../session-inspector/scripts`.

`spawn.cmd` is the **only** session launcher here. `session-resume.mjs` delegates to it
(`session-inspector/scripts/session-resume.mjs:438`) rather than writing its own per-session `.cmd`,
which used to leak `CLAUDE_CODE_CHILD_SESSION=1` into every relaunched session and turn transcript
saving off. That consolidation is why `-resume` exists here at all.

**Prefer `-handoff -from <session-id>` over `-resume`.** Resume cannot cross profiles, and a session
is normally cut off because its account hit a limit; its cache is also dead by then (measured across
five real cut-offs: $11.24 cold against $0.56 warm). The rule lives in
`session-inspector/scripts/lib/resume-economics.mjs`. The 2026-08-22 verification matrix for `-mf`,
`-m -`, preflight, `-p auto`, `-batch` and the ledger, and the full resume-vs-handoff reasoning, are
in [`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md).

## Resume identity — settled 2026-09-18

**`claude --resume <id>` keeps the session id and appends to the same transcript, and the
conversation is carried over.** Probed headlessly in a throwaway cwd: `claude -p` wrote
`5c65c738….jsonl`, then `claude -p --resume 5c65c738… "what word did I ask you to remember"`
answered `PINEAPPLE`, reported `session_id: 5c65c738…`, and appended to that same file — one
session id across all 35 lines, no second transcript anywhere.

That closes the worry the 2026-08-22 entry was really about. What it does **not** cover: the
interactive TUI was not re-probed (the 2026-08-22 tab is long gone, its `f67071d0…` registry id
never wrote a transcript in any profile, and the `58656cf0…` transcript has not grown since
2026-08-20). So the narrow registry question — whether the *session registry* keys a resumed tab
under a fresh id — is still open, and is now cosmetic: the session itself is the same one.

Scanned 400 recent transcripts across profiles for a file carrying more than one `sessionId`, or
one that disagrees with its filename: zero. Resume forks a transcript only when asked
(`--fork-session`).

**Still unverified:** `-resume` against a session with **no messages** starts a fresh session —
observed with a 9-line transcript whose first entry was `queue-operation`. That looked like a
launcher bug for a while; it is not, but a caller feeding ids from `session-resume --between`
should expect it.

## Next steps

- [ ] `-batch` has only been dry-run end to end. Run one real approved plan.
- [ ] Verified by dry run only: `-from` + `-handoff` writing a brief for another
      profile's session. The brief header and machine-state panel were checked;
      a real launch off that brief has not been done.
- [ ] Consider having `preflight` warn (not refuse) when the target is a *worktree*
      of a repo that has a live session at its root — currently only an exact cwd
      match counts as a duplicate.
