# CONTINUE — claude-session-tools

Repo-wide pick-up notes. Three sibling skills since 2026-08-26: `session-inspector/`,
`token-budget/`, `spawn-session/`. Candidate work is in [`BACKLOG.md`](BACKLOG.md) (new today),
the per-agent tool coverage in [`docs/agent-feature-matrix.md`](docs/agent-feature-matrix.md).

## 2026-09-20 — the agent feature matrix becomes data the tools read

**Why.** The skill is not agent-agnostic and never will be: Claude Code records things Codex and
Copilot do not. `docs/agent-feature-matrix.md` said so in prose, maintained by hand off the script
headers, and told its reader to "re-check a cell against the script before relying on it" — a doc
that asks not to be trusted.

**What changed.** `scripts/lib/harness.mjs` states, per agent, what its TRANSCRIPT carries (18
facts: per-call usage, cache read/write, tool io, subagents, hooks, compaction, rate limits, …),
each absent fact carrying the sentence explaining why. A tool declares which facts it `needs` and
which agents it is `wired` for; a cell is derived (`y` / `cand` / `n/a`), so a tool cannot claim an
agent whose data is missing — `cell()` throws and the generator refuses. Two consumers:

- **`scripts/harness-matrix.mjs --write`** regenerates `docs/agent-feature-matrix.md`;
  `--check` and `test/harness.test.mjs` fail when the checked-in file drifts.
- **Tools refuse instead of printing zeros.** `refuse(tool, agent)` prints one line naming the
  missing field and its reason and exits 3 (wired in `token-sinks`, `cache-health`), and
  `declareUnsupported(tool, reach)` puts the skipped agents in the `reach:` line of the
  Claude-only fleet tools (`fleet-stats`, `context-growth`, `cold-cache`, `waste`).

Claude Code stays the reference implementation and the Claude-only concepts (subagent transcripts,
the attachment prefix, compaction rows, cache pricing, hooks) are deliberately **not** abstracted.
The adapter split of `lib/sessions.mjs` / `lib/parse.mjs` into one module per agent is written down
in the matrix's "Adding an agent" section and deliberately not done: three verbs, when a second
agent needs one.

**Verified:** `node --test test/*.test.mjs` → 155 pass, 0 fail (5 new); `harness-matrix.mjs --check`
green; `cache-health --agent copilot` and `token-sinks --provider copilot` both exit 3 with the
reason; `cold-cache --days 2` prints "codex/copilot not read" with a line each. **Unverified:** the
fact table is read off the parsers and the old hand matrix, not re-measured against a rollout per
fact — a wrong `true` would show up as a tool claiming an agent it cannot serve.

**SKILL.md description narrowed** to what is true per agent (it used to list all three at equal
weight, which the old matrix itself flagged as over-promising).

## 2026-09-19 — cost lab: a `cost` lens on `session-dashboard`, as a page and as `--md`

**Why.** Asked for: tune session-inspector for the token / cost use case in five rounds, and build
a dashboard for it; the CLI must answer the same questions for an agent. The lab ran on the
target card `session-inspector/references/lab-cards/cost.md`: one session's cost, 10 questions,
keys built by agents forbidden to use this skill, Sonnet consumers reading one render only, an Opus
judge per round, one held-out session never tuned on.

| Round | dash score (mean) | wrong per consumer |
|---|---|---|
| r0, the pre-lab page | 0.09 | 2.5 |
| r1 | 0.56 | 1.25 |
| r2 | 0.59 | 0.5 |
| r3 | 0.65 | 2.5 |
| r4 | 0.69 | 2.0 |
| r5 (HTML and `--md`, equal at 0.752) | 0.75 | 0.75 |
| **held-out**, pre-lab page → r5 | 0.07 → 0.58 | 2 → 0; `--md` = HTML |

**What changed.** New `scripts/lib/lenses/cost.mjs` (main thread + every subagent transcript, in $:
split, context bands, per-thread TTL and cold re-writes, phases cut at prompts and compactions,
loop-steered share, 60-min stretches, levers with a basis, carry cost of what filled the context,
the fixed prefix incl. nested CLAUDE.md, subagents by wave and role, Claude Code's `cost-state`
beside the transcript total) and `lib/lenses/render-md.mjs` (`session-dashboard --md`, the same
lens object as Markdown). **Counting fix found by a key builder:** a subagent's `output_tokens`
grows across the rows of one call; `lib/usage.mjs lateOutput()` adds it, wired into `token-sinks`,
`lib/quota.mjs`, `lib/turns.mjs`, and (same day, BACKLOG 18) `cache-health`, `quota-report` and
`lib/parse.mjs`; `cold-cache` and `context-growth` do not read output. One subagent transcript
moved $12.97 → $14.29 in `cache-health`. Stop-hook and
goal check-in text is no longer counted as a human prompt (`lib/prompts.mjs`). This commit also
carries the Spec Kit dashboard work (`session-dashboard`, `verify-runs`, `message-stats`,
`lib/turns|metrics|locate`, the speckit lens) that sat uncommitted since 2026-09-18, which the lens
builds on.

