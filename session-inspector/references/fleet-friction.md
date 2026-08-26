# Fleet: shape, friction and tooling signals

_session-inspector reference — fleet-stats, incidents, tool-failures, tool-friction, hook-cost. Commands run from the skill directory (`node scripts/…`); all take `--json`, `--days N`, `--project <substring>`._

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

`incidents.mjs` answers **"which sessions are worth learning from?"** — it ranks
the fleet by friction (human course-corrections matching a defect lexicon,
repeated near-identical complaints, failed tools, wasted command re-runs, and
image-**regeneration churn**) so you deep-dive the few sessions that hit a wall
instead of reading them all. Swap the lexicon with `--lens general|visual|image`
(visual = overlap/cropped/chrome/aspect…; image = crop/aspect/regenerate/refusal…),
narrow with `--project`/`--grep`/`--days`, then it prints the exact
`analyze-*-session.mjs … --events --grep` command to explain the top hit. It's
the discovery half of the loop; the single-session analyzers are the explain half.

`tool-failures.mjs` ranks FAILED tool calls across the fleet (`--by tool|project|error|day`, `--sort rate`); it is the discovery step before `incidents.mjs` when the question is "what are the agents fighting" rather than "which session hurt". Full usage in `aggregate-tools.md`.

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
