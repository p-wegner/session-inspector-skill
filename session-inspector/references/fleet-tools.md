# Fleet tools — what each aggregate script answers, and its caveats

_session-inspector reference. Moved verbatim out of `SKILL.md` on 2026-08-26 so the skill body stays small; commands are run from the skill directory (`node scripts/…`)._

## Per-session vs fleet (aggregate across MANY sessions)

This skill debugs **one** session. For **aggregate, time-scoped questions across MANY sessions** — "which tools fail most in the last 48h", "what's burning tokens", "what did I ask yesterday", "how did this batch of build-out sessions behave and which stack was cleaner" — do **not** loop the per-session recipes. Use the bundled standalone fan-out scripts (they stat-filter by mtime FIRST, then parse only in-window files).

> **Fleet inspection is a first-class use case.** When the question is about a *batch* of sessions — a build-out, a sprint of tickets, a parallel fleet of builders — start with `fleet-stats.mjs` (distributions + outliers + `--by` comparison) and follow the ordered workflow, metric guide, and **predefined suggestion-category taxonomy** in **`references/fleet-inspection.md`**. That reference is the playbook for turning a fleet scan into ranked, correctly-filed improvement suggestions (generic → per-stack → compounding board features).
>
> **Do not headline cache-read as the cost.** In a multi-turn agentic workflow the raw token volume is cache-read-dominated *by construction* (every turn re-sends the prefix) — that's a tautology, not a finding. Report the things that actually vary: agent turns, peak context, sudden-growth spikes, tool-fail rate, and per-group deltas. `token-sinks.mjs` already prices cache-read in.

```powershell
node scripts/fleet-stats.mjs      # FLEET SHAPE + COMPARISON — turns/context/duration/fail distributions, sudden-growth & outlier lists, --by stack|project|model|day comparison table (--project, --days, --top, --json)
node scripts/token-sinks.mjs      # biggest token/cost sinks (--by project|day|model|provider|session, --days N, --json)
node scripts/tool-failures.mjs    # failed tool calls ranked (--by tool|project|error|day, --sort rate, --json)
node scripts/user-prompts.mjs     # real human-typed prompts (--date, --today, --days N, --tree, --json)
node scripts/prompt-style.mjs     # PROMPTING-STYLE profile (--project, --provider, --days N, --samples N, --json)
node scripts/incidents.mjs        # FRICTION ranking — which sessions to investigate (--project, --lens, --grep, --top, --json)
node scripts/continuations.mjs     # WHICH WORK to pick up next (sessions x repo CONTINUE.md x live x quota) -> human-gated spawn plan (--plan, --review, --approve/--pick, --project, --profiles, --days, --json)
node scripts/resumable.mjs        # CUT-OFF sessions to RESUME (rate/usage-limited) + exact resume cmd; subagents and already-continued sessions excluded by default; instant deaths grouped as relaunch-not-resume (--project, --cwd, --days, --latest, --resume, --interrupted, --include-subagents, --include-continued, --include-instant, --json)
node scripts/waste.mjs            # CONTEXT-TOKEN waste — where tokens go + what's avoidable (--project, --days, --top, --json)
node scripts/skill-usage.mjs      # SKILL audit — which .claude/.codex skills never fire (--project <substr>|--cwd, --repo-only, --cost, --days N, --provider, --include-plugins, --unused-only, --json)
node scripts/context-growth.mjs   # CONTEXT growth + auto-compacts + long-context (>200k) tax (--project, --session, --days, --threshold, --json)
node scripts/cold-cache.mjs       # COLD-CACHE tax — $ burned re-writing an expired prefix after idle/resume (--project, --cwd, --days, --gap, --session, --min-premium, --json)
node scripts/context-spikes.mjs   # CONTEXT SPIKES — the single injections that bloat context + WHY (huge-file/verbose/log-wall/…) + fix (--project, --cwd, --days, --min, --by class|tool|file, --session, --json)
node scripts/slash-goals.mjs      # SLASH-command usage + skill invocations + per-session goals (--project, --days, --top, --json)
node scripts/quota-report.mjs     # SUBSCRIPTION quota report for ONE profile since its weekly reset → terminal / --json / --html dashboard (--profile <name>, --config-dir, --since <ISO>, --no-auto-reset, --tz N)
node scripts/quota-multi.mjs      # ALL profiles × ALL weekly windows + COMBINED total → one switchable --html dashboard (--profiles a,b, --tz N, --max-windows N, --json)
node scripts/quota-month.mjs      # ALL team profiles over a FIXED CALENDAR RANGE ("the whole July") + week-by-week rollup → --html dashboard (--month YYYY-MM | --from/--to YYYY-MM-DD, --profiles a,b, --tz N, --json)
node scripts/hook-cost.mjs        # HOOK wall-clock tax — which configured hooks burn throughput/latency (--project, --cwd, --days, --by command|event|session|day|project, --slowest, --min-ms, --json)
node scripts/tool-friction.mjs    # TOOLING-IMPROVEMENT candidates — recurring cross-session command CHAINS to fuse/fix (--project, --grep, --n 2,3, --min-sessions, --json)
node scripts/read-patterns.mjs    # READ STYLE + DISCLOSURE GAP — Read full/partial vs Grep/Glob vs shell readers per model, and whether nested CLAUDE.md / path-scoped rules ever reached sessions that touched a guided subtree only via grep/cat (--project, --worktrees, --days, --min-turns, --session <id>, --json)
node scripts/skill-genesis.mjs    # SKILL-GENESIS patterns — which interaction SHAPE led to a skill being created/improved: same-prompt, interactive-then-ask, lab-driven, compounding (--project, --skill <name>, --days N, --examples N, --json)
```

