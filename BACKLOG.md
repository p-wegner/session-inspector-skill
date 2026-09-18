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

## 6. Tier-0 and SKILL.md fixes from the 2026-09-18 analysis

- Declare `for-tier` in the frontmatter; without it the capability pass may propose nothing.
- Trim the 725-char description toward ~600, then run a trigger drill before keeping the cut.
  The description names Copilot, which the matrix shows as mostly unsupported in fleet views.
- Move the dead-skill availability caveat (`references/fleet-skills-and-prompts.md:20`) into
  the `skill-usage` row of SKILL.md; agents skip links, and that list is the most quoted output.
**Size:** small. No dependencies.

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

## Landed

Pointer only: see `docs/archive/BACKLOG-landed.md` once it exists.
