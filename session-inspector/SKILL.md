---
name: session-inspector
description: Inspect, aggregate and edit coding-agent session transcripts — Claude (~/.claude*/projects), Codex (~/.codex/sessions), Copilot (~/.copilot). One session (why it stopped, what it did, friction moments, machine state to hand off, stranded subagent results), a whole fleet (token sinks, context waste/spikes, tool failures, dead skills, hook latency, quota), and the present (which sessions run now, how many subagents are feasible, which repo to pick up next → human-gated spawn plan). ALWAYS use this instead of hand-reading/grepping/patching .jsonl transcripts — for any "session X", "what burned tokens", "which skills never fire", "are hooks slow", "what should we continue", or "edit what was said in a session" question.
argument-hint: [session-id | keyword | --codex <path> | --copilot | edit]
---

# Session Inspector

Bundled Node scripts (builtins only, Node 18+) over agent transcripts. Run from this
skill's directory: `node scripts/<tool>.mjs …` — from elsewhere, prefix the skill path.
Every tool takes `--json`; fleet tools take `--days N` and `--project <substring>`.
**Do not hand-parse `.jsonl` files** — a tool below already answers the question.

## Pick the tool by the question

| Question | Tool | Depth |
|---|---|---|
| **One session** — what happened, was it cut off, first/last ask, signals | `analyze-claude-session.mjs <id\|path\|--latest>`, `analyze-codex-session.mjs`, `analyze-copilot-session.mjs` | [single-session](references/single-session.md) |
| …the timeline / just the failures | `… --events [--type err] [--grep x] [--around <seq>]` | same |
| …the most painful moments, ranked | `… --friction` | same |
| …what it left RUNNING on the machine (bg jobs, monitors, scratchpad) | `… --handoff` — **run first when continuing a cut-off session** | same |
| …its subagents' results (act on / re-inject, don't re-run) | `subagent-results.mjs <locator> [--unresolved] [--brief -o f.md]` | same |
| **Edit** what a session says (redact, fix a prompt) | `session-edit.mjs extract … → edit → apply --quiet` | [session-edit](references/session-edit.md) — **read the confidentiality rules first** |
| **Cut off by a limit — continue it** | `resumable.mjs` → recommends **handoff**, not resume | [resume-and-handoff](references/resume-and-handoff.md) |
| Batch died (reboot/crash) | `session-resume.mjs --profile <p> --reboot` | same |
| **Who is running right now** | `live.mjs [--watch]` | [live-and-capacity](references/live-and-capacity.md) |
| **How many subagents can I spawn** | `fleet capacity --field recommended` / `fleet gate --count N` (`claude-pick/fleet/fleet.cmd`) | same |
| **What to pick up next** (repos × CONTINUE.md × live × quota) → spawn plan | `continuations.mjs [--plan plan.json]` → human approves → `spawn-session -batch` | [continuations](references/continuations.md) |
| **Fleet shape** — turns/context/fail distributions, outliers, `--by stack\|project\|model` | `fleet-stats.mjs` | [fleet-friction](references/fleet-friction.md), [fleet-inspection](references/fleet-inspection.md) |
| What cost the most (billing total) | `token-sinks.mjs [--by project\|day\|model\|session]` | [fleet-cost](references/fleet-cost.md) |
| Where context tokens go + what is avoidable (re-reads, dup output, node_modules) | `waste.mjs` | fleet-cost |
| Are file re-reads avoidable or justified (post-edit, post-compaction, pagination)? | `reread-causes.mjs` | fleet-cost |
| The single injections that bloated context + WHY + fix (skill-inject, compaction, huge-file, …) | `context-spikes.mjs [--by class\|tool\|file]` | fleet-cost |
| Context growth curve, auto-compacts, >200k tax | `context-growth.mjs [--session id]` | fleet-cost |
| Cost of idle/resume (cache expired) | `cold-cache.mjs` | fleet-cost |
| Which tools fail most | `tool-failures.mjs [--by tool\|project\|error]` | fleet-friction |
| Which sessions are worth learning from (friction rank) | `incidents.mjs [--lens general\|visual\|image]` | fleet-friction |
| Recurring command chains → tooling to build | `tool-friction.mjs` | fleet-friction, [tooling-improvement](references/tooling-improvement.md) |
| Which skills never fire (+ their always-on token tax) | `skill-usage.mjs [--project x] [--repo-only] [--cost]` | [fleet-skills-and-prompts](references/fleet-skills-and-prompts.md) |
| How skills got created/improved | `skill-genesis.mjs` | fleet-skills-and-prompts |
| How agents read files; does nested CLAUDE.md ever load | `read-patterns.mjs` | fleet-skills-and-prompts |
| What humans typed / how they prompt / slash & skill usage | `user-prompts.mjs`, `prompt-style.mjs`, `slash-goals.mjs` | fleet-skills-and-prompts |
| Are hooks the bottleneck (latency, zero tokens) | `hook-cost.mjs [--by command\|event]` | fleet-friction |
| Subscription quota this week / all profiles / a calendar month | `quota-report.mjs --profile p [--html f]`, `quota-multi.mjs`, `quota-month.mjs --month YYYY-MM` | [fleet-quota](references/fleet-quota.md) |
| Sessions from other machines / pooled corpora | `sync-server.mjs`, `sync-push.mjs`, `sync-query.mjs`, `session-bundle.mjs`, `hub-service.mjs` | [sync-and-bundles](references/sync-and-bundles.md), [session-sync](references/session-sync.md), [hub-service](references/hub-service.md) |
| Custom parsing the analyzers don't cover | manual recipes | [claude](references/claude-recipes.md) · [codex](references/codex-recipes.md) · [copilot](references/copilot-recipes.md) |
| **Team questions about context & sessions** ("where did tokens go", "are re-reads avoidable", "are rules followed", "monorepo CLAUDE.md split", "dead skills", "subagent ROI", recurring friction) — prompt → tool → read-off → change | worked examples | [example-prompts](references/example-prompts.md) |

**Cost-optimization loop:** `token-sinks` (what) → `context-growth` (shape) → `cold-cache`
(timing fix) + `context-spikes`/`waste` (representation fix). Don't headline cache-read as
a finding — it is cache-dominated by construction; report what varies. Full fleet command
list with every flag: [fleet-tools](references/fleet-tools.md).

## Rules that are easy to get wrong

- **Session ids resolve across all `~/.claude*` profiles by default**; `--profile` is a
  preference, not a filter. Just pass the id — don't `find` the file. Layout, profiles,
  `stop_reason` meanings: [profiles-and-layout](references/profiles-and-layout.md).
- **Resume is usually wrong.** `--resume` is pinned to the (exhausted) profile and pays a
  cold-cache rewrite (~20× a warm turn). Hand off via the sibling launcher
  `../spawn-session/spawn.cmd <cwd> -p auto -handoff -from <id>`; the tools already say so.
- **Continuing a cut-off orchestrator:** `resumable` → `--handoff` → `subagent-results` —
  most subagent results survive on disk; re-run only `self-cutoff`/`delivered-partial`.
- **Nothing spawns without a human.** `continuations.mjs --plan` writes every candidate
  `approved:false`; an agent cannot answer `--review` — show the summaries, ask, then
  `--approve --pick`.
- **Editing a session:** apply with `--quiet`, never re-read the transcript or the
  `edits.md` afterwards, never restate what changed.
- **Before fanning out subagents**, ask `fleet capacity` — not `headroomProcesses`
  (that counts whole sessions; subagents are in-process).
- Statusline showing the current session id: [statusline](references/statusline.md).
