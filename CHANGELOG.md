# Changelog

User-visible changes, newest first. Updated sporadically on request, not per commit.

## 2026-08-22 — "what should I pick up next?", and two resumable defects

### New: `continuations.mjs` — which work to pick up, then a gated spawn plan

Answers *"what should we continue working on?"* / *"what has good follow-up
steps?"* — a different question from "which session broke", and one that used to
take a hand-written scan script plus `awk` over four repos' `CONTINUE.md` files.

The insight it encodes: **the answer is usually not in the transcripts.** They say
where work stopped; what to do next is written in each repo's own `CONTINUE.md` /
`BACKLOG.md`. So it ranks **repos**, joining sessions (who worked where, what a
limit cut off, what a human last asked, and whether a human drove it at all) ×
those docs' open items × git state (unpushed, dirty) × the present (a live session
in that checkout, quota headroom per account).

- Every score term prints its own reason — the ranking is readable, not trusted.
- Two exclusions, always reported rather than silent: a repo that already has a
  **live session** (`--include-live`), and one that is merely **recent** with no
  open work (`--include-thin`).
- `--plan` writes a spawn plan with every entry `approved: false`. A human picks
  with `--review` (interactive) or `--approve --pick 1,3` (what an agent uses,
  since its stdin is not a terminal). `spawn.cmd -batch` then launches **only**
  approved entries. The gate can be answered, never skipped.

### Fixed: `resumable.mjs` listed subagents, with unusable resume commands

A subagent is not independently resumable — `claude --resume` takes the parent's
id — and a shared-account limit kills parent and children together. Measured: **9
of the top 10 rows were one parent's 20 research subagents**, burying the 3 real
cut-offs. Worse, each of those rows printed a resume command that could not work:
the profile home was derived by counting `dirname` hops, and a nested transcript
sits two levels deeper, so `CLAUDE_CONFIG_DIR` pointed at the *project directory*.

Subagents are now excluded by default; the home is anchored on the `projects` path
segment; and `--include-subagents` shows them labelled, pointing at the parent and
`subagent-results.mjs` instead of at a fake resume line.

### Fixed: it kept recommending work someone had already finished

A cut-off session whose work another session picked up outranks everything real,
because severity and recency both favour it. `resumable.mjs` now separates those
into an **ALREADY CONTINUED** block (`--include-continued` to rank them anyway).

Evidence is graded, and only strong evidence may hide a row: spawn-session's
**ledger** (`~/.spawn-session/ledger.jsonl`), or a **handoff brief** whose filename
a later transcript quotes. A same-repo **id mention** is a hint only, annotated in
place — treating it as fact suppressed two genuinely open cut-offs, because a
session that merely *analyzed* the fleet mentions every id. A would-be successor
naming three or more distinct candidates is now read as analysis and dropped.

### Changed: `session-resume --launch` delegates to spawn-session

It used to write its own per-session `.cmd`, which set `CLAUDE_CONFIG_DIR`, `cd`'d,
and ran `claude` — and nothing else. Because `wt.exe` hands the launching
process's environment to the new tab, every session it relaunched from inside a
Claude session inherited `CLAUDE_CODE_CHILD_SESSION=1`, **which turns transcript
saving off** — so a resumed session could not be resumed again, silently. It now
calls `spawn.cmd -resume`, which scrubs those markers, so there is one launcher
instead of two and the better one wins. `--print-commands` prints `spawn.cmd`
lines; `--launch` surfaces the preflight's refusals instead of hiding them.

### Also

- New shared libs: `lib/provenance.mjs` (was a session human-driven, board-launched,
  handoff-seeded or stop-hook driven), `lib/successor.mjs`, `lib/repo.mjs`.
- `classify()` no longer counts a launcher-**generated** handoff seed as a
  human-typed prompt, so prompt-style and human-driven measures are no longer
  inflated by one per spawned session. A custom `-m` message still counts.
- The capacity line these tools print never worked: `fleet status --json` prints
  its human table, and `execFileSync` on a `.cmd` throws `EINVAL` on Windows —
  indistinguishable from "fleet not installed". Both fixed (`snapshot --json`,
  run through the shell).
