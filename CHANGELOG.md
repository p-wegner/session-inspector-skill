# Changelog

User-visible changes, newest first. Updated sporadically on request, not per commit.

## 2026-08-26 — token-budget ships in this repo, as a third sibling

The `token-budget` skill (`tokt`: token counting, CLAUDE.md/skill bloat audit,
exact `claude -p` run cost, per-subagent session cost) was a separate repo
(github.com/p-wegner/token-budget). It now lives at `token-budget/` here, history
preserved via `git subtree`, so **one clone** gives you inspector + budget —
workshop participants do not have to install two repos. Junction/symlink it as a
third skill (`skills/token-budget`) and run `npm install` inside it once.
`session-inspector/scripts/skill-usage.mjs --cost` now finds the sibling `tokt.js`
relative to the repo, no junction needed. The old repo stays on GitHub as an
archive; new work happens here. Also: `tokt session <id>` now finds the transcript in
`$CLAUDE_CONFIG_DIR`, `~/.claude` **and sibling `~/.claude-*` profiles** — before, an id
from a non-default profile failed with "no transcript found".

## 2026-08-23 — spawn-session uses the standard skill layout

`spawn-session/` now has `SKILL.md`, `README.md` and the entry point `spawn.cmd`
at the skill root, and every helper (`spawn-session.ps1`, `batch.mjs`,
`preflight.mjs`, `make-handoff.mjs`, `ledger.mjs`, `trust-folder.mjs`,
`wait-for-agent.mjs`, `write-text.mjs`) under `scripts/`. **`spawn.cmd`'s path is
unchanged**, so PATH entries, junctions and spawn plans keep working. If you ran a
helper directly (`node spawn-session\preflight.mjs …`), it is now
`spawn-session\scripts\preflight.mjs`. `CONTINUE.md` moved to the repo root.

## 2026-08-22 — renamed: claude-session-tools

The folder was `session-inspector-skill`, which stopped being accurate once the
root became a container for two sibling skills — it read as
`session-inspector-skill/session-inspector/`. The local checkout is now
`claude-session-tools`.

Nothing in the code depended on it (every path is resolved relative to the repo),
so this is a checkout and junction concern only: repoint
`skills/session-inspector` and `skills/spawn-session` at the renamed folder.
The **GitHub repo is still named `session-inspector-skill`** and the remote URL
is unchanged — git does not care that the folder and the remote differ.

## 2026-08-22 (later still) — spawn-session ships in this repo, as a sibling

The launcher was a separate local repo. It is now `spawn-session/` here, with its
full history (`git subtree`), and its per-profile junctions were repointed — so
the skill works exactly as before, with nothing to reinstall.

**Both skills are siblings under the repo root**: `session-inspector/` and
`spawn-session/`, neither nested in the other, each junctioned into every profile
under its own name. The root holds only `README` / `CHANGELOG` / `LICENSE` and is
no longer itself a skill. If you had a `session-inspector` junction pointing at
the repo root, repoint it at `session-inspector/` — a checkout of this commit
otherwise gives that skill no `SKILL.md`.

Paths moved accordingly: `scripts/` and `references/` are now under
`session-inspector/`, so a bare `node scripts/foo.mjs` becomes
`node session-inspector/scripts/foo.mjs`. Nothing in the code hardcodes the
layout — `spawnCmdPath()` resolves the launcher from the repo root and keeps
fallbacks for both older layouts.

The split had been costing something concrete: the launcher path was hardcoded as
`C:\projects\andrena\spawn-session\spawn.cmd` in four places, and the
spawn-plan schema existed as two copies in two repos that had to stay in
agreement. Both are gone. `scripts/lib/spawn-plan.mjs` now owns the schema, its
validation, the gate (`approvedEntries`), and `spawnCmdPath()`, which resolves the
launcher relative to the repo — so a clone anywhere, or a junctioned copy, works.

## 2026-08-22 (later) — resume is no longer the default advice

`claude --resume` was treated as the way to continue a cut-off session. That was
backwards, and backwards in the worst case. Two structural reasons:

- **Resume cannot cross profiles.** The session is pinned to the account it ran
  on — and a session is normally cut off *because that account hit its limit*.
- **The cache is dead by then.** The prompt cache has a 1-hour TTL, so the first
  turn re-writes the entire context at 2x base input instead of reading it at
  0.1x — a **20x** multiplier paid before any new work.

Measured on the five real cut-off sessions on this machine (103k–295k peak
context): resuming them cold costs **$11.24** against **$0.56** warm, the largest
single one $2.95. A handoff brief is 2–5k tokens.

So both tools now recommend a **handoff** by default and print the priced reason:

- `resumable.mjs` leads with a ready `spawn.cmd … -handoff -from <id>` line, and
  shows the resume command underneath, annotated with what it would cost and the
  fact that it only works on that one account.
- `session-resume.mjs`'s rate-limited case became `FRESH` (was `CONTINUE`, i.e.
  resume). Where the refill can be priced, the price now decides — the old
  "short session" rule was only ever a proxy for "small context", and it is the
  worse measure once the actual size is known (a 2-turn session can carry 75k).
- The shared rule is `lib/resume-economics.mjs`. It returns `priced: false` when
  a transcript has no per-turn usage, and callers then fall back to their own
  heuristic rather than trusting a $0.00 estimate.

**`spawn.cmd -from <session-id>`** is new and load-bearing for this: `-handoff`
previously always described the *calling* session, so "hand off the session that
was cut off yesterday" produced a brief about the wrong session — or about nothing
at all when run from a plain shell. The brief's "from profile" line is now
verified rather than asserted, since a handed-over session usually lives under a
different account than the caller.

**Fixed: `<synthetic>` was reported as the model** of every limit-cut-off session.
The usage-limit banner is an injected message tagged `<synthetic>`, and
last-wins model detection picked it up — so the population most likely to be
priced or resumed had no usable model. This mattered immediately: one of the five
cut-offs is Fable at $10/Mtok, whose 146k context costs nearly as much to reload
as another's 295k, and the bug had priced it at the $5 default.

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