**Verified:** `node --test test/*.test.mjs` → 135 pass, 0 fail (8 new in `test/cost-lens.test.mjs`);
`quota-report` smoke-run on a real profile with subagents;
the round table above; the page checked with playwright-cli at 1280 px and 390 px (no horizontal
scroll after wrapping tables). **Unscored:** five fixes made after the held-out judge (nested
CLAUDE.md, skill-listing deltas, the prefix floor incl. the first call's cache write, a re-write
after a compaction not charged to idle, the headline lever excluding price swaps) and the
`cost-state`-per-process wording; each checked by re-rendering and by a test, no consumer has read
them (BACKLOG 19). **Caveat on the held-out number:** the held-out key builder's five-line summary
reached the author mid-lab; no change was made from it, but the held-out was not blind to the author.
**Weakest area left:** sizing the prose prefix (A's CLAUDE.md stack still ~26% under its key,
BACKLOG 20); whether subagents were *justified* needs judgement and stays out of reach.

## 2026-09-19 — `session-compact.mjs`: a fork with its tool traffic cut, the conversation kept

**Why.** A fork carries everything at full price; a handoff brief carries a summary and drops the
conversation. The agent-pick branch wizard wanted the form between: fork the transcript and
**modify its history** rather than open a new session with a prompt. `lib/compact.mjs` (pure,
lines in / lines out) keeps every line, uuid and parentUuid, every prompt and assistant text, and
rewrites only `tool_use.input` and `tool_result.content` before the cut-off — `pairs` (head + tail,
shape-preserving, is_error keeps double) or `narrate` (one line each way: `Read src/a.ts`,
`Bash: … — desc`, `200 lines`, `ERROR: … (+30 lines)`); the sidecar `toolUseResult` /
`wireToolInputs` shrink type-preservingly. Calls after the last `--recent` prompts (1) stay
verbatim; a compaction summary is not a prompt. `session-compact.mjs <locator> --fork` writes the
copy beside the source under a new id (`SESSION_ID:` / `PATH:` on stdout, `--json` carries the
rendered `report`); `--out`, `--in-place` (refuses a live file), `--dry-run`. Reference:
`session-inspector/references/session-compact.md`; a row in `SKILL.md`; a pointer in
`resume-and-handoff.md`.

