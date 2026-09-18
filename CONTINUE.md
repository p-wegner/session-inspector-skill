# CONTINUE — claude-session-tools

Repo-wide pick-up notes. Three sibling skills since 2026-08-26: `session-inspector/`,
`token-budget/`, `spawn-session/`. Candidate work is in [`BACKLOG.md`](BACKLOG.md) (new today),
the per-agent tool coverage in [`docs/agent-feature-matrix.md`](docs/agent-feature-matrix.md).

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