`fleet-stats.mjs` answers **"how did this batch of sessions behave, and which
group was faster / cheaper / cleaner?"** — the orientation pass for any fleet
question. It reports per-session **distributions** (agent turns, wall-clock
duration, peak context, tool-fail rate — mean/median/p90/max), the **outlier
lists** that break the pattern (biggest single-turn context jump = "sudden
growth", longest context, most turns, worst fail rate, most re-runs, cut-offs),
and — with `--by stack|project|model|day` — a **comparison table** (median
turns/duration/context, fail%, re-runs, cut-offs, median+total cost per group)
so "the Kotlin build-out took more turns and had a 2× fail rate vs the TS one"
falls straight out. **`--by stack` is the robust axis for parallel build-outs**:
cleaned worktrees lose their git remote so `--by project` can't separate them,
but the stack is stamped on every command (`lib/stack.mjs`). Deliberately not a
cost report — it surfaces the SHAPE and the group deltas, not the (tautological)
cache-read total. Claude only (per-turn `usage`). Pairs with
`context-spikes.mjs` (explain a sudden-growth outlier) and the taxonomy in
`references/fleet-inspection.md`.

`hook-cost.mjs` answers **"are my hooks the bottleneck?"** — the one axis every
other fleet tool is blind to. `token-sinks`, `waste` and `context-growth` all
measure TOKENS; a hook adds **zero** tokens and pure **latency**, because it runs
synchronously in the critical path (a `PostToolUse` hook delays the next tool
call; a `Stop` hook delays the end of *every* turn). It reads two channels and
reports total hook wall-clock as a **share of the sessions' own span**, the
**Stop-chain per-turn tax** (median/p90/max — what each turn pays before the
agent is allowed to stop), a per-hook table (n, total, share, median, p90, max,
timeouts, blocks), and the slowest individual invocations with session + time.

Two facts about the data that this tool exists to encapsulate:
- **The channels overlap — never sum them naively.** A `stop_hook_summary`
  entry (`hookInfos[].durationMs`, emitted once per turn-end for the whole Stop
  chain) and a `hook_success`/`hook_blocking_error` **attachment** can describe
  the *same* run, ~28ms apart. Verified on real data; summing both inflated a
  single 11m41s invocation to 23m. `dedupe()` merges on
  session+event+command+durationMs within a 5s window, preferring the summary.
- **Silent hooks are invisible.** A hook that runs, succeeds and prints nothing
  emits no record; `PreToolUse` appears *only* when it blocks, times out, or
  outputs. So every total is a **LOWER BOUND**, and the report says so rather
  than quietly under-reporting. Pair with the repo's own `settings.json` to see
  which configured hooks never show up at all.

`preventedContinuation` is called out separately because a blocked Stop hook is
worse than latency — it forces an **extra model turn**, so it costs tokens too.
Claude only (Codex/Copilot don't record hook timings).

`tool-friction.mjs` answers **"what should we change in the tools
themselves, not in how we prompt?"** — it's the fleet tool for a use case
beyond debugging one session or ranking pain: mining MANY sessions for
recurring ordered chains of *different* commands (e.g. `grep → cd`,
`git status → git add`, `grep → npm run coverage:check`), each a candidate
for a combined verb, a changed default, a preflight guard, or a batch mode.
This is distinct from `repeatedCommands`/`incidents.mjs`'s `reruns` (the same
command re-run in one session — a failure/retry signal); a chain recurring
across MANY sessions is a friction signal from the **tool's own shape**. Full
strategy catalog (8 named patterns, worked examples, and a
detect→validate→prototype→re-measure workflow) in
`references/tooling-improvement.md`.

`waste.mjs` answers **"what cost unnecessary tokens?"** — it attributes each
session's content to buckets (tool_result by tool, Write/Edit args, user
prompts/pastes, …) weighted by **persistence** (tokens × turns-survived, because
cost is cache-read dominated — an early dump is re-billed every later turn), then
flags the avoidable waste: **re-reading a file already in context**, repeated
identical Bash output, and **node_modules leaking into Glob/Read**. Companion to
`token-sinks.mjs` (which gives the billing total); this explains what ran it up.
Claude transcripts only; chars/4 token estimate (≈1.5% of exact tiktoken).

