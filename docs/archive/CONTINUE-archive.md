# CONTINUE — archived passes

Passes moved out of [`../../CONTINUE.md`](../../CONTINUE.md) once they were no longer the current
day's work. **Verbatim, newest first.** Nothing here was re-verified on the way in, and nothing
here is edited afterwards — it is the readable trail, not a second source of truth. Present tense
inside a section means "present tense on the day it was written". One section carried no date in
its heading when it was a standing section of the live file; a date was added to the heading and
nothing else.

## 2026-09-18 — tier 0: a declared floor, a 598-char description, the dead-skill denominator (BACKLOG item 6, landed)

**Why.** The skill-design analysis of 2026-09-18 (`docs/analysis/session-inspector-2026-09-18/`,
gitignored) returned **keep with changes** and three tier-0/tier-1 fixes. Tier 0 is the name and
description, paid on every turn of every session in six profiles.

**What changed in `session-inspector/SKILL.md`:**
- **`for-tier: B` declared.** Without a floor the capability lens can only publish `undeclared`
  and may propose nothing; it measured fit A=100 B=63 C=59 over 597 units. The floor is picked
  from the audience, not the contents: the weakest reader that realistically runs 35 Node tools
  over transcripts is a Sonnet/Haiku-class agent, here and in the public repo. At floor B the 37%
  classed `scaffolding` becomes proposable — that is a finding for the next pass, not a cut made
  here.
- **Description 725 → 598 chars** (~177 → ~150 tokens, paid six times a turn). It also stops
  promising three agents evenly: it now says *Claude and Codex fleet-wide, Copilot per session*,
  which is what `docs/agent-feature-matrix.md` actually shows.
- **The dead-skill denominator moved up into the `skill-usage` row.** "Dead" means never invoked
  *while available*; `avail` counts sessions that ran after the skill's first commit, and
  `too-new` / `loaded-only` are separate buckets. It was one link away in
  `references/fleet-skills-and-prompts.md:20`, and that list is the most quoted thing the skill
  produces.

**Verified — Trigger Drill, not a desk read.** Four cheap subagents, blind to which arm they held,
two per arm, 15 deliberately vague prompts (9 that must fire the skill, 6 that must not, competing
against token-budget, spawn-session, skill-design and code-metrics as the real menu):

| Arm | Fires on the 9 positives | False fires on the 6 negatives |
|---|---|---|
| old description (725 chars) | 13/18 | 0/12 |
| new description (598 chars) | **16/18** | 0/12 |

So the cut bought reach rather than costing it. The two residual misses are the boundary worth
knowing: *"what is eating all my context"* goes to token-budget in half the runs, and
*"how much quota have I got left this week"* reads as no skill at all. Widening for either would
steal token-budget's prompts, so both are left as they are.

- `node --test --test-concurrency=4 scripts/test/*.test.mjs`: 93 pass, 0 fail.
- The running session's skill list picked up the new description, so the frontmatter still parses.

## 2026-09-18 — history rewritten: file contents too, not only messages

The 2026-09-15 rewrite scrubbed commit messages only. File contents in history still carried the
employer's name (33 commits, plus 4 messages), **a client's name (3 commits) and a client product's
name (2)**. None of these were at the tip any more.

**What was done:** a pre-rewrite `git bundle` of every ref was taken first. Then
`git filter-repo --replace-text --replace-message` ran over a fresh mirror clone from GitHub, with
three case-insensitive rules read from the term list at run time: employer → `org`,
client → `client-a`, product → `product-b2`. Then `master` was force-pushed with a lease on the old
tip `18bfb6f`. **New tip: `9094e73`.**

**Verified, commit by commit against the bundle:**
- 93 commits both sides, with authorship and dates identical;
- same path sets, and all 169 changed files equal the original with only the three replacements applied;
- the 6 messages that differ beyond the replacements differ only in quoted commit hashes, which
  filter-repo rewrote to the new ones;
- **a fresh clone from GitHub scans clean against all 26 terms.**

No forks, no pull requests. Author and committer emails keep the work domain, which the user
confirmed is fine; inside file contents it now reads `org`.

**Any other clone must be re-cloned or hard-reset to `origin/master`**, because a `git pull` would
merge the two histories. That includes the other device. This checkout was moved with
`reset --mixed`, with the uncommitted work unchanged. `fix/continuations-stale-pass-detection` was
repointed to its rewritten commit (`a04c04b`). The stash `wip slash-goals (not mine)` still points
into the old history; it is local only and was left alone.

## 2026-09-18 — `cache-health` covers codex and opencode too

