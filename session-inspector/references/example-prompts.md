# Example prompts — common analysis questions, ready to ask

Worked prompts for the questions teams actually bring (distilled from a team-workshop
question board). Each block: the **prompt as you'd type it** in Claude
Code (German or English both trigger) → what the agent should run → what to read off.
`SI=session-inspector/scripts`, `TOKT="node token-budget/bin/tokt.js"` (sibling skill
in this repo). Every script takes `--days N`, `--project <substring>`, `--json`.

The pattern behind all of them: **measure on your own transcripts → change one thing
at the source → re-measure next week.** Findings and the re-measure command go into
the repo's CONTINUE.md, not into chat.

## 1 · Token efficiency / "re-reading wastes tokens"

> "Where did our tokens actually go last week?"

```bash
node $SI/token-sinks.mjs --days 7        # billing total by project/day/session
node $SI/waste.mjs --days 7              # by bucket, persistence-weighted
```
Read off: the dominating bucket (usually `tool_result:Bash`/`Read`). Weighted, not raw,
is the number to shrink — an early 10k dump is re-billed every later turn.

> "How often does the agent re-read files? Is that avoidable?"
> "Is Claude Code re-reading files after every edit?"

```bash
node $SI/reread-causes.mjs --days 7      # splits re-reads: post-edit / post-compaction / pagination / pure-dup
node $SI/read-patterns.mjs --days 14     # Read full vs offset/limit vs Grep vs shell cat/sed
```
Read off: only the `pure-dup` class is avoidable (measured fleet-wide: ~1% of re-read
tokens; the edit→re-read rate is ~6%, so no, not after every edit). `waste.mjs`'s
dup-read figure is an upper bound. Change: a file re-read every session belongs in a
nested CLAUDE.md / `@import`, not in a Read.

> "Which single injections blew the context up, and why?"
> "Why did this session cost so much?"

```bash
node $SI/context-spikes.mjs --days 14 --by class    # skill-inject, compaction, huge-file, log-wall …
node $SI/context-growth.mjs --session <id>          # growth curve, auto-compacts, >200k premium share
```
Read off: sessions with maxCtx ≫ 200k and ≤1 compaction — the 200k-premium share of
cache-read is where the money went. Change per class: verbose test output → summary
reporter; 500k marathons → shorter sessions + handoff (`spawn.cmd -handoff`).

> "What does our context cost before the first prompt?"

```bash
$TOKT count --file CLAUDE.md
$TOKT scan .claude --glob "**/*.md" --top 20
$TOKT audit CLAUDE.md                    # redundancy, filler, dead sections
```

> "Do hooks or a cold cache cost us invisibly?"

```bash
node $SI/hook-cost.mjs --days 14
node $SI/cold-cache.mjs --days 14        # resumes after the 1h cache TTL = full context rewrite
```

## 2 · Rules adherence / outdated memory

> "Which of our rules get violated — and is that visible as rework?"

```bash
node $SI/incidents.mjs --days 30                     # friction-ranked sessions
node $SI/user-prompts.mjs --days 7                   # human corrections: "no, …", "don't …"
node $SI/analyze-claude-session.mjs <id> --friction  # one session's painful moments
```
Repeated corrections on one topic = a rule that is missing, buried, or too long.
Change: short rule near the top of CLAUDE.md — or a hook (a hook *enforces*, a rule *asks*).

> "Is our CLAUDE.md too long to be obeyed?"

```bash
$TOKT audit CLAUDE.md
```
Compare violated rules (above) with their position/length in the file. Outdated memory:
review it in the same PR that changes what it describes; delete rather than accumulate.

> "How do we actually prompt? Is our style part of the problem?"

```bash
node $SI/prompt-style.mjs --days 30 --project <repo>
node $SI/slash-goals.mjs --days 30
```

## 3 · Monorepo: one CLAUDE.md or one per package?

> "Do agents even touch files in a way that triggers nested CLAUDE.md?"

