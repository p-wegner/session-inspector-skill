# CONTINUE — spawn-session

Current state, present tense. This repo is **local only** (no remote), so
machine-specific notes live here directly rather than in a `.local.md` layer.

## What is true today

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

## Next steps

- [ ] Settle the registry-id question above by eye, then record the answer here. LOW priority now that handoff, not resume, is the recommended path.
- [ ] `-batch` has only been dry-run end to end. Run one real approved plan.
- [ ] Verified by dry run only: `-from` + `-handoff` writing a brief for another
      profile's session. The brief header and machine-state panel were checked;
      a real launch off that brief has not been done.
- [ ] Consider having `preflight` warn (not refuse) when the target is a *worktree*
      of a repo that has a live session at its root — currently only an exact cwd
      match counts as a duplicate.
