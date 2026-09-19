# Lab: tune a session-inspector tool against a use case

_session-inspector reference, the skill's **integrated lab**. Read it when asked to "tune",
"lab", or "improve" a tool here because its output misses what someone needs, or before
changing what a tool reports on the strength of one bad example._

**What it is.** A repeatable eval loop that ships with the skill. It needs no second skill:
pick a **target** (a use case with a consumer), build frozen answer keys from real sessions,
let blind agents consume the tool's output, let a separate judge grade them, change the tool,
and repeat for a fixed number of rounds. A session that was never tuned on is graded at the end
against the tool as it was before the lab.

It is general over targets. Only the target card (below) changes from one use case to the next.
The round machinery, the roles and the guards stay the same.

## 0. Three forms, one per half of the skill

The skill is a question → tool table (the part an agent picks from) over deterministic scripts
(the part that computes every number). Each half is tuned differently, and a finding goes to the
form that can settle it.

| Form | Settles | Section |
|---|---|---|
| **Eval rounds** | does a consumer get what it needs from a tool's output | §1–§5 below |
| **Fixture bench** | is a computed number right, and is its `reach:` line honest | §5a |
| **Trigger drill** | does the description fire on its positives and stay silent on its negatives | §5b |

A wrong number seen in an eval round (a judge's X that traces to arithmetic, not to wording)
leaves the round and becomes a fixture. A consumer who never reached the skill is a drill case.

## 1. Fill the target card first

Write it into the lab directory before any agent runs. It is frozen for the whole lab.

| Field | Question it answers | Handoff example (2026-09-19) |
|---|---|---|
| `use_case` | what the output is FOR | a successor continues a cut-off session |
| `consumer` | who acts on the output, and what they may use besides it | a fresh agent: the brief plus ≤8 read-only commands |
| `tools` | the scripts under tune, with flags | `brief.mjs`, `brief.mjs --gaps` |
| `questionnaire` | 6–10 questions the consumer must answer before acting | goal, location/pushed, done+check, decisions, open+next, traps, sources, machine state, since, missing |
| `key_source` | where ground truth comes from, INDEPENDENT of the tool | an agent reads the full transcript and the repo's git |
| `metrics` | the numbers the judge computes | brief_score, total_score, wrong answers; gap recall/precision |
| `sessions` | 1–2 tuning sessions + 1 held-out, and why each is representative | a 3-hour build session, a 15-hour `/loop` operator session |
| `rounds`, `consumers_per_target` | default 5 and 2 | |
| `baseline_sha` | the commit the held-out baseline is rendered from | HEAD before the lab |

**Pick sessions that stress the use case.** A short, tidy session scores well from the first
round and teaches nothing. Pick long ones, ones cut off by a limit, and ones where the tracking
files are known to be incomplete. Pick the held-out session from the same family but a
different day or repo, and build its key before round 1.

## 2. Target catalogue

The handoff target has been run twice. The others wait for a first run: their rows say what
the key and the metric would be, and are defaults, not measured.

| Target | Tools | Consumer's questions | Key built from | Metric |
|---|---|---|---|---|
| **Handoff** (run 2×) | `brief.mjs`, `--gaps` | the 10-question successor questionnaire | full transcript + git, one key agent per session | weighted share of key facts carried by the output alone; wrong answers; gap recall/precision |
| **Cost / token sinks** | `token-sinks`, `waste`, `context-growth`, `cold-cache`, `reread-causes` | what cost most, why, which ONE change saves most, how sure | a key agent recomputes cost from the raw usage rows with its own script, and names the causes with evidence | numbers within a tolerance; cause recall; recommendations that would not save anything counted as wrong |
| **Skill triggers** ([card](lab-cards/skill-triggers.md), not run) | `skill-usage`, `skill-genesis`, `slash-goals`, `user-prompts` | which skills should have fired and did not, which fired wrongly, which are dead | a key agent labels each human prompt of N sessions with the skill that should have fired, from the skill descriptions | missed-trigger recall/precision; dead-skill verdicts that are wrong |
| **Session review** | `analyze-claude-session`, `tool-friction`, `tool-failures`, `incidents` | how the session went, where it stalled, what to change in the setup | an independent reviewer grades the transcript with quoted evidence | finding recall/precision against the review; wrong claims |

A target with a card in `lab-cards/` is ready to run; a row without one is a default.
A new target is a new row plus a card. When a consumer is a person, not an agent, a Sonnet agent
plays the person. Give it the person's role and the decision to make, and nothing else.

## 3. Roles, and what each may read

The separation is the instrument. The author must not grade its own tool, and the consumer
must not see the key.

| Role | Who | Reads | Never reads |
|---|---|---|---|
| **Author** | this session | the tool code, the judge's findings, the tuning sessions' outputs | the held-out key, the held-out output before the final round |
| **Key builder** | one fresh agent per session, before round 1 | the full transcript, the repo, git | the tool's output (a key shaped by the tool measures nothing) |
| **Consumer** | fresh Sonnet agents, 2 per tuning session per round | the tool's output, the questionnaire, the consumer's allowed extras | transcripts, the lab's keys, the tools under tune |
| **Judge** | one fresh stronger agent per round | keys, outputs, answers; the transcript only for the findings half | nothing is off limits, but it writes no code |

Consumers and the judge get **identical prompts every round**. Record the lab revision a
round ran under if a prompt had to change, and never re-judge an older round with it.

## 4. One round

```
freeze   render the output of every session with the current tool; tests green
consume  2 consumers per tuning session, answers tagged [output] / [extra] / [guess]
judge    grades per key fact (B/D/P/M/X), metrics, noise, misleads, general findings
act      the author takes the findings, makes GENERAL changes, each pinned by a test
```

The judge's grades:

- **B** is right and carried by the output.
- **D** is right, but only from the consumer's own extras.
- **P** is partly right.
- **M** is missing.
- **X** is wrong, or matches one of the key's `wrong_answers`.

Weights come from the key, 1–3 per fact. `brief_score` is the weight of B over all weight. `total_score`
is the weight of B + D over all weight, with P counted half. The round's number is the mean over its consumers.

**Findings are what drive the next round.** For each of the most valuable facts graded M, P or X
by every consumer, the judge answers two things. Was it **mechanically recoverable** from the
session? If so, it names the signal: a tool call, a tool result, a human message, a git command.
And what is the **smallest general change** that would carry it for any session of that
family? A proposal written for one repo is rejected. When the top findings are all "needed
judgement", the tool has reached what code can recover, and the lab should stop.

**The last round adds the held-out.** Render it with the current tool and with `baseline_sha`
(`git worktree add <tmp> <baseline_sha>`, run the tool from there, then remove the worktree).
One consumer each, the same judge, and a verdict per change made during the lab: helped, hurt
or did nothing on the held-out, with the fact ids that show it. It also names the single weakest
area left.

## 5. Prompt templates

Keep them in the lab directory, filled per target. The placeholders are `LAB`, `ROUND`, `N`,
`OUTPUT_PATH` and `OUT_PATH`.

**Key builder**, once per session, before round 1:

```
Build the answer key for <use_case>. Read the full transcript <path> and the repo <dir> (read-only
git). For each question in LAB/questionnaire.md list the facts a <consumer> needs, each as
{id, question, fact, weight 1-3, evidence (a tool call, result, message or git sha),
recorded_in_tracking_files true|false}. Add `wrong_answers`: plausible but false claims a
consumer might make. Never copy a credential value; name the file it came from instead.
Write LAB/keys/<session>.key.json. You will not see any tool output, and none should shape the key.
```

**Consumer**, identical every round:

```
You are <consumer>. You have NOT seen the session. Inputs: OUTPUT_PATH, LAB/questionnaire.md,
and at most <k> read-only commands of this kind: <allowed extras>. Forbidden, and a round that
breaks it is void: transcripts, any other file in LAB, the tools under tune, any write but
OUT_PATH, starting or calling any service. Answer each question, tagging every claim [output],
[extra] or [guess]; say "unknown" rather than guess. End with `commands used: N`. Reply with the
path and one sentence on what the output was worst at.
```

**Judge**, identical every round:

```
Grade how well <tools> output lets a <consumer> do <use_case>. Inputs: LAB/keys/*.key.json,
ROUND/<session>.output.md, the consumers' answers, LAB/questionnaire.md. Grade every key fact
per consumer B/D/P/M/X and compute the metrics and their mean. List noise (output that is
wrong or useless) and misleads (output that pushed a consumer to a wrong answer). Findings: the
5 most valuable facts graded M/P/X by all consumers, each with recoverable mechanical|judgement,
the signal, and the smallest GENERAL change to the tool. You may read the transcript for the
findings only. Never copy a credential value. Write ROUND/judge.json and ROUND/judge.md.
```

## 5a. Fixture bench: the numbers

`scripts/test/fixtures/` holds hand-written `.jsonl` transcripts, each modelling one way a count
goes wrong: usage repeated per content block, a malformed line, a gateway cache plateau, a TTL gap,
a subagent sidechain, a session in the main profile, a Codex rollout. Each has its expected
numbers written by hand **before** the tool is run on it, and one test per fleet tool asserts the
totals and the `reach` block.

One round: a wrong number (from a judge, a delivery run, or a user) → the smallest synthetic
fixture that reproduces it, with the expected value written first → the test fails → fix → the
whole bench stays green. A fixture is never cut from a real transcript; it uses placeholder ids and
a fake secret such as `npm_SECRET123`. Report the bench's reach: which tools have at least one
fixture, which have none.

Default, not yet run (BACKLOG 2). The case for it: the per-row usage over-count (1.8–3x) lived
for months, and one fixture would have caught it.

## 5b. Trigger drill: the description

Run after any change to the frontmatter `description`. Four cheap blind agents, two per arm (old and
new description), 15 vague prompts, 9 that must fire this skill and 6 that must not, with the
neighbouring skills (`token-budget`, `spawn-session`, `skill-design`, `code-metrics`) on the
menu. Keep a cut only if positives do not fall and false fires stay at zero. The prompt set lives
in the lab directory; the numbers go into §8.

## 6. Guards

- **The lab directory lives in the session scratchpad, never in the repo.** Keys and answers
  quote real transcripts. The repo gets the numbers, the code and synthetic tests only. Each test
  models the defect with made-up content (placeholder ids, a fake `npm_SECRET123`) rather than
  copying a line from a transcript.
- **Tell every agent never to copy a credential value.** Transcripts carry them (a token from an
  `.npmrc` sat in plain text in one tuning session). Name the file instead. The tool redacts too,
  so pin that redaction with a test.
- **The bar is frozen for the round it judges.** The key, the questionnaire and the prompts do
  not change during the lab. A fact the key missed goes into the lab's notes, not into the key.
- **Two consumers per tuning session.** With one, a ±0.1 swing is consumer variance, and it hid
  real movement twice in the first run. The held-out has one consumer, so read its number with
  that in mind.
- **A new claim is a new way to be wrong.** Every change that makes the output assert something
  (merged, pushed, still open) gets a test for the case where the assertion must NOT be made. In
  the operator lab, a ticket-fate line called a merge into a train branch "merged". The judge
  caught it, and it was the round's only new wrong answer.
- **Watch the budget.** A size cap makes a new section push an old one out. A round that
  regresses usually lost a section to the trim, not to a worse extraction, so diff the dropped
  sections before blaming the change.
- **A change made after the last round is unscored.** Say so wherever the result is recorded,
  and put a scoring round in BACKLOG.
- **Parallel agents stay within the box's cap** (4 here), which is 4 consumers or the judge.
  Rounds run in sequence.

## 7. Recording a lab

Record it in the same commit as the code:

- A dated `CONTINUE.md` pass with the round table: per round, the mean metrics for each tuning
  session, then the held-out before and after.
- What changed, and what verifies it (the test count).
- What is unscored.
- The weakest area left, pointing at BACKLOG items.
- The new output sections go into the tool's reference doc (for the handoff target,
  [resume-and-handoff](resume-and-handoff.md)).

## 8. Runs so far

| Date | Target | Sessions | First → last | Held-out or control |
|---|---|---|---|---|
| 2026-09-19 | handoff | a build session; a long interview session | 0.26 → 0.85; 0.02 → 0.29 | 0.04 → 0.39 |
| 2026-09-19 | handoff, operator sessions | a 15-hour `/loop` board session | 0.12 → 0.31 (flat from r3) | 0.03 → 0.24 |
| 2026-09-18 | trigger drill, description 725 → 598 chars | 15 prompts, 4 blind agents | positives 13/18 → 16/18 | false fires 0/12 → 0/12 |

What the two runs taught, beyond their tool changes:

- **A key that leans on judgement caps the score.** Facts that only a transcript reader gets
  (design reasoning, a scratch probe's result) are out of reach for a tool that uses no model. The
  operator run flattened at round 3 for this reason, and the judge's findings turned to "judgement".
- **The held-out is where overfitting shows.** The first run's tuning session reached 0.85,
  while the held-out reached 0.39.
- **Read the consumers' one-line complaints before the judge's report.** They cost nothing and
  say what the output was worst at in the consumer's own terms ("what is still true right now").
  They are not graded, so treat them as leads.
