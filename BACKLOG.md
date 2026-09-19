# BACKLOG — claude-session-tools

Candidate work not in flight, ordered by value. Each item: why, rough shape, size, dependencies.
Items in progress move to `CONTINUE.md`. Landed items are struck here and moved to
`docs/archive/BACKLOG-landed.md` (create it on the first landing).

Most items come from a skill-design shape pass (2026-09-18). It classifies `session-inspector` as an
**Instrument** (code enumerates every transcript and computes each number) behind a **Toolsmith**
front door (the question → tool table), with fit `partial`. The two missing must-haves are published
reach and planted-defect fixtures. The outputs are consumed as data (`spawn-plan` by
`spawn-session -batch`, cost figures copied into reports), so a wrong count here does not stay in chat.

**No real transcript content goes into this repo.** It is public on GitHub. Fixtures are synthetic,
and analysis runs over real sessions stay in `docs/analysis/` (gitignored).

## 1. Published reach on every fleet tool — IN PROGRESS, see CONTINUE.md

## 2. A synthetic fixture corpus with expected numbers per tool

**Why.** The 6 test files cover lib pieces, `brief`, `continuations` and `live`, not one computed
number. The per-row usage over-count (1.8x to 3x across seven loops, fixed 2026-09-18) lived for
months and one fixture would have caught it.
**Shape.** `scripts/test/fixtures/` with hand-written `.jsonl`: repeated usage rows per message id,
a malformed line, a gateway plateau, a TTL gap, a subagent sidechain, a main-profile session, a
codex rollout. One test per fleet tool asserting totals and the reach counts from item 1. Grows
by one case per bug found. **Size:** medium. **Depends on:** item 1, so the tests assert reach too.

## 3. Versioned `--json` contracts for outputs with a consumer

**Why.** `--json` shapes are implicit; the census found no schema files. `spawn-plan` has a real
consumer, cost/quota JSON is next. **Shape.** A `contract: "session-inspector/<tool>/1"` field plus
the reach block in every `--json`, bumped on a breaking change. **Size:** small per tool.

## 4. `context-growth --session` shows the per-turn input / cache_read split

**Why.** The gateway cache plateau was invisible in `context-growth`; it prints only the total
curve. `cache-health` covers the verdict; this is the curve view. **Size:** small.

## 5. Agent parity, driven by the feature matrix

See [`docs/agent-feature-matrix.md`](docs/agent-feature-matrix.md). **Rule: an agent gets a
feature when its sessions exist and a question needs it**, not for symmetry. Today Codex is in use
(224 rollouts in 30 days on the work box, gateway runs included); Copilot has no recent sessions,
so nothing is built for it. The concrete Codex candidates and the description fix are in the matrix.

## 7. Codex cache-health threshold

Codex on a ChatGPT login lands at 79–85% cache read and reads MIXED; OpenAI's cache is
best-effort, so 85% HEALTHY may be a notch high for that agent. Wait until a decision needs the
codex fleet view. **Size:** small.

## 8. `cost-state` is per process

A resumed session's `cost-state` record covers only its last leg, so it cannot be a session
total. Either sum the legs or say so where `cost-state` is used as a check. **Size:** small.

## 9. `fleet capacity` row names the old `claude-pick` path

`SKILL.md` points at `claude-pick/fleet/fleet.cmd`. Correct on one box, wrong where the checkout
is `agent-pick`. Prefer `fleet` on PATH with the path as fallback. **Size:** trivial.

## 10. Quota views count an API-key profile as a subscription

`quota-multi` includes a profile that authenticates by `apiKeyHelper` (no subscription quota) in
its "subscription value" total and window detection; the reach line made it visible (2026-09-18).
Detect it (settings carry `apiKeyHelper`) and list it apart, or exclude it with a note. **Size:** small.

## 11. Read-off discipline for a fleet report — the two delivery findings still open

**Why.** The 2026-09-18 blind delivery run judged 17 of 18 spot-checks sound; the failures it did
find were in how the numbers were *read off*, not in the tools. Four of those findings landed with
the reach work (a `--top` slice, this session's own row, tool-friction's scope line, quota-multi's
discovery). Two did not:
- **Ratios may not cross tools, and one turn definition per table.** The six fleet tools report six
  different in-window session counts (722 / 501 / 551 / 574 / 577 / 860) under different filters,
  and the run's own summary mixed `fleet-stats` turn counts with `context-growth` turn indices, so
  "turn 134" read as 6% where the tool meant 15%.
