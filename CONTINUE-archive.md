# CONTINUE archive — claude-session-tools

Passes moved out of [`CONTINUE.md`](CONTINUE.md) once they stopped describing the current day.
**Verbatim, newest first.** Nothing here was re-verified or edited on the way in, so a claim in
this file was true when it was written and may not be true now. The live file is the one to
believe.

## 2026-09-08 — token-budget: Opus 5 priced, plus two defects found next to it

`tokt session` printed `$0.00000?` for every Opus 5 transcript: `src/pricing.js` had no
`opus-5` entry, so token counts were exact but cost was unavailable. Added at $5/$25 per
MTok. Verifying that rate against the claude-api skill (its model table +
`shared/models.md` + `shared/prompt-caching.md`) turned up two more:

- **Sonnet 5 was billed at $3/$15**, sharing one `/sonnet-4|sonnet-5/` pattern with
  Sonnet 4.6. Sonnet 5 is **$2/$10**; 4.6 is the $3/$15 one. Now two patterns, specific
  first.
- **Fast mode was unpriced.** It is a genuine premium tier — $10/$50, and only on Opus 5
  and Opus 4.8 — the transcript records it at `usage.speed`, and `costForUsage` already
  received that record. So a `/fast` session was silently costed at half. Read from
  `usage.speed`; no caller change.

Also gave Fable/Mythos 5.1 their 0.025x cache-read multiplier (a quarter of the usual
0.1x) rather than the flat rate.

**A 1M-context window is not a premium tier** — Opus 5's 1M window is its default *and*
maximum at standard pricing — so a `claude-opus-5[1m]`-style id needs no separate rate.
Written into the header comment because the bracketed suffix invites the opposite guess.

**Verified**: the new `test/run.js` check **fails against the old `pricing.js` and passes
against the new one** (confirmed by stashing the change), so it is a real regression
guard, not a test that has never failed. All 13 checks pass. Totals hand-checked against
the arithmetic per 1M of each token class: opus-5 standard 36.75, fast 73.50, 1h-TTL
write 40.50, fable-5-1 72.75. End to end, session `25cbd200` now reports **$21.9636**
instead of `$0.00000?`.

**Tried and rejected**: handling `usage.service_tier` (batch traffic bills at 50%). Every
record in the sampled transcripts is `standard`, and interactive Claude Code sessions
never batch — so it would be untestable code guarding a case this tool cannot see.

**Known, not ours**: `node --test test/` fails — `test/run.js` is a standalone script with
its own runner, not a `node:test` file, so the harness finds no tests. Fails identically
with our change stashed. Left alone; `node test/run.js` is the suite that actually runs.

## 2026-08-30 — continuations.mjs: tiered recency scoring + `--since-restart`

Recency was one flat "+10 if <48h" bucket, the same bonus at 2h and at 47h. Peter's
ask: after a device restart he wants to resume the last things he was doing even when
they have no CONTINUE.md/BACKLOG.md content yet. Two changes in
`scripts/continuations.mjs`:

- Recency is now tiered: +25 (<6h), +18 (<12h), +10 (<48h), +5 (<7d). A repo in the
  <12h tier also counts as having "substance" on its own, so the thin-work gate no
  longer hides it just because the docs haven't caught up.
- New `--since-restart` flag: sets the scan window to `os.uptime()`-derived boot time,
  turns on the thin-work bypass implicitly, and sorts the shortlist by recency alone
  instead of by score — "resume what I was last doing", not "resume the most-documented
  thing that's also recent".

**Verified**: existing 16/16 `scripts/test/continuations.test.mjs` still pass (no test
added for the new scoring/flag — reasoned and manually run against the live fleet
corpus, not unit-tested). `--json` output still parses; `--since-restart` on the live
corpus correctly windowed to boot time and sorted by `newest.endTime` descending.

**Not verified**: no dedicated regression test for the new tiers or `--since-restart`
in `continuations.test.mjs` — worth adding before the next scoring change touches this
file blind.

## 2026-08-27 — continuations.mjs: a superseded CONTINUE.md pass no longer sets the agenda

`continuations.mjs` ranked `agentic-kanban` #1 partly on work that had been done four
days earlier. Its `CONTINUE.md` had reached **2279 lines** against the convention's
~600-line archive trigger, so it carried two pictures at once: line 6 was a 2026-08-25
pass headed "#807 done", line 930 (in the 2026-08-23/24 pass) still read *"Operator:
decide the push. It unblocks #834 and #807 together."* The parser is positional, so the
stale line became the proposed top next step, reached a human, and was written into a
handoff brief before the live agentic-kanban session caught that #807/#831/#834 all
closed on 2026-08-26.

