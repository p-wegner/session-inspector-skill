# Fleet inspection — analysing a BATCH of sessions

The first-class guide for the aggregate question: *"we just ran a batch of
sessions — a build-out, a sprint of tickets, a day's work, a parallel fleet of
builders — how did they behave, which are the outliers, which GROUP was faster /
cheaper / cleaner, and what should we change?"*

This is distinct from debugging one session (the `analyze-*-session.mjs`
analyzers) and from the billing total (`token-sinks.mjs`). Fleet inspection is
about **distribution, outliers, comparison, and turning those into a ranked list
of improvements**.

---

## 0. Principle: cache-read is the baseline, not the finding

In any multi-turn agentic session the raw token volume is **dominated by
cache-read by construction** — every turn re-sends the entire prefix, so the
cumulative tokens sent to the provider are mostly the previous turn re-billed.
"Cache-read is the biggest token sink" is therefore a *tautology*, not an
insight, and must not be reported as a noteworthy finding. `token-sinks.mjs`
already prices it in (cache-read ~0.1×).

What actually **varies between sessions and tells you where to look** is the
*shape*: how many turns, how big the context got, whether it grew smoothly or
spiked, how often the tooling failed, and how one group compares to another.
Lead every fleet report with those. Mention cost only as a per-group *delta*
("shopcart cost 30% more than taskflow for the same feature set"), never as a
headline "cache tokens dominate".

---

## 1. The metrics that matter (and how to read each)

| Metric | Why it matters | Tool |
|---|---|---|
| **Agent turns** (mean/median/p90/max) | Central measure of how much loop each task took. A group with 2× the median turns for the same work has a friction or scoping problem. | `fleet-stats.mjs` |
| **Wall-clock duration** | Human-facing throughput. Compare across groups; correlate with turns. | `fleet-stats.mjs` |
| **Peak context** (max single-turn ctx) | How close a session ran to the window. High peak + no compaction = premium-tier tokens + risk of truncation. | `fleet-stats.mjs`, `context-growth.mjs` |
| **Sudden context growth** (biggest single-turn jump) | An outlier jump means one injection bloated the context — a whole-file read, a test-result dump, a subagent report. Always explainable and usually fixable at the source. | `fleet-stats.mjs` → `context-spikes.mjs` |
| **Tool-fail rate** | Where the tooling fought the agent. A group with a high fail rate points at a stack/command/permission problem, not the model. | `fleet-stats.mjs`, `tool-failures.mjs` |
| **Command re-runs** | Retry-loop signal — the same command issued again = something didn't work the first time. | `fleet-stats.mjs`, `incidents.mjs` |
| **Cut-offs** (usage/rate limit) | Sessions that ended incomplete and are resumable. | `fleet-stats.mjs`, `resumable.mjs` |
| **Dup-reads / injection waste** | Re-reading a file already in context, reading generated artifacts whole. | `waste.mjs` |
| **Skill invocations** | Are the agents even using the skills that were materialized for them? Often zero. | `skill-usage.mjs` |

---

## 2. The fleet-inspection workflow (run in this order)

1. **`fleet-stats.mjs --project <p> --days N`** — distributions + outliers. Your
   orientation pass. Answers "what's normal here and which sessions broke the
   pattern".
2. **`fleet-stats.mjs --project <p> --by stack`** (or `--by project|model|day`)
   — the comparison table. Answers "which group was faster / cheaper / cleaner".
   Big deltas between groups are the highest-value levers.
3. **`waste.mjs --project <p>`** — what filled the context (dup-reads,
   whole-file artifact reads, repeated command output).
4. **`context-spikes.mjs --project <p> --by file`** — name the exact
   files/commands behind the sudden-growth outliers from step 1.
5. **`incidents.mjs --project <p>`** + **`tool-friction.mjs --project <p>`** —
   the friction sessions to deep-dive, and the recurring cross-session command
   chains worth fusing.
6. **`skill-usage.mjs --project <p>`** — which materialized skills never fired.
7. Deep-dive the top 2-3 outlier sessions with
   `analyze-claude-session.mjs <path> --friction` / `--events`.

---

## 3. Cross-build comparison — the `--by stack` axis

When comparing **parallel build-outs** (e.g. three toy backends built at once),
`--by project` usually fails: once a worktree is cleaned up its git remote is
gone, so `projectIdentity` falls back to the unique worktree path and every
ticket becomes its own group. **Group by `stack` instead** — the stack is
stamped on every command (`gradlew`, `uv run pytest`, `pnpm vitest`) and
survives cleanup (see `lib/stack.mjs`). The comparison table then reads as
"the Kotlin build-out took N more median turns and had a 2× fail rate vs the TS
one" — which is exactly the signal that separates a *stack* problem from a
*board* problem.

Read the table's columns as levers: a group that's high on **fail% + reruns**
has a **tooling** problem (§4.B); high on **turns + duration** for the same work
has a **scoping / organization** problem (§4.C); high on **peak ctx + sudden
growth** has an **injection** problem (§4.A/E).

---

## 4. Predefined suggestion categories (the taxonomy)

Every finding a fleet inspection produces should be filed into one of these
categories, because *the category determines where the fix lives* — a global
prompt line, a stack file, a board feature, or a code change. Rank suggestions
within each category by frequency × persistence-weighted cost.

