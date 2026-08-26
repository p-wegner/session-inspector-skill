# CONTINUE — claude-session-tools

Repo-wide pick-up notes. Three sibling skills since 2026-08-26: `session-inspector/`,
`token-budget/`, `spawn-session/`.

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
local checkout `C:\projectsndrena	oken-budget` was a *shallow* clone and could not
serve as a subtree source — "did not send all necessary objects"). Verified: `node
token-budget/test/run.js` → 12 checks passed after `npm install`; all five profiles'
`skills	oken-budget` junctions repointed here and `tokt.js count` resolves through
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

## spawn-session

The rest of this file concerns `spawn-session/`. Current state, present tense. Since 2026-08-22 this skill is one of **two sibling
skills** in the session-inspector repo (`spawn-session/` beside
`session-inspector/`, neither nested in the other), which does
have a GitHub remote — so keep anything genuinely machine-specific out of here,
or in a gitignored `*.local.md` beside it.

The move brought the full history over (`git subtree add`) and the per-profile
`skills\spawn-session` junctions were repointed to the new path; verified by
resolving `spawn.cmd` through every profile's junction. The old
`C:\projects\andrena\spawn-session` is empty and carries a `MOVED.md`; it could
not be deleted because the PowerShell hosts of sessions launched from the old path
still hold a handle. Delete it once those tabs are closed.

## What is true today

