# Target card: the cost of one expensive session

_Lab card for [lab.md](../lab.md). Run 2026-09-19, five rounds plus a baseline and a held-out.
Frozen for the whole lab; a change here starts a new lab, not a new round._

| Field | Value |
|---|---|
| `use_case` | a developer or lead decides what to change so the next session like this one costs less |
| `consumer` | a fresh Sonnet agent with ONE render and nothing else: the HTML page (a person's view) or the `--md` output (an agent's view). No commands |
| `tools` | `session-dashboard.mjs <session> --lens cost` (`-o f.html` and `--md`), whose generic half is also on the page |
| `questionnaire` | 10 questions: total and main/subagent split; token-type and model split; context shape; idle / cold cache; the top 3 bloat sources; avoidable waste; the costliest stretch and what it was doing; subagents and whether they were justified; the one change with a $ saving and a confidence; what the data cannot tell |
| `key_source` | one agent per session with its own script over the raw transcript and the subagent transcripts, forbidden to run or read this skill; usage deduplicated per `message.id`; list prices given; causes named with line numbers and tool ids |
| `metrics` | `dash_score` = weight of facts graded B (read off the output) / all weight; numbers within ±10% are right, 10–30% off is P, beyond 30% is X; wrong answers (X), including a recommendation the key contradicts |
| `sessions` | tuning: the costliest session of the fortnight (15.5 h, one thread, a `/goal` loop, peak context 967k) and a session whose nine Opus subagents were 79% of its cost; held-out: a third repo and day, 17.7 h, idle gaps past the TTL |
| `rounds` | r0 the pre-lab page (1 consumer per session), r1–r4 two HTML consumers per session, r5 one HTML and one `--md` consumer per session; held-out at r0 (frozen render) and r5 |

## What the rounds taught

- **The first defect was in the counting, not in the page.** A key builder working from the raw
  rows found that a subagent's `output_tokens` grows across the rows of one call, so first-row
  deduplication under-counted a delegating session's output about 6x. It is fixed in
  `lib/usage.mjs` (`lateOutput`) and pinned by a test; six tools still use the old rule.
- **Scope has to be stated wherever a number is main-thread only.** Every wrong answer in r0 and
  most of them in r1–r2 came from a main-thread figure read as the session's.
- **chars ÷ 4 undercounts code and JSON by about a third, and not prose.** The next call's cache
  write is the measured size; the calibration factor is taken from the tool output of 1k+ tokens
  and applied to tool content only. Applying it to CLAUDE.md prose (r4) oversized the prefix by
  31% and produced six of r4's eight wrong answers.
- **A key builder paid for the tool's worth of arithmetic, the judge for its misleads.** The
  consumers' one-line complaints named the next change in three of five rounds before the judge
  did.
