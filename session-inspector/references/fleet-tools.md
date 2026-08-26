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

## Where each tool is explained

| Question | Tools | Reference |
|---|---|---|
| What did it cost, what filled the context, how to shrink it | `token-sinks`, `waste`, `context-growth`, `cold-cache`, `context-spikes` | [fleet-cost.md](fleet-cost.md) |
| How did a batch behave; which sessions hurt; what tooling to build; are hooks slow | `fleet-stats`, `incidents`, `tool-failures`, `tool-friction`, `hook-cost` | [fleet-friction.md](fleet-friction.md), [fleet-inspection.md](fleet-inspection.md), [tooling-improvement.md](tooling-improvement.md) |
| Which skills never fire; how skills get born; how agents read; what humans typed | `skill-usage`, `skill-genesis`, `read-patterns`, `slash-goals`, `prompt-style`, `user-prompts` | [fleet-skills-and-prompts.md](fleet-skills-and-prompts.md) |
| Subscription quota per profile / all profiles / a month | `quota-report`, `quota-multi`, `quota-month` | [fleet-quota.md](fleet-quota.md) |
| Cut-off sessions to continue | `resumable`, `session-resume` | [resume-and-handoff.md](resume-and-handoff.md) |
| Which repo to pick up next | `continuations` | [continuations.md](continuations.md) |
| Original usage notes for `token-sinks` / `tool-failures` / `user-prompts` | | [aggregate-tools.md](aggregate-tools.md) (also mentions an optional agentic-kanban `fleet-analysis` server roll-up — not needed; the scripts need only Node) |