`spawn-session/` follows the standard skill layout since 2026-08-23: `SKILL.md`,
`README.md` and the entry point `spawn.cmd` at the skill root, every helper
(`spawn-session.ps1`, `batch.mjs`, `preflight.mjs`, `make-handoff.mjs`, `ledger.mjs`,
`trust-folder.mjs`, `wait-for-agent.mjs`, `write-text.mjs`) under `scripts/`.
`spawn.cmd` resolves them via `%~dp0scripts\`; `batch.mjs` reaches the sibling skill
via `../../session-inspector/scripts`. Verified by `spawn.cmd -h`, `node --check` on every script,
`preflight.mjs --pick-profile` and `batch.mjs` resolving `spawn-plan.mjs` after the move.

`spawn.cmd` is now the **only** session launcher on this machine. session-inspector's
`session-resume.mjs` used to write its own per-session `.cmd` that set
`CLAUDE_CONFIG_DIR`, `cd`'d and ran `claude` — and nothing else — so every session it
relaunched from inside a Claude session inherited `CLAUDE_CODE_CHILD_SESSION=1` and
**silently saved no transcript**. It now calls `spawn.cmd -resume`, which scrubs the
inherited markers. That consolidation is the reason `-resume` exists here.

## Verified (2026-08-22), and by what check

- **`-mf <file>`** — the prompt reaches the session as a file path. Checked with a
  prompt containing `(parens)`, a `;` and `"quotes"`: the dry run shows
  `-PromptFile "<path>"` and nothing is re-quoted. This is the fix for a real
  failure where `-m` with parentheses died in cmd with
  `"plus" kann syntaktisch an dieser Stelle nicht verarbeitet werden`.
- **`-m -`** — reads stdin; refuses an empty read (exit 65) instead of staging a
  blank prompt. Checked both directions.
- **preflight duplicate-session** — refused a second spawn into
  `C:\projects\andrena\acp` while `acp-e5@andrena_team_5x_3` was live there, naming
  it and its pid. Exit 3.
- **preflight capacity** — reads `fleet snapshot --json`'s
  `system.headroomProcesses`. Two defects found and fixed while wiring it:
  `fleet status --json` prints its human table (so it never parsed), and
  `execFileSync` on a `.cmd` throws `EINVAL` on Windows — which was
  indistinguishable from "fleet not installed". Snapshot is cached in `%TEMP%`
  for 90s: 7.9s cold, 0.6s warm, so a batch pays once.
- **`-p auto`** — picked `andrena_team_5x_4` (5h at 4%) over `andrena_team_5x_2`
  (5h at 24%). Ranks on 5-hour utilization, then 7-day, then live sessions.
  Excludes `~/.claude-*` dirs with no `projects/` — `.claude-share` is a
  shared-skills folder and was being offered as an account to spawn under.
- **`-batch`** — the gate holds: an all-`approved:false` plan exits 3 with the
  review instructions, a bad schema exits 1, and a 2-of-3 approved plan dry-ran
  both entries with per-entry profiles and a receipt table.
- **ledger** — `~/.spawn-session/ledger.jsonl` gets one line per spawn; confirmed
  written on a live launch.

## Resume is no longer the recommended path (2026-08-22)

`-resume` stays, but it is **not** what the tooling now advises for a cut-off
session, and the open question below matters much less as a result. Two structural
reasons, both worst in exactly the case that makes you reach for it:

- **It cannot cross profiles.** The session is pinned to the account it ran on —
  and a session is normally cut off *because that account hit its limit*.
- **The cache is dead by then.** 1-hour TTL, so the first turn re-writes the whole
  context at 2x instead of reading it at 0.1x. Measured across the five real
  cut-offs on this box: $11.24 cold against $0.56 warm, before any new work.

So prefer `-handoff -from <session-id>`, which runs on any account (`-p auto`) and
costs cents. `-from` is the flag that makes this possible at all: before it,
`-handoff` always described the *calling* session. The rule lives in
session-inspector's `lib/resume-economics.mjs`.

## Unverified — and specifically what is not proven

**Whether `-resume` actually continues the prior conversation.** The wiring is
verified: the dry run shows `-ResumeId "<id>"`, and a live launch started claude in
the right cwd under the right profile (`spawn.cmd … -resume 58656cf0-… -safe`, pid
32284, registry under `.claude-andrena_team_5x_2`). But the session's registry entry
carries a **new** session id (`f67071d0…`), the old transcript's mtime did not
change, and no new transcript had been written yet — so from outside the TUI the
resumed and fresh cases look identical.

Two things were tried and did NOT settle it:
- An ACP message asking the session whether it had prior context — no reply while
  it sat idle.
- A control tab running plain `claude --resume <id>` without this launcher — it
  never registered a session, because a hand-rolled launcher does not pre-accept
  the folder-trust dialog (which `spawn.cmd` does via `trust-folder.mjs`). The
  control was therefore stuck on the trust prompt and proved nothing.

Note the resume semantics are Claude Code's, not this repo's — `resumable.mjs` has
always printed `claude --resume <id>` and this only changes which launcher runs it.
The open question is narrow: **does the session registry report a new id for a
resumed session?** Settle it by looking at one resumed tab and seeing whether the
conversation is there.

Also unverified: `-resume` against a session with **no messages** starts a fresh
session — observed with a 9-line transcript whose first entry was
`queue-operation`. That looked like a launcher bug for a while; it is not, but a
caller feeding ids from `session-resume --between` should expect it.

## What the merge changed in the code

- `spawnCmdPath()` in `../session-inspector/scripts/lib/spawn-plan.mjs` resolves this launcher
  relative to the repo, replacing a hardcoded `C:\projects\andrena\...` path in
  four call sites. A clone anywhere works, and so does a junctioned copy.
- `batch.mjs` imports the plan schema, its validation and the approval gate from
  that same lib instead of re-implementing them — they were two copies in two
  repos, kept in agreement by hand.

## Next steps

- [ ] Settle the registry-id question above by eye, then record the answer here. LOW priority now that handoff, not resume, is the recommended path.
- [ ] `-batch` has only been dry-run end to end. Run one real approved plan.
- [ ] Verified by dry run only: `-from` + `-handoff` writing a brief for another
      profile's session. The brief header and machine-state panel were checked;
      a real launch off that brief has not been done.
- [ ] Consider having `preflight` warn (not refuse) when the target is a *worktree*
      of a repo that has a live session at its root — currently only an exact cwd
      match counts as a duplicate.