`lib/repo.mjs` now dates each level-2 pass (any `YYYY-MM-DD` in the heading, latest
wins) and marks an item from an older-than-newest pass `stale`. Stale items sort last,
print `⚠stale`, score ~1 instead of 3 (capped at 2), and the seed message tells the
spawned session to verify them. Docs past ~600 lines get a `⚠ DOCS` warning naming the
length and the stale count; `readRepoDocs` returns `warnings[]` and the plan JSON
carries `docWarnings`. **Demoted, never dropped** — a superseding pass does not always
restate what it replaced, so deletion could lose real work.

Undated headings are deliberately never stale: the convention's standing sections
("What is true today", "Next steps") carry no date and stay live.

**Verified**: 16/16 in `scripts/test/continuations.test.mjs`, 4 of them new and written
against this case. Against the real pre-archive file (`agentic-kanban@63b673855d^`,
2279 lines, 36 passes): 5 of 9 open items flagged stale, including the exact
"Operator: decide the push" line, `passDate` 2026-08-23 vs newest 2026-08-26. Against
`slidesmith/CONTINUE.md` (2770 lines, 28 dated passes): 0 stale — all five open items
are in an undated standing section — and the length warning still fires, which is the
intended split.

**Not verified**: the separate-cap scoring change is reasoned, not measured against a
real all-stale repo — none was in the corpus. On the case that prompted this, the score
barely moves (12+2 vs a saturated 15), because 4 of its 9 items were genuinely open; the
ordering and labelling are what actually fix that case, not the score.

**Found along the way, not acted on**: `slidesmith` (CONTINUE 2770 / BACKLOG 814 lines)
is past the archive trigger too. That is slidesmith's own housekeeping, not this repo's.

## 2026-08-27 — reread-causes.mjs: re-reads are mostly justified

New `session-inspector/scripts/reread-causes.mjs` classifies file re-reads by cause
instead of charging them all as waste (which waste.mjs still does, now labeled an
upper bound). Measured on the 3-day fleet (255 sessions, 7,213 reads): 50% of reads
are re-reads, but 83% of re-read tokens are pagination (different range/view of a
known file), 6% post-own-edit, 6% post-compaction — only ~1% is same-view pure
duplication. Edit→re-read rate is 6% (117 of 1,871 edits): Claude Code does NOT
re-read after every edit; the harness's "file state is current" note works. Verified
against sessions 9e5bbf50 and a9dd633c. Gray zone: a different view can still
re-fetch overlapping content (Read then cat) — counted legitimate-ish, not split
further. Gotcha fixed on the way: a NUL byte in a string literal made git treat the
new script as binary. Also: context-growth.mjs applies --session before reading
files (was a whole-corpus read, 5min+; now ~2s).

## 2026-08-27 — spawn-session: nothing crosses wt as an argument (-ArgsFile)

Root-caused the stray `spawn-session/Userspwegner…ps1` files (now deleted): on
2026-08-25 session `4994dc81` hand-rolled self-contained handoff launchers because
`spawn.cmd -handoff`'s seeded sessions came up without ever taking their first turn —
prompt/profile lost crossing cmd → wt.exe → PowerShell. Its second attempt (`node -e`
inside bash double quotes) lost one more backslash-unescaping level than expected, so
`C:\Users\…\launch-acp.ps1` became the drive-relative `C:Users…` and landed in the repo
cwd; the third attempt (Write tool) produced the correct files in
`~/.spawn-session/handoffs/`. Lesson: never generate Windows-path file content via
`node -e` in bash double quotes.

Fix, institutionalizing the session's workaround design: new `scripts/stage-launch.mjs`
stages EVERY launch parameter (prompt file, profile, session id, launch config dir,
resume id, noPrompt/safe/detect/noTrust, forwarded args) into one JSON file;
`spawn.cmd` passes only `-ArgsFile <json>` to `spawn-session.ps1`, which loads it first
(named params still win for direct callers). Also fixed on the way: the old wt line
never passed `-ResumeId` at all (`-resume` silently dropped the id), and the dry-run
`echo %MSG%` executed `&` inside prompts. stage-launch refuses flag-shaped values
because PS 5.1 drops empty `""` native args.