```bash
node $SI/read-patterns.mjs --days 30 --project <monorepo>
```
Nested rules load only on Read/Edit in that subtree. If agents mostly Grep or `cat`
(the script shows the split), the layout is inert. Change: trigger-relevant rules to
the root file, or an explicit pointer.

> "What does the root file cost per turn vs. package files?"

```bash
$TOKT count --file CLAUDE.md
$TOKT scan packages --glob "**/CLAUDE.md"
```
Target: root = navigation + invariants (small); package files = local conventions,
loaded on touch. Measure the split's effect with `waste.mjs` a week later.

## 4 · Guidelines: copy into rules (double maintenance) vs. reference (tokens)?

> "What would our coding guidelines cost as a rule vs. as a skill?"

```bash
$TOKT count --file docs/coding-guidelines.md
$TOKT audit docs/coding-guidelines.md
$TOKT skill .claude/skills/coding-guidelines    # Tier 0 = paid EVERY turn; body only on invoke
```
Keep Tier 0 under ~100 tokens — that is the "middle way". Verify adherence with an A/B:
plant a violation, run `claude -p` twice (rule vs skill), judge via `$TOKT result` /
`$TOKT cost`.

## 5 · Shared skills across repos / marketplace

> "Which of our skills ever fire? Which are dead weight?"

```bash
node $SI/skill-usage.mjs --days 60 --cost    # trigger rate × always-on Tier-0 tax
```
Change: delete or merge dead skills — each description is paid every turn of every session.

> "How did the useful skills come into being?" / "What tooling should we build next?"

```bash
node $SI/skill-genesis.mjs --days 14
node $SI/tool-friction.mjs --days 30         # repeated command chains = skills nobody wrote yet
```

## 6 · Subagents — when, how many, did they deliver?

> "What did our subagent fan-outs cost, and did they deliver?"

```bash
$TOKT session <session-id>                   # per-subagent cost (agentType + description)
node $SI/subagent-results.mjs <session-id>   # what each returned; recover cut-off ones
node $SI/fleet-stats.mjs --days 30           # with-subagents vs without
```
Rule of thumb to test on your own data: fan out when work is independent and
read-heavy — the subagent's 200k of reads dies with it. Not for sequential edits.

> "How many subagents can I start right now?"

```bash
fleet capacity --field recommended           # claude-pick/fleet; live.mjs shows who runs now
```

## 7 · TDD with the agent

> "Does test output flood the context? What does test generation cost?"

```bash
node $SI/context-spikes.mjs --days 30 --project <repo>   # test-runner walls as a class
node $SI/waste.mjs --days 30 --project <repo>            # Write/Edit bucket
```
Change: failures-only test script; rule "run the single file, not the suite".

> "Do the AI-written tests actually check anything?"

Fresh session, cheap mutation proxy:
```bash
claude -p "Mutate the implementation in <file> in 3 plausible ways; report which existing tests fail for each. If none fail, name the test tautological." --output-format json > mut.json
$TOKT result mut.json; $TOKT cost mut.json
```

> "Which tests should the gold-standard skill point at?" — `read-patterns.mjs`: the test
files agents keep reading as examples are the de-facto reference; make them explicit.

## 8 · PR automation / where does the time go?

> "What does an AI review run cost, and does it catch what we need?"

Plant one bug, run two models/prompts, compare hit-rate × cost via
`claude -p … --output-format json` + `$TOKT result` / `$TOKT cost`.

> "Where in ticket → PR does the team's time go?"

```bash
node $SI/incidents.mjs --days 30 --project <repo>
node $SI/tool-failures.mjs --days 30         # build? lint? test? git?
node $SI/tool-friction.mjs --days 30
```
Failing calls around build/test/lint are pure friction — fix the tooling once
(`make check`, lint autofix hook) instead of every session rediscovering it.

## 9 · Where is AI used / not used / losing time?

```bash
node $SI/quota-report.mjs                    # this week: when, how much, which projects
node $SI/slash-goals.mjs --days 30           # what it was asked to do
node $SI/incidents.mjs --days 30             # highest-friction sessions → deep-dive 2–3
```
Repos you commit to that show no sessions = the "not used, but could be" list.