**Measured** (Claude Code 2.1.278, `claude -p --resume --model haiku`, first turn, cold cache, same
cwd) on an uncompacted 34-call, 3-prompt session: fresh session 59.6k tokens, plain copy 99.5k,
`pairs --recent 0` 83.7k, `narrate --recent 0` 78.7k — the history 39.8k to 24.1k / 19.0k, all
three resumed and answered. Two findings on the way: a session that was **already compacted**
gains nothing (the resume starts at the summary; the first fixture was one and showed identical
context for every copy); and Claude Code's own time-based microcompact (`[Old tool result content
cleared]`, in the binary) did not fire at 99.5k with timestamps a month old or two minutes old.
The chars/4 estimate the tool prints (58 % smaller) overstates the context saving (40 %): JSON
tokenises worse and the resume re-injects reminders — the reference says to quote the table.

**Second half, same day — two depths that use a model, on a profile of their own.** `--mode llm`
batches the calls (~20 / 24k chars) and has a model write `did` / `got` per call through a
headless `claude -p` under `--llm-settings` / `--llm-config-dir` / `--llm-model`
(`lib/narrator.mjs`; floor 3.4k tokens a call with `--system-prompt`, `--tools ""`,
`--setting-sources ""`, `--no-session-persistence`; a skipped call falls back to the string
cut). `--mode summary` writes the copy whole and runs Claude Code's own `/compact` on it
headlessly (`lib/summarize.mjs`; the copy's account is fixed by its path, the cost is the
running total minus the copy's `cost-state`). The point of both: compact on the cheap profile,
resume on the strong one — agent-pick's wizard and cfork carry the profile and model rows.
**Measured** on the same fixture, first resumed turn: llm 77.8k (history 18.2k, $0.11 for 34 of
34 calls narrated by haiku in 3 batches, 36k in / 7.8k out), summary 62.3k (history 2.6k, $0.03).
The llm lines carry the facts the string cut drops (`39 node.exe total, 17 vitest workers;
parents: …`). **The provider round trip works:** both depths through the zai settings profile
(GLM via api.z.ai), then `claude -p --resume` of each copy on the default Anthropic account
(opus) answered a content question correctly; `/compact` took the Anthropic-signed transcript
without complaint. The first zai run landed on `glm-4.5-air` because the tool defaulted
`--llm-model` to `haiku` and zai maps haiku there — with a profile named, no `--model` is passed
now and the profile's `ANTHROPIC_MODEL` runs (re-run confirmed). Provider `$` figures are
Claude Code's estimate at Anthropic prices, not the provider's bill. Two probes on the way: `/compact` typed through Git Bash became a PATH
(`C:/…/git/2.55.0.2/compact`) and the haiku run continued the fixture's old work instead — a
slash command reaches `-p` only through `execFileSync` or PowerShell; and `total_cost_usd` of a
resumed `-p` call is the session's running total, not the call's.

**Verified:** `node --test test/*.test.mjs` → 150 pass, 0 fail (8 in `test/compact.test.mjs`, 7 in
`test/narrator.test.mjs` with the runner injected,
one of them pinning the bug that compacted everything when `--recent` exceeded the prompt count —
the first measurement compared two compacted copies and called them equal). The wizard's use of
it was driven in a real Herdr pane from the agent-pick side; the experiment copies were deleted.

## 2026-09-19 — lab scaffold from a blind LAB-mode run: three forms, a skill-triggers card

skill-design's new LAB mode ran blind on this skill ("lab the session inspector skill"). It found the
existing lab and extended it rather than rebuilding it. Its patches are applied:

- `references/lab.md` §0 names three forms, one per half of the skill:
  - eval rounds for what a consumer gets from an output (run twice);
  - a fixture bench for computed numbers (§5a, **not run**, BACKLOG 2);
  - a trigger drill for the description (§5b, run once on 2026-09-18 and now in the runs table).
- `references/lab-cards/skill-triggers.md` is the first filled card beyond handoff (**not run**).

It also found that the `SKILL.md` frontmatter did not parse as strict YAML (PyYAML: `mapping values
are not allowed here`) since `5771dc2`. The cause is four colon-space sequences in the description.
The value is now single-quoted, and PyYAML reads back the identical 599-char string. Claude Code
reads it unchanged. BACKLOG 1 carried a pointer into a pass that had been archived, so it now holds
its own "not yet" list.

**Verified:** all three skills' frontmatter parse with `yaml.safe_load`. Nothing else here has code;
the rest was verified by a read only.

## 2026-09-19 — the lab is part of the skill: `references/lab.md`

The eval loop both labs below ran is now the skill's **integrated lab**, a reference doc
reached from one row in `SKILL.md`. It holds the target card, a catalogue of targets (handoff,
run twice; cost, skill triggers and session review, not yet run), the roles and what each may
read, one round, prompt templates, the guards and the runs so far. It is documentation and
has no code of its own, so nothing verifies it beyond a read. Only the handoff target has
run, and a second target is BACKLOG 17.

## 2026-09-19 — operator-session lab: `brief.mjs` on a 15-hour `/loop` board session

**Why.** Same Lab route as the pass below, on a lengthy operator session: a `/loop` driving a
local board server over HTTP, merge trains, other agents committing in the same repo, one
compaction. Frozen keys from independent agents, two blind Sonnet receivers per round (mean),
one separate judge; a second operator session held out and never tuned on.

| Round | tuning (brief-only / total / wrong, mean of 2) | gaps recall / precision |
|---|---|---|
| r1 | 0.12 / 0.26 / 2.5 | |
| r2 | 0.28 / 0.43 / 0 | |
| r3 | 0.33 / 0.48 / 0.5 | 0.41 / 0.83 |
| r4 | 0.31 / 0.47 / 1.5 | 0.41 / 0.83 |
| r5 | 0.31 / 0.46 / 1.0 | 0.41 / 0.83 |
| **held-out**, committed tool before → r5 | 0.03 / 0.24 / 1 → **0.24 / 0.43 / 0** | – / 0.20 / 0.73 |

The tuning session plateaued from r3: its key leans on facts only a transcript reader gets. The
held-out gain came from the wakeup count, "pushed" meaning on the upstream, and the ticket ledger.

**What changed** (sections listed in `session-inspector/references/resume-and-handoff.md`):
`/loop` wakeups counted, not listed; vitest tallies (a duration is not a count); write calls to
local services grouped by route, timeouts flagged; tickets filed/named and whether a commit
merged each during or after the session; pushed = ancestor of the upstream, with the local branch
and a differing commit author named; own commits from its own `git commit` output; outside-repo
edits with before → after, reason and secret redaction; guard bypasses; the compaction summary
picked by kind; "do not re-chase" refutations with a disputed check; open items annotated with
their ticket's fate and tags since; the newest CONTINUE pass quoted by its open lead-ins; a
budget that grows with tool calls (4500 → 6500) and drops machine state last.

**Verified:** `node --test test/*.test.mjs` → 127 pass, 0 fail (10 new in
`test/operator-session.test.mjs`); the round table above. **Not verified by a round:** two fixes
made after the r5 judge. A merge now counts only when it is on HEAD (r5 had called a merge into a
train branch "merged", its one new wrong answer). And a `/loop` marker or an injected skill body is
never the Goal. Both were checked by re-rendering the two briefs: the false merges are gone and
the held-out Goal reads as the human's prompt. No receiver has read them (BACKLOG 12).
**Weakest area left:** the Goal / Next-step block on operator sessions (BACKLOG 15), then three
ledgers with no effect on the held-out (BACKLOG 16).

## 2026-09-19 — handoff lab: `brief.mjs` carries what the tracking files drop, plus `--gaps`

**Why.** Handoff briefs and CONTINUE passes were missing facts a successor needed: the human's
answers, the sources, live checks, whether the work landed, what happened after the session.
Five tune rounds (skill-design Lab route), each with 2–3 blind Sonnet receivers answering a fixed
10-question questionnaire from the brief plus at most 8 read-only commands, and a separate judge
grading them against frozen answer keys built by independent agents from the full transcripts.
The keys and transcripts stay out of this repo (real session content); only the numbers are here.

| Round | tuning session A (brief-only / total / wrong) | tuning session B | held-out C |
|---|---|---|---|
| v0 (HEAD before) | 0.26 / 0.58 / 1 | 0.02 / 0.17 / 6 | 0.04 / 0.23 / 0 |
| v1 | 0.48 / 0.70 / 2 | 0.22 / 0.44 / 0 | |
| v2 | 0.53 / 0.68 / 1 | 0.38 / 0.57 / 0 | |
| v3 | 0.67 / 0.80 / 0 | 0.27 / 0.52 / 0 | |
| v4 | 0.67 / 0.81 / 0 | 0.33 / 0.52 / 1 | |
| v5 | **0.85 / 0.90 / 0** | 0.29 / 0.49 / 0 | **0.39 / 0.56 / 2** |

One receiver per target and round, so a ±0.1 swing is variance (B's v3 and v5 drops were judged
as receiver and grading variance, not a worse brief). C was never tuned on: its key was built
after v4 froze, and nothing in v5 was changed after looking at its brief.

**What changed.** New `lib/session-facts.mjs` (one pass over a Claude transcript: prompts,
`AskUserQuestion` answers, sources with failed fetches dropped, runner tallies split per run,
the diagnosis after a failure, its own tracking-file writes incl. scripted ones, "Verified"
lines, links with resolved targets, per-user stores with commands and key-bearing files),
`lib/work-repo.mjs` (the work repo ≠ start dir, git history split at the session's end, where
its edits landed and whether pushed, commits that later changed its files, strikes in
`BACKLOG-landed.md` via `git log -S`), `lib/doc-gaps.mjs` + `brief.mjs --gaps`. `successor.mjs`
gained a fourth route (`seed`: a later session seeded with any launcher's brief).
`parseContinueDoc` keeps wrapped items whole. Sections are listed in
`session-inspector/references/resume-and-handoff.md`.

**Verified:** `node --test test/*.test.mjs` → 117 pass, 0 fail (13 new in
`test/handoff-facts.test.mjs`); the round table above. **Not verified by a round:** the two
changes made after round 5 on its judge's findings (later commits that changed its files;
word matches landing only on docs-only commits dropped). Both removed the held-out's two wrong
answers when the brief was re-rendered and read by hand. No receiver or judge has seen them.

**Weakest areas left** (judge, round 5): B's key is dominated by facts only a transcript reader
gets (design reasoning, a scratch probe's result); `--gaps` recall is 0.57 / 0.07 / 0.15, since
a token match misses paraphrase; numbered questions answered in prose ("1 a+b, 2 …") are not
paired like `AskUserQuestion` answers. See BACKLOG 12–14.

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