Verified: `stage-launch.mjs` with empty/hostile args → correct JSON;
`spawn-session.ps1 -ArgsFile … -DetectOnly` end-to-end (semicolon+backslash prompt
intact, short profile `5x_4` resolved, forward args carried); `spawn.cmd -n` dry runs
for seeded / `-b` / `-resume` all stage the right JSON. NOT yet verified with a real
tab+claude launch — next real spawn/handoff is the live test; watch that the seeded
first turn actually runs.

## 2026-08-26 — fleet cost tools: shared chunk-kind lib + 1h-cache pricing

Continuation of the usage-limit-cut session 9e5bbf50 ("fix the session tool findings").
Landed and verified:

- New `scripts/lib/chunk-kind.mjs` — shared classification for the fleet cost tools:
  `classifyHumanText` (skill_inject / compaction / handoff_brief / harness_inject /
  user_paste / user_prompt), `fileKey`/`bashVerb` (key Bash spikes by first file path,
  else `bash:<verb>` — now strips `for…do`/`while…do`/`if…then` scaffolding and
  keyword-matches basenames so `/usr/bin/env` is skipped), `shortPath` (root+tail path
  truncation that keeps worktree ids), `padTail`. `waste.mjs` and `context-spikes.mjs`
  both consume it; their private copies are deleted.
- Cost model: cache-write priced 2x for 1h-cache turns (read from
  `usage.cache_creation.ephemeral_1h_input_tokens`), 1.25x otherwise — in both
  `token-sinks.mjs` and `lib/quota.mjs`. Headers now state the session-selection
  criteria (provider, min turns, mtime window).
- Verified by: all five `scripts/test/*.test.mjs` green (69 pass / 0 fail, incl. the new
  `chunk-kind.test.mjs`), `node --check` on every changed file, and a 1-day smoke-run of
  waste/token-sinks/context-spikes/quota-report (outputs sane, new kinds appear:
  skill_inject 2.1%, compaction 4.2% of weighted).
- The suspected double-count in waste's top chunks (bnin2pzaq.txt twice) is **refuted**:
  the two entries are distinct tool_use ids (a cat and a later `sed -n '200,400p'` of the
  same persisted output) — genuine re-reading by that agent, not a counting bug.

## token-budget (merged 2026-08-26)

Brought in with `git subtree add --prefix=token-budget` from the GitHub remote (the
local checkout beside this repo was a *shallow* clone and could not
serve as a subtree source — "did not send all necessary objects"). Verified: `node
token-budget/test/run.js` → 12 checks passed after `npm install`; all five profiles'
`skills\token-budget` junctions repointed here and `tokt.js count` resolves through
them. `skill-usage.mjs` gained the in-repo sibling path as its second candidate
(after `$TOKT_BIN`). Open: the GitHub repo `p-wegner/token-budget` still exists
unchanged — decide whether to archive it with a pointer README; the old local
folder carries a `MOVED.md` and can be deleted once nothing holds it open.

## session-inspector (2026-08-26)

- `SKILL.md` is an index (~1.6k tok, `tokt skill session-inspector`); the former body is
  split verbatim into eight new `references/*.md`. Verified: `tokt skill` tiers, the
  four `scripts/test/*.test.mjs`, and a live `context-spikes --project agentic-kanban`
  run with the new classes. Cross-file "above/below" references were fixed and
  `fleet-tools.md` split into `fleet-cost.md`, `fleet-friction.md`,
  `fleet-skills-and-prompts.md`, `fleet-quota.md` (resumable prose moved to
  `resume-and-handoff.md`); `fleet-tools.md` is now the full command list + a pointer table.
  Verified: `tokt skill .` reports no orphan reference and every script/flag named in
  the pre-split SKILL.md (`git show 46fde1a:session-inspector/SKILL.md`) appears in the
  new skill + references.
- agentic-kanban's committed `.claude/skills/session-inspector` is gone (kanban commit
  `4ef871ebd7`); a gitignored junction points here. Board-only `scripts/session-rank.mjs`
  / `output-style.mjs` stay in kanban — candidates to port here if wanted.

## What the merge changed in the code

- `spawnCmdPath()` in `../session-inspector/scripts/lib/spawn-plan.mjs` resolves this launcher
  relative to the repo, replacing a hardcoded `<clone-root>\...` path in
  four call sites. A clone anywhere works, and so does a junctioned copy.
- `batch.mjs` imports the plan schema, its validation and the approval gate from
  that same lib instead of re-implementing them — they were two copies in two
  repos, kept in agreement by hand.