**`--agent claude|codex|opencode` on `cache-health.mjs`, same verdict for three agents.** Wanted to know
whether the gateway plateau (below) also hits the other two harnesses our gateway tooling launches.
Codex: `discoverCodex` now scans `~/.codex`, `CODEX_HOME` and `CODEX_HOMES` (`;`-list; a gateway
key's codex home is invisible from `~/.codex`), one `token_count` event per API response,
`input_tokens` includes the cached part so uncached = input − cached − cache_write; `parseCodex` gained
`cachedInputTokens`, `cacheWriteTokens`, `apiCalls`, `modelProvider` and the analyzer prints the cached
share. OpenCode: reads the SQLite store via `node:sqlite` (Node 22.5+, dynamic import so the other
modes still run on 18), `OPENCODE_DB` overrides the path; a provider on `@ai-sdk/openai-compatible`
records writes as 0, the tool says so. `--min-ctx` sets the "big call" line (claude 100k, others 20k).
`priceFor` normalises display names (`Claude Sonnet 5` prices like `claude-sonnet-5`); a model without
a list price prints `n/a` instead of the opus fallback. Verified: 38-call codex probe through the
gateway HEALTHY at 99% cache read; 38-call opencode probe (Sonnet 5 over chat completions) HEALTHY,
100% of a 294k context; `--session 3bcf8e3b` unchanged; 43 codex + 8 opencode sessions of two days
list without error. The measurements are written up in nexos-tools
(`docs/findings/2026-09-18-gateway-cache-codex-opencode.md`).

**Open:** codex sessions on a ChatGPT login land at 79–85% cache read and read as MIXED; OpenAI's
cache is best-effort, so the 85% HEALTHY line may be a notch high for that agent. Left as is until
someone needs the codex fleet view for a decision.

## 2026-09-18 — usage is counted once per API call; `cache-health` tells plateau from TTL expiry

**Every token sum in the inspector over-counted by 1.8x to 3x, and now does not.** Claude Code writes
one `assistant` row per content block of a streamed response, each repeating the same `message.id`
and the same `usage`. Seven loops summed over rows (parse, fleet-stats' second pass, token-sinks,
context-growth, cold-cache, quota lib, quota-report). Measured: 344 rows / 188 calls, 196 / 64,
153 / 65; and input, cache_read, cache_creation and output_tokens are identical across the rows of
one id, so first-row-wins is exact. `lib/usage.mjs` (`firstRowOf(msg, seen)`, one Set per pass, a
row without an id is counted) is wired into all seven. `parseClaude` gained `apiCalls`; its
`assistantTurns` still counts rows because every consumer means the loop length by it. Verified:
`quota-report --profile org_team_5x_2` fell from $519.68 / 4812 turns to $232.26 / 2513, all
six patched tools run clean, and 3bcf8e3b costs $14.64 against Claude Code's own `cost-state`
record of $14.72 for the same session.

**New `scripts/cache-health.mjs`.** One session (`--session <id|path>`, a path reaches transcripts
outside `~/.claude*`) or the fleet (`--days N`): per-call input / cache_read / cache_write, the TTL
in use, every call after a gap longer than the TTL, the backend from the message-id prefix
(`msg_vrtx_` Vertex, `msg_bdrk_` Bedrock), list cost against a healthy-caching counterfactual, and a
verdict: HEALTHY / PLATEAU / TTL-EXPIRY / MIXED / SHORT. Run on 436 subscription sessions of four
days: 0 PLATEAU, 14 TTL-EXPIRY, 293 HEALTHY. The one gateway session is PLATEAU at 21% cache read.
Documented in `SKILL.md` and `references/fleet-cost.md`.

**Open:** the scratch helpers that found this (`cache-split.mjs`, `session-cost.mjs`) are superseded
by `cache-health` and need nothing. The `costHealthy` counterfactual is a flat 97/3 read/write
model; good enough to rank, not to quote.

## 2026-09-18 — one price table, with current list prices

**`session-inspector/scripts/lib/quota.mjs` is the only pricing table now.** `token-sinks.mjs` and
`quota-report.mjs` carried their own copies and both had drifted: Sonnet priced at $3/$15 (Sonnet 4.6)
while every recent session runs Sonnet 5 at $2/$10, and no Fable row at all in two of the three, so
Fable 5.1 fell back to Opus prices. Both now import `costUsdTotals` from the lib. Rows gained a `cr`
column, the cache-read multiplier, because Fable 5.1 reads at 0.025x ($0.25/MTok) rather than 0.1x.
Row order matters: `sonnet-5` must precede the generic `sonnet` row, `fable-5-1` the generic `fable`.

**Verified against Claude Code's own accounting, not by reading.** Some transcripts carry a
`cost-state` line (`totalCostUSD`, per-model tokens). Session 3bcf8e3b's Fable 5.1 record, fed
through the new `costUsd`, returns $14.72 — the same figure to the cent. Then `token-sinks --days 1
--by model`, `quota-report --profile org_team_5x_2` and `fleet-stats --days 60` ran clean.

**Found while comparing a gateway session to subscription sessions** (2026-09-18): the gateway
session's cache_read sat pinned at 46–57k while input grew to 307k, every subscription session of
the same shape had cache_read at 93–98% of context. The write-up lives in the nexos-tools repo
(`docs/reports/2026-09-18-gateway-cache-plateau.md`). Two tool gaps it exposed, open: `context-growth --session` prints the total curve only, so the plateau is invisible
without a per-turn input/cache_read split; and `cost-state` is per process, so a resumed session's
record covers only its last leg and cannot serve as a session total.

## 2026-09-15 (5) — the clone root is derived, and the checkout names no machine

**Zero occurrences of the employer's name in any tracked file**, down from 38 across 10. The
working-tree half of the pass above, and it was a code change rather than a replacement: three
absolute paths were load-bearing — `spawn.cmd` *resolved targets* under one, `preflight.mjs` ran
`fleet.cmd` from another, `wait-for-agent.mjs` / `batch.mjs` / `make-handoff.mjs` shelled out to
`acp.js` at a third.

**New: `spawn-session/scripts/repo-root.mjs`.** One rule for all of them. The root is *derived* from
this file's own location (`<root>/<checkout>/spawn-session/scripts`, so three levels up), not
configured, so a fresh clone anywhere works with no setup. `SPAWN_ROOT`, `ACP_JS` and `FLEET_CMD`
override it for a layout whose repos are not siblings.

**`realpathSync` is the whole trick, and it was verified rather than assumed.** Every skill dir here
is junctioned into several Claude profiles, so without it the root resolves to `~/.claude/skills`.
`spawn.cmd` cannot do this in batch — `%~dp0` does not dereference a junction — so it asks
`repo-root.mjs --print` instead of carrying a second rule that would drift.

**Verified by running it, not by reading it:**
- `spawn code-metrics -n` still resolves the `-skill` hop, invoked **both** by full path and through
  the profile junction — the junction case is the one `%~dp0` would have got wrong;
- `SPAWN_ROOT=C:\projects` redirects resolution to a different root;
- an unresolvable target now names the root it tried and says to set `SPAWN_ROOT`;
- `preflight.mjs --json` came back `"room for ~6 more session(s)"`, so the derived `fleet.cmd` is
  not merely a well-formed path but the real one;
- `make-handoff.mjs` wrote a brief whose ACP lines carry the resolved `acp.js`;
- 87 tests pass (`node --test "session-inspector/scripts/test/*.test.mjs"`).

Docs took the same pass: profile-name and session-locator examples use `org` rather than one
employer, and the setup snippet says `<path to this checkout>` instead of one developer's disk.

## 2026-09-15 (4) — the published history stops naming the organisation

**87 commit messages were rewritten and force-pushed.** This repo's only remote is public GitHub,
and nothing had ever scrubbed it. A scan against the shared term list (`~/.claude/notes/confidential-terms.txt`,
read at run time — the list is never copied into a repo that publishes) found the employer's name in
23 places across 12 commit messages, and a client's name in 2 of them, as session locators of the
form `C--projects-<org>-<client>--8e3f1bec`.

**What was done:** `git filter-repo --replace-message` over a throwaway mirror clone, two rules
(the employer's name to `org`, the client's to `client-a`), then a force-push of `master` only.
`org` was already the placeholder this repo used elsewhere, so the locators stay well-formed.

**Verified, not assumed:**
- all 87 tree hashes are pairwise identical before and after, so the rewrite touched messages and
  nothing else;
- a **fresh clone from GitHub** scans clean against the full 27-term list — the check runs against
  what is actually published, not against the local tip;
- a pre-rewrite `git bundle` of every ref was taken first.

**SHAs changed from the root: `19ad3db` → `2bd62c2`.** Any other clone of this repo must be
re-cloned or hard-reset; a `git pull` there will try to merge two histories. The local
`fix/continuations-stale-pass-detection` branch had zero unique commits and was repointed to the
rewritten commit at the same position (tree hash confirmed identical).

**One thing deliberately NOT done:** author and committer emails still carry the work domain, on
all 87 commits. Unchanged by the rewrite. That is the committer's own work identity rather than a
client fact, and rewriting it would change authorship — a separate decision, not this one's to make.

## 2026-09-15 (3) — a session can be handed to the OTHER agent

**New tool: `session-inspector/scripts/brief.mjs`** — a harness-neutral handoff brief, written to
be read by a different agent than the one that produced it (claude → codex, codex → claude). The
judgement is in `scripts/lib/brief.mjs` and tested; the script resolves the session and does the IO.

Why it is not a resume: a session id cannot cross harnesses. `claude --resume <id> --fork-session`
and `codex fork <id>` both hand an id back to the tool that owns the transcript, and the two stores
are different formats in different trees.

**The rule it never breaks: it does not upgrade a claim.** A committed tracking file's record is
evidence, printed with its source; what the session said about itself is an assertion, printed under
"unverified". The token budget trims anchors, machine-state detail and the quoted last message —
never the evidence.

**Four defects found and fixed during the build, each invisible to reading the output:**
1. the vocabulary table rewrote a term inside a backticked flag name, inventing a flag. Code spans
   are now held out of the translation, and the two generic entries ("skill", "hook") were dropped.
2. anchors listed the previous session's temp scratchpad — a tree the receiver has no reason to
   trust and the OS may have cleared. Anchors are now repo-relative and temp paths are dropped.
3. the Goal section came out EMPTY for a seeded codex run, which is exactly the kind of session a
   handoff is about: its prompts arrive as `response_item/message` role `user`, and `parseCodex`
   reads only `event_msg/user_message`. Measured on a board-monitor run: 17 of the former, zero of
   the latter. `codexHumanPrompts` recovers them and skips the injected envelopes.
4. a `CONTINUE.md` with nothing itemisable rendered an empty section, which reads as "nothing is
   open". It now says so explicitly.

**Verified.** `node --test session-inspector/scripts/test/*.test.mjs` → **87 passed** (14 new), and
both directions were run live through the hotkey in `claude-pick`: the receiving codex session read
the brief, said the goal was not self-contained, said it was treating the unverified section as
unverified, and ran `git status` before touching anything. That behaviour — not "it continued" — is
the check.

**Not verified.** The copilot direction. `--for copilot` is accepted and neutral, but no copilot
session was handed anything.

## 2026-09-15 (2) — correction: the portability pass broke four PowerShell recipes

**`%USERPROFILE%` is cmd syntax and PowerShell does not expand it.** The pass above replaced one
machine's home directory with `%USERPROFILE%` everywhere, including inside four double-quoted
PowerShell strings, where it builds a literal path starting with a percent sign. Each of those
recipes then reports that no session file was found, with nothing to say why.

Broken: `references/claude-recipes.md:46` and `:78`, `references/copilot-recipes.md:28` and `:55`.
All four now read `$env:USERPROFILE`, **which is how the same two files already spelled it in six
places the pass never touched** — the correct form was sitting three lines above the broken one,
inside the same fence. That is the tell the substitution's own checks could not see: they asked only
whether the personal path was gone, and it was.

**Found by an independent reader, not by the pass.** A second rater reading this skill for a
capability judgement flagged it and named the failure mode exactly. The pass that introduced it had
reported "73 passed, same as before the change", which was true and did not cover a fenced example
no test executes.

**Verified this time by running it, not by reading it.** `$env:USERPROFILE\.claude\projects`
resolves and the directory exists; the `%USERPROFILE%` form resolves to a literal percent-sign path
that does not. `node --test session-inspector/scripts/test/*.test.mjs` → **73 passed**, unchanged.
Zero `%USERPROFILE%` left under `session-inspector/`.

**Standing lesson for this repo:** a fenced command in a reference file is executable text that no
test runs. When a bulk substitution touches one, resolve it in the shell it is written for before
calling the pass done.

## 2026-09-15 — session-inspector: portable off this machine for the first time

Found by a capability pass on the skill, which flagged 19 fenced programs carrying one
machine's absolute paths. The survey then turned up something worse than untidy text: two
of the tools could not work anywhere else.

**The two real bugs.**

- **`quota-multi.mjs` and `quota-month.mjs` could find no profiles at all.** Each carried
  its own copy of `discoverProfiles()` matching one team's literal profile prefix, so on
  any other box the list came back empty and both exited 1 with "No ... profiles found".
  `lib/config.mjs` already implemented the sibling-profile convention portably, with env
  overrides, and neither tool used it. Discovery is now `authProfiles()` there, once:
  every `~/.claude-<name>` with a `projects/` dir, personal `~/.claude` excluded unless
  asked, and `$CLAUDE_PROFILES` as the escape hatch that replaces editing a regex.
- **`continuations.mjs` never reported capacity off this machine.** `fleetCapacity()`
  hard-coded one absolute path to `fleet.cmd` and returned `null` when absent — identical
  to "fleet not installed", so the failure was invisible. Now `$FLEET_BIN`, then PATH,
  then a sibling checkout beside this repo. **Worth knowing: `fleet` is not on PATH on the
  author's box either**, so a PATH-only fix would have regressed it here; the sibling
  lookup resolves the same binary the hard-coded path did.

**Display without a baked-in family.** `shortProf` stripped one team's literal prefix. It
is now `profileShortener(profiles)` in `config.mjs`, which strips the longest common prefix
of the actual set and only cuts on a separator, so `acme_team_5x`/`acme_team_9` never
degrade to `x`/`9`. Same output as before on this machine.

**`skill-usage.mjs` and `lib/spawn-plan.mjs`** each ended their otherwise-portable
candidate lists with one personal absolute path. Dropped; `spawn-plan` gains `$SPAWN_CMD`.

**The text.** This repo is on public GitHub, so personal and device references are noise to
every reader but one — and here several were examples people copy. Replaced across 23
files: the user's home path became `%USERPROFILE%` in prose and `$env:USERPROFILE` inside
PowerShell (see the correction below), the profile family became `acme_team*`
(matching the `acme` placeholder the repo already used), a real worktree and branch name
became a neutral one of the same shape, and **two real session UUIDs** became obviously
synthetic ones. Also fixed one path whose backslashes had been eaten somewhere upstream,
leaving the segments run together.

**Checked against the scrub list** (`~/.claude/notes/confidential-terms.txt`, 25 terms,
parser positive-controlled): **zero** client or engagement terms in this repo, before or
after. This was a portability and personal-reference problem, not a confidentiality one.

**Verified.** `node --test scripts/test/*.test.mjs` → **73 passed**, same as before the
change. `authProfiles()` returns the same four profiles and `profileShortener` the same
short labels as the hard-coded versions did. The no-profiles error path prints the new
actionable message. No control bytes in any changed file.

**One caveat.** Four test files had fixtures rewritten: a first pass changed an expected
slug without its input and broke `cwdToSlug matches Claude's project-dir encoding`, because
the input used escaped double backslashes the pattern missed. Inputs and expectations are
now changed together, and the suite is green — but these are string fixtures, so a reviewer
should confirm the pairs still read as intended rather than trusting the count.

**Not done.** `spawn-session/SKILL.md` and `spawn-session/README.md` still contain one
personal home-path example each, and this file's own older entries plus `CHANGELOG.md`
mention personal paths. Out of scope for this pass, which was `session-inspector/` only.

## 2026-08-22/23 — spawn-session: the subtree move into this repo

The rest of this file concerns `spawn-session/`. Current state, present tense. Since 2026-08-22 this skill is one of **two sibling
skills** in the session-inspector repo (`spawn-session/` beside
`session-inspector/`, neither nested in the other), which does
have a GitHub remote — so keep anything genuinely machine-specific out of here,
or in a gitignored `*.local.md` beside it.

The move brought the full history over (`git subtree add`) and the per-profile
`skills\spawn-session` junctions were repointed to the new path; verified by
resolving `spawn.cmd` through every profile's junction. The old
`<clone-root>\spawn-session` is empty and carries a `MOVED.md`; it could
not be deleted because the PowerShell hosts of sessions launched from the old path
still hold a handle. Delete it once those tabs are closed.

## Verified (2026-08-22), and by what check

- **`-mf <file>`** — the prompt reaches the session as a file path. Checked with a
  prompt containing `(parens)`, a `;` and `"quotes"`: the dry run shows
  `-PromptFile "<path>"` and nothing is re-quoted. This is the fix for a real
  failure where `-m` with parentheses died in cmd with
  `"plus" kann syntaktisch an dieser Stelle nicht verarbeitet werden`.
- **`-m -`** — reads stdin; refuses an empty read (exit 65) instead of staging a
  blank prompt. Checked both directions.
- **preflight duplicate-session** — refused a second spawn into
  `<clone-root>\acp` while `acp-e5@org_team_5x_3` was live there, naming
  it and its pid. Exit 3.
- **preflight capacity** — reads `fleet snapshot --json`'s
  `system.headroomProcesses`. Two defects found and fixed while wiring it:
  `fleet status --json` prints its human table (so it never parsed), and
  `execFileSync` on a `.cmd` throws `EINVAL` on Windows — which was
  indistinguishable from "fleet not installed". Snapshot is cached in `%TEMP%`
  for 90s: 7.9s cold, 0.6s warm, so a batch pays once.
- **`-p auto`** — picked `org_team_5x_4` (5h at 4%) over `org_team_5x_2`
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