- **A report's ordered summary must separate cost findings from correctness findings**, with the tax
  next to each. The run ranked a broken hook beside a context problem affecting 47% of turns with
  nothing to tell a reader which was worth a day.
**Shape.** Two rules in SKILL.md's "Rules that are easy to get wrong" (tier 1, where a report writer
is already looking), not a reference page. Possibly a `reach`-style denominator name in each fleet
tool's `--json` so a ratio across tools is refusable rather than merely discouraged.
**Size:** small. **Depends on:** nothing. The receipt is
`docs/analysis/session-inspector-2026-09-18/tune.json` (gitignored).

## 12. Handoff lab round 6: score the post-lab brief changes, with more than one receiver

**Why.** Five `brief.mjs` changes landed after a round-5 judge and no receiver has read them:
from the first lab, later commits that changed the session's files and word matches on
docs-only commits dropped; from the operator lab, a ticket merge counted only on HEAD, and
`/loop` wakeups and skill bodies never taken as the Goal. One receiver per target gave ±0.1 swings that masked real movement twice.
**Shape.** Same questionnaire, keys and judge (the lab dir is session scratch, so re-create it from
the CONTINUE 2026-09-19 pass or keep a copy outside the repo, never in it), three receivers per
target, and a fourth session as a new held-out. **Size:** one sitting, ~8 agents. **Depends on:**
nothing.

## 13. Numbered questions answered in prose

**Why.** On the held-out session the user answered the agent's numbered interview questions with
"1 a+b, 2 …" and never answered four others. `AskUserQuestion` answers are paired and shown; these
are not, so the decisions (and the unanswered questions) were missing from the brief and `--gaps`.
**Shape.** In `session-facts`: an assistant message with a numbered question list followed by a
human prompt that starts with numbers → pair them; the numbers never answered become "left open".
**Size:** small. **Depends on:** nothing.

## 14. `--gaps` recall is low where the file paraphrases

**Why.** Recall 0.57 / 0.07 / 0.15 on the three lab targets, precision ~0.7–0.9. The token match
cannot tell "recorded in other words" from "missing", and it compares against the file as it is
now, not as the session left it. **Shape.** Compare against the file at the session's end commit
(`git show <sha>:CONTINUE.md`) and read "prose" CONTINUE files by their bold lead-ins
(`**Next.**`), which the brief also prints as "Nothing itemised" today. A model pass to judge
paraphrase belongs outside the tool, as the caller's step. **Size:** small to medium.

## 15. Operator sessions: the session's own closing step loses to a later CONTINUE item

**Why.** Operator lab round 5, weakest area: on the tuning session the "start here instead" line
quoted a later session's CONTINUE item over the session's own last step ("ask before restarting
the stopped board"), and on the held-out the Next step was empty. **Shape.** Keep the session's
own closing step first whenever its last human instruction was a stop or a question, and show the
newer pass below it as context rather than as a replacement. **Size:** small. **Depends on:** 12 to
score it.

## 16. Operator sessions: three ledgers that did nothing on the held-out

**Why.** The round-5 judge found no effect on the held-out session from the outside-edit ledger
(scratch files the session created by shell under a per-user temp dir were missed; only
`Edit`/`Write` are read), the compaction and do-not-re-chase sections (it had no compaction
summary, so this is expected, not a defect), and the guard-bypass list (a `--force-*` flag the
human approved reads as a bypass). **Shape.** Read shell redirections and `cp`/`mv` targets
outside the repo; drop a bypass whose flag the human named in a prompt before it ran. **Size:**
small. **Depends on:** nothing.

## Landed

Pointer only, newest first — the struck sections live verbatim in
[`docs/archive/BACKLOG-landed.md`](docs/archive/BACKLOG-landed.md).

- ~~6. Tier-0 and SKILL.md fixes from the 2026-09-18 analysis~~ — **DONE** (2026-09-18)