`incidents.mjs` answers **"which sessions are worth learning from?"** — it ranks
the fleet by friction (human course-corrections matching a defect lexicon,
repeated near-identical complaints, failed tools, wasted command re-runs, and
image-**regeneration churn**) so you deep-dive the few sessions that hit a wall
instead of reading them all. Swap the lexicon with `--lens general|visual|image`
(visual = overlap/cropped/chrome/aspect…; image = crop/aspect/regenerate/refusal…),
narrow with `--project`/`--grep`/`--days`, then it prints the exact
`analyze-*-session.mjs … --events --grep` command to explain the top hit. It's
the discovery half of the loop; the single-session analyzers are the explain half.

`resumable.mjs` answers **"I got rate-limited — which session was that, and how
do I continue it?"** — the common case where a usage/rate limit (or an interrupt)
kills a session mid-task and you come back later to pick it up. It scans every
Claude profile home, keeps only sessions whose ending is a genuine cut-off
(`endedOnLimit` — the limit banner as the **final** message, so a session that
merely *mentioned* a limit is excluded), ranks them by severity then recency, and
for each prints the **goal**, the **last human ask**, and a ready-to-run,
profile-aware resume command (`cd <cwd> && CLAUDE_CONFIG_DIR=<home> claude --resume
<id>` — the `CLAUDE_CONFIG_DIR` matters because the session lives under a specific
`.claude[-suffix]` home and resuming under the wrong profile won't find it). Scope
with `--project <substr>` or `--cwd` (only this directory's sessions), widen the
window with `--days N` (default 7). `--latest` prints just the top hit; `--resume`
prints *only* the command (pipe/eval it); `--interrupted` also includes
user-interrupted sessions; `--all-endings` lists normal-ending sessions too. The
discovery half of the resume loop — `analyze-claude-session.mjs <path> --events -v`
is the explain half when you want to see exactly where it stopped first. Claude only.
**Instant deaths are grouped, not listed**: a session that died within seconds with
zero tool calls (a fleet launched into an exhausted profile window — e.g. a kanban
board relaunching 38 ticket agents straight into the limit banner) has NOTHING to
resume, so `--resume`-ing it reopens an empty session. These collapse into one
summary line per launch directory with relaunch-not-resume advice (individually
listable with `--include-instant`; in `--json` they're the `instantDeaths` groups
next to `resumable`).

**Subagents are excluded by default.** A subagent is not independently resumable
(`claude --resume` takes the PARENT's id), and a shared-account limit kills parent
and children together — so one cut-off orchestrator used to contribute its whole
fan-out of look-alike rows. Measured: 9 of the top 10 rows were one parent's 20
research subagents, burying the 3 real cut-offs — and every one of those rows
printed an **unusable** resume command, because the profile home was derived by
counting `dirname` hops and a nested transcript sits two levels deeper, so
`CLAUDE_CONFIG_DIR` pointed at the *project dir*. Both are fixed: the home is now
anchored on the `projects` path segment, and `--include-subagents` shows them
labelled, pointing at the parent + `subagent-results.mjs` rather than at a resume
command that cannot work.

**Already-continued sessions are separated out** (`lib/successor.mjs`). A cut-off
session whose work another session already finished is noise that outranks
everything real, since severity and recency both favour it. Evidence is graded, and
only the strong kinds may HIDE a row: `ledger` (spawn-session's own record of the
handover, `~/.spawn-session/ledger.jsonl`) and `brief` (a handoff brief naming its
source session, whose filename a later transcript quotes). A same-repo **id
mention** is a hint only, annotated in place — treating it as fact suppressed two
genuinely open cut-offs, because a session that merely *analyzed* the fleet mentions
every id. So a would-be successor naming 3+ distinct candidates is reclassified as
analysis and dropped. `--include-continued` ranks them anyway.

`skill-usage.mjs` answers **"which of my agent skills never get triggered?"** —
it discovers every skill on disk (`~/.claude/skills`, `~/.codex/skills`,
`~/.copilot/skills`, and each repo's `.claude/.codex/skills` reached via session
cwds + `--project-dir`; plugins are opt-in via `--include-plugins`) and cross-
references each against every transcript. It separates a **strong** trigger (an
agent explicitly fired it: Claude `Skill` tool, a `/slash`, or a Copilot skill
field) from a **weak** one (the `SKILL.md` body was merely loaded/read — the only
signal Codex emits). This split matters because skill **materialization** inflates
weak counts: the kanban board copies its built-in skills into every worktree's
`.claude/skills`, so their path appears in thousands of sessions even though no
agent ever invokes them (those are server-triggered, not agent-triggered). The
report buckets skills into **dead** (never invoked but **was available**),
**too-new** (created after ~all scanned sessions — no fair chance to fire),
**loaded-only** (strong=0, present but never agent-invoked), and **agent-invoked**,
plus an orphan list of names triggered in logs with no SKILL.md on disk.
Availability is the fair denominator: a skill's `git` first-add date vs each
session's time gives `avail` = sessions that ran *after* it existed, so a skill
written last week isn't wrongly called dead. Board-independent (no DB). The
git-history pass only runs for never-strong-invoked skills; narrow with `--days`
for a fast windowed audit (`--no-git` skips creation-time entirely).
`read-patterns.mjs` answers **"how do agents actually read files, and does progressive
disclosure keep up?"** — Claude Code auto-loads a nested `CLAUDE.md` and a path-scoped
`.claude/rules/*.md` only when a file in that subtree is touched through **Read/Edit/Write**.
Newer models read search-first: the built-in Grep/Glob tools and shell readers (`cat`,
`sed -n`, `grep`, `rg`, `head`, `Get-Content`) touch the same files and trigger **nothing**.
The script measures both halves per model: read style (Read full vs partial `offset`/`limit`,
Grep/Glob counts, shell calls carrying a read verb, a search-first ratio) and the disclosure gap
per (session × guidance dir): which tool touched the dir first, whether Claude Code's own
`nested_memory` attachment ever arrived, and — when the first touch was indirect but a Read
came later — how many tool calls the agent worked in that subtree *before* its guidance landed.
Guidance dirs are discovered from the session cwd on disk plus every `nested_memory` path seen in
the corpus, so it is not tied to any one repo layout. Measured on 237 kanban builder sessions
(Sonnet 5, 90 days): 33% of Reads partial, search-first ratio 0.65, **15 of 148 guided-subtree
touches (10%) never received their CLAUDE.md — every one of them was a Grep/shell-only touch (0
of 15 injected)**; where a Read followed, the median lag was 1 call but p90 9 and max 16. The
closing mechanism is a PostToolUse hook on `Bash|Grep|Glob` that resolves the touched paths to
nested CLAUDE.md + matching rules and injects them as `additionalContext` — reference
implementation and a `claude -p` A/B eval in `C:projectsandrenacontext-disclosure-hook`.
Claude only.
`skill-genesis.mjs` answers **"how do skills actually get born and improved on
this machine?"** — a different question from `skill-usage.mjs` (does a skill
ever fire) and `tool-friction.mjs` (which command chains repeat): of the
sessions that touched a `SKILL.md` (Write = looks like genesis; Edit to it or
to its `scripts/`/`references/`/`tools/`/`src/` = improvement), what shape was
the human interaction that led there? It classifies each into **same-prompt**
(the first human message asks for a thing AND asks for a skill/CLI wrapping it,
in one breath — the highest-leverage shape, often naming a sibling skill as the
template), **interactive-then-ask** (a task got done first — several tool
calls — and only *later* in the session did a human message ask to turn it
into a skill), **lab-driven** (the session invoked a `*-lab` companion
meta-skill whose job is to improve another skill), and **compounding** (the
first message explicitly references a prior session/skill — "continue",
"extend the X skill", "as we did before"). A session can match more than one
shape. Cheap-prefiltered (skips any transcript never mentioning `skills/`)
before the full parse, so a multi-thousand-session fleet scan stays fast.
Narrow with `--project <substr>` (repo scope) or `--skill <name>` (only
sessions touching one named skill); `--examples N` prints more than the
default 3 real snippets per shape. Pairs with `tooling-improvement.md`'s
detect→validate→prototype loop — this is the "detect" step for the *skill
authoring* pattern specifically, one level up from command-chain friction.

**Repo-scoped audit** — to answer "which of **this** repo's skills are dead weight
/ badly described?" rather than the fleet-wide question, add `--project <substr>`
(or `--cwd` for the current repo). It scopes **both** the session set **and** the
project-skill universe to that one repo — so a Rails app's audit no longer drags
in a sibling project's `.claude/skills`, and `avail` becomes "*this repo's*
sessions since the skill existed". Matching is separator-normalized, so
`--project webapp` hits both the hyphenated Claude session folder
(`C--…-webapp`) and the underscored repo path (`…\webapp`) — a mismatch that
otherwise silently discovers zero project skills. Add `--repo-only` to report just
the skills **defined in** the matched repo (dropping user-level globals) — the
exact *skills-in-repo × sessions-in-repo* intersection. The most actionable signal
this surfaces is **loaded-only** skills (weak>0, strong=0 over hundreds of matched
sessions): present and paying context tax, but no agent ever fired them — a sign
the skill is redundant *here* or its description doesn't match how work is framed
(e.g. webapp's generic `playwright-test-{planner,generator,healer}` never fire
because the repo's e2e flow goes through `e2e-coverage-lean`/`e2e-test-author`).
**Token tax** — add `--cost` to weight each dead/loaded-only skill by what it
actually costs, because a dead *small* skill is cheap and a dead *large* one is
real waste. It shells out to the `token-budget` skill's `tokt.js skill --json`
(one subprocess per reported skill; opt-in) and reports the progressive-disclosure
tiers the way an agent pays for them: **t0 = alwaysOn** (name+description, in the
system prompt *every turn of every session* whether or not the skill fires) and
**inv = onInvoke** (the SKILL.md body, loaded only when it triggers). The dead and
loaded-only buckets are then ranked by tax (`waste ≈ t0 × avail` — a per-session
lower bound on the always-on tokens paid while it never earned an invocation), and
a headline sums the always-on tax of all never-invoked skills. `tokt.js` is located
via `$TOKT_BIN`, the sibling `token-budget` skill (junctioned next to this one), or
the known repo/profile paths; if none exist, `--cost` degrades to a one-line notice
and the rest of the audit runs unchanged.

`quota-report.mjs` answers **"what did my subscription do this billing week?"** —
it scopes to ONE profile (`--profile <name>` ⇒ `~/.claude-<name>`, or
`--config-dir <path>`) and, unlike `token-sinks.mjs` (which stat-filters whole
FILES by mtime), filters **per turn** by the turn's own timestamp, so a session
straddling the cutoff contributes only its post-cutoff turns. The default cutoff
is the profile's **last weekly reset**, which it **auto-detects per profile** —
different accounts anchor their weekly window on different weekday+times. It reads
the profile's own `"You've hit your weekly limit · resets …"` banners (the
`resets Jul 17, 12pm` / `resets 6am` forms), derives the reset weekday+clock in
Europe/Berlin, and steps back in 7-day multiples to the most recent boundary
at/before now (e.g. `andrena_team_5x` → Tue 6am, `andrena_team_5x_2` → Fri 12pm).
Override the cutoff with `--since <ISO>`, disable detection with
`--no-auto-reset` (falls back to Fri 12:00 Berlin), and set the UTC offset with
`--tz N` (default 2 = CEST). The detected schedule + the banner it came from are
shown in the dashboard's verification callout and in `meta.resetInfo`. **Subagent transcripts are
included** (`<session>/subagents/agent-*.jsonl`) because they hit the API and burn
the same quota. It reports totals (sessions, subagents, assistant turns, tool
calls + errors, tokens, est. USD "subscription value" at pay-go rates), and
breakdowns by model / project / day / hour-of-day (localized) / tool / top
sessions, plus a **usage-limit banner timeline** (collapsed to distinct messages
with a repeat count) that doubles as evidence for the reset window. `--json` for
the full blob; `--html <file>` writes a **self-contained, theme-aware dashboard**
(inline SVG charts, no external assets) you open locally. Cost model matches
`token-sinks.mjs`. Claude only. Example:
`node scripts/quota-report.mjs --profile andrena_team_5x_2 --html quota.html`.

`quota-multi.mjs` is the **"complete picture"** companion to `quota-report.mjs`:
one self-contained, switchable dashboard covering **every** `andrena_team_5x*`
profile (or `--profiles a,b,…`), **every weekly reset window per profile**, plus
a **Combined grand total** across all profiles. It parses each transcript ONCE
(shared core in `lib/quota.mjs` — pricing, per-turn event parse, banner scan,
`detectWeeklyReset`, `weeklyWindows`, `aggregate`) and slices each window in
memory. Per profile it auto-detects the weekly anchor and generates weekly
windows across that profile's data; profiles with **no weekly-limit banner yet**
(only 5-hour session limits) are honestly flagged "anchor unknown" and shown as a
single span. The **Combined** scope sums everything and breaks down **by profile**
(windows are per-profile because each account resets on a different weekday, so
Combined is a total, not a synchronized window). The HTML has a profile tab row
(each with its total value) + per-profile window chips (`Profile total` + one per
week); each view renders KPIs, token composition, value-by-day, hour-of-day, by
model/project(/profile), tool table, top sessions, and a usage-limit timeline.
`lib/quota.mjs` is the single source of truth for the accounting; reuse it for any
new cross-profile quota view. Example:
`node scripts/quota-multi.mjs --html quota-all.html`.

`quota-month.mjs` is the **calendar-range** view — "what did the team burn in the
whole of July?" Neither of the other two can answer that: `quota-report.mjs` takes
a single `--since` for ONE profile, and `quota-multi.mjs` slices by each account's
own weekly reset, so a month is smeared across windows that start on different
weekdays. This one takes an explicit wall-clock range (`--month 2026-07`, or
`--from`/`--to`; Berlin wall-clock, `--to` exclusive) and reports **all
`andrena_team_5x*` profiles combined + per profile** inside it. Same `lib/quota.mjs`
accounting, so the numbers reconcile with the other two views.

Range-specific behaviour worth knowing: days with no activity are **zero-filled**
so a quiet day reads as a gap rather than as missing data; the daily chart scales
to ~31 bars (weekends tinted, labels thinned, tooltips keep the detail); a
**week-by-week table** (Mon–Sun, clipped to the range) sits above the panels; KPIs
add **per-ACTIVE-day** next to per-calendar-day, which is the honest rate when the
month is half idle. Per-profile chips still follow that account's *own* billing
weeks, clipped to the range and marked `*` when the range cut them short. The
personal `~/.claude` profile is **never** read — team seats only.
`node scripts/quota-month.mjs --month 2026-07 --html quota-july-2026.html`.

`prompt-style.mjs` answers "how do I talk to the agent?" — it aggregates every
real human prompt into a length distribution, tone/format signals (lowercase
start %, question %, terse one-liners %, approval-only %, German/umlaut %, …),
opening-word frequencies, and representative samples. Scope it with
`--project <substr>` (matches the Claude projects-dir folder, the session cwd,
or the git remote), `--provider`, and `--days N`; run bare for an all-time,
all-projects profile (with a busiest-projects breakdown). It shares the
human-vs-noise `classify()` filter with `user-prompts.mjs` (both live in
`scripts/lib/prompts.mjs`), so the two tools always agree on what a prompt is.

`context-growth.mjs` answers **"why did this cost so much?"** — agent cost is
cache-read dominated (every turn re-bills the ENTIRE current context), so a
session's spend is roughly the **area under its context-growth curve**. It reads
per-turn `message.usage` (exact billed tokens, not estimated) and reports:
**auto-compacts** — how many `isCompactSummary` boundaries fired (the safety
valve; few compacts + huge maxCtx means it never tripped, often because the 1M
context window pushed the compact threshold up near the window size); a
**context histogram + percentiles**; the **long-context tax** — the
price-independent share of turns and of cache-read tokens sitting above 200k
(the premium pricing tier); and the **point of no return** — the turn context
first crossed 200k and never came back (everything after is premium-tier).
`--session <id>` focuses one session and prints its sampled growth curve.
Companion to `token-sinks.mjs` (billing total) and `waste.mjs` (what fills the
context) — this explains the SHAPE that multiplies both. Claude only.

`cold-cache.mjs` answers **"what did idle time / resuming cost me?"** — the prompt
cache is ephemeral (Claude Code uses a **1-hour** TTL here; the transcript proves
it via `usage.cache_creation.ephemeral_1h_input_tokens`). While warm, every turn
re-bills the whole context as cache_read at **0.1×** base input; but if a session
sits idle past the TTL and is then continued (or a long session is `--resume`d
after a break), the next turn finds the cache expired and must **re-write the
entire prefix** as cache_creation — billed at **2× base input** for a 1h write.
That one cold turn can cost ~20× a warm turn: a 400k-token Opus context refilled
cold ≈ `400k × $5/M × 2 = $4.00` vs ≈ $0.20 warm. The tool walks per-turn
timestamps, and when the **gap** since the previous turn exceeds the TTL *and* the
turn shows a large `cache_creation`, records a COLD event and quantifies the
**avoidable premium** — the cold re-write cost minus what a warm cache_read would
have cost (`creation_1h × in × (2.0−0.1) + creation_5m × in × (1.25−0.1)`). The
first turn of a session (initial build) is never counted — nothing to keep warm.
It ranks the worst sessions and the worst single refills; `--session <id>` lists
every cold event in one session; `--gap` tunes the idle threshold (default 60m).
This is the avoidable slice that `context-growth.mjs`'s SHAPE makes expensive.
Claude only. Note: its write multipliers (2× for 1h) are more precise than the
flat 1.25× in `token-sinks.mjs`/`quota.mjs`, which assume 5m writes.

`context-spikes.mjs` answers **"which single injection bloated the context, and
WHY — so I can fix the source?"** — most context bloat is one tool_result: a huge
whole-file Read, a verbose command dump, a JSON blob, node_modules noise, a log
wall, a minified one-liner. It finds each large injection (≥`--min` tokens,
default 5k), weights it by **persistence** (tokens × turns-survived — an early
dump is re-billed every later turn), and **classifies the reason** it was
expensive with a concrete fix: `huge-file` (→ read a range / grep first),
`verbose-output` (→ quiet flag / head), `log-wall` (→ raise log level), `json-blob`
(→ jq-select), `long-lines` (→ don't inline a minified blob), `node-modules`
(→ exclude the dir), `repeated` (→ reuse the copy already in context),
`user-paste` (→ attach a file). `--by class` shows the biggest lever; `--by file`
names the exact files/commands to target (e.g. a big shared doc read whole in 100
sessions). Companion to `waste.mjs` (buckets ALL content by kind) — this one is
spike-first: it names the few concrete sources whose representation you can change.
Claude only; chars/4 estimate.

**Cost-optimization loop** — these five compose into one workflow: `token-sinks.mjs`
(what did it cost, where) → `context-growth.mjs` (what SHAPE ran it up) → then the
two levers: `cold-cache.mjs` (idle/resume waste — a *timing* fix: keep sessions
warm, `/compact` or finish before a break) and `context-spikes.mjs` + `waste.mjs`
(injection waste — a *representation* fix: ranged reads, quiet flags, log levels,
jq-select at the source). Scope any of them to one repo with `--project <substr>`
or `--cwd` and a `--days` window.

`slash-goals.mjs` answers **"what was the agent asked to do, and how?"** — per
session it surfaces the **goal** (custom title → ai-title → slug → first typed
prompt, sorted by turns so marathon sessions lead), the **slash commands** the
human invoked (flagging session-hygiene ones — `/clear`, `/compact`, `/model` —
whose *absence* explains runaway context), and the **skill invocations** the
agent fired. Goals give intent, slash gives hygiene, skills give mechanism
(a brainstorming → writing-plans → subagent-driven-development workflow
front-loads big design docs and spawns result-dumping Agents — often the *cause*
of the growth `context-growth.mjs` measures). Claude only.

Full usage + caveats for the other three in `references/aggregate-tools.md`. (That file also mentions a server-side `fleet-analysis` roll-up — that path needs an agentic-kanban board and is **optional**; the bundled scripts above need nothing but Node.)