### A. Generic agent-behaviour (stack-agnostic, cheap, injectable everywhere)
The reusable wins that apply to any repo — fix once in a global note / skill.
- **Verbose command output kept whole** — build/test runs dumped in full then
  re-billed every later turn. → run tests with a quiet flag and a summarized
  failure tail, not the raw log.
- **Reading generated artifacts whole** — JUnit/gradle XML, coverage reports,
  seed dumps read start-to-finish. → parse/grep the failures, never inline the
  whole report.
- **Re-reading a file already in context** — → reuse the copy; don't Read twice.
- **Whole-file reads of large sources** — → ranged reads / grep-first.

### B. Per-stack tooling (attach to the stack's notes / a `verify` verb)
Friction unique to one stack; the fix is a stack-specific command or note.
- **JVM/Gradle**: `2>&1` in PowerShell flips a *passing* build to a reported
  failure (PS wraps native stderr as ErrorRecords) → retry loops; Gradle daemon
  contention + `in-progress-results-*.bin` races across parallel worktrees;
  slow cold builds bloat context. → a canonical quiet, exit-honest gradle test
  command; per-worktree `GRADLE_USER_HOME`.
- **Python**: `uv` re-discovered (`Get-Command uv`) every session; pytest
  verbosity. → bake `uv` onto PATH in setup; `pytest -q`.
- **Node/TS**: `tsc --noEmit` → `vitest` run as two steps every time; `vitest
  related` broken in v4. → a single stack `verify` verb.
- *General pattern*: **every stack should have ONE canonical `verify` command**
  (quiet, summarized, exit-code-honest) so builders stop hand-rolling the
  pipe-and-select incantation that breaks.

### C. Project / build-process — compounding engineering (the board owns these)
The highest-leverage, project-specific category: change how the *build-out
itself* is run so later work is cheaper. These are **board features**, not agent
prompts.
- **Maintained per-stack + per-app CLAUDE.md** — a mechanism that keeps a
  living gotchas file per stack and per app, and injects it into every builder
  worktree, so hard-won lessons (the `2>&1` trap, the canonical verify command)
  actually reach the workers instead of living only in a human's head.
- **Compounding setup steps, run once** — when enough code exists, do the
  agentic setup ONCE (scaffold hooks, agent skills, lint/test config, a domain
  map) and have later builders inherit it — rather than every builder
  re-discovering the same environment from scratch.
- **Ticket scoping** — size tickets so a worker owns a cohesive, low-overlap
  slice; flag tickets that are too broad (high turns/duration outliers) or too
  fine (many tiny sessions re-paying setup).
- **When to parallelize** — serialize the *foundation* (shared scaffolding, core
  domain, registration files), THEN fan out. Early parallel work is
  measurably the most frictionful: shared-file contention and base-branch drift
  dominate the first wave. The board should hold back parallelism until the
  seams exist.
- **Code organization for multiple workers** — a more modular layout (clear
  module seams, per-feature files instead of shared god-files) lets parallel
  workers avoid each other. When contention shows up in the fleet, the fix is
  often *structural* (split the shared file), not procedural.

### D. Board / workflow mechanics
Operational friction in how the board drives builders.
- **Relaunch / handoff churn** — many builders start from a `SESSION HANDOFF`
  paste (frequent relaunch), each re-paying context. → compact the brief;
  investigate over-eager stall detection.
- **Worktree provisioning** — install vs junction, daemon/home isolation.
- **Skill-usage gap** — builders invoke *zero* skills despite them being
  materialized (scope-guard, code-review paying context tax for nothing). →
  wire the skills the workflow actually wants into the builder prompt, or stop
  materializing dead ones.
- **Permission-grant gaps** — repeated "requested permissions to read" failures.
- **Review/reconcile hotspots** — auto-review sessions concentrating tool
  failures point at the review harness, not the builder.

### E. Context / token-shape
Where the context curve, not a specific command, is the problem.
- **Sudden-growth spikes** → trace to the source injection (`context-spikes.mjs`)
  and fix representation.
- **Long-context tax** → `/compact` or trim; sessions living above the premium
  tier for many turns.
- **Outlier sessions** → deep-dive; usually one avoidable dump explains most of
  the excess.

---

## 5. From signal → category → fix target (quick map)

| Observed in the stats | Category | Where the fix lives |
|---|---|---|
| One group has 2× turns/duration for same work | C (scoping/org) | board: ticket sizing, parallelism gating, modular layout |
| One group has high fail% + reruns | B (stack tooling) | stack CLAUDE.md / a `verify` verb |
| Sudden-growth outliers cluster on one file type | A / E | prompt note + summarize-at-source |
| Peak ctx high, no compaction | E | `/compact`, trim injections |
| Builders invoke zero skills | D | board: builder-prompt wiring |
| Same gotcha recurs across a stack's sessions | C (compounding) | board: maintained per-stack CLAUDE.md injected into worktrees |
| Handoff pastes on many sessions | D | board: relaunch/stall + brief compaction |
| Early wave of parallel work full of contention | C (parallelize-when) | board: serialize foundation, fan out after seams exist |

Deliver a fleet report as: (1) the comparison table with the one-line "which
group won and why", (2) the ranked outliers with their explanations, then (3)
suggestions grouped by the categories above — generic wins first (cheap,
universal), then per-stack, then the compounding board features (highest
leverage, most work).
