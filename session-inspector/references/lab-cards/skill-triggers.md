# Target card: skill triggers

_A card for [the integrated lab](../lab.md). Copy it into the lab directory (session scratch)
before round 1 and fill the blanks there; from then it is frozen for the whole lab. This copy
holds no session content and is the template for the next run of this target._

Status: **not run.** Every field below is a recommended default (2026-09-19), not a measurement.

| Field | Value |
|---|---|
| `use_case` | an operator decides, per installed skill, whether to keep it, fix its description, or retire it |
| `consumer` | a fresh Sonnet agent playing the fleet operator; gets the tool output plus at most 6 read-only commands: listing a profile's `skills/` dir and reading a `SKILL.md` frontmatter. No transcripts |
| `tools` | `skill-usage.mjs` (default, `--cost`), `slash-goals.mjs`, `user-prompts.mjs`; `skill-genesis.mjs` only if the questionnaire's "too new" question needs it |
| `questionnaire` | 1 which skills fired, and how often, in the sessions shown · 2 which skills should have fired on a named prompt and did not · 3 which fired where they should not · 4 which skills are dead **while available**, with the denominator · 5 which are too new to judge · 6 per skill in the key: keep / fix description / retire · 7 the one description change that would recover the most missed fires · 8 what the output could not tell you |
| `key_source` | one key agent per session reads the full transcript and the skill descriptions **as they stood on the session's date** (the skill repos' `git log`, or the profile's junction targets at that sha). Labels each human prompt with the skill that should have fired, or `none`. Never reads `skill-usage` output |
| `metrics` | verdict accuracy (Q6) weighted by the key; missed-trigger recall and precision (Q2, Q3); **wrong retire verdicts** as the X count; brief-only share and total share as in `lab.md` §4 |
| `sessions` | 2 tuning sessions, 1-3 hours each, from different profiles, one containing a known boundary (a context question that competes with `token-budget`, a quota question that reads as no skill); 1 held-out from another repo and another day. Fill the ids in the scratch copy only |
| `rounds`, `consumers_per_target` | 3 and 2 (extend to 5 only if round 3 still moves by more than ±0.1) |
| `baseline_sha` | HEAD of the repo when round 1 freezes |

**Expected ceiling, stated before the run.** "Should have fired" is a judgement about a prompt,
which no script recovers. Expect the judge's findings to turn to `judgement` early. The likeliest
general change is a *candidate* list (human prompts carrying a skill's description terms with no
invocation), printed as candidates and never as misses, with a test for a prompt that matches a
term and must not be listed as a miss.

**Wrong answers the key should list** (defaults): a skill called dead that was installed after
the window started; a skill called dead because it is invoked by another skill rather than by a
prompt; a fire counted from a skill body pasted into a prompt; a retire verdict for a user-invoked
skill that nobody typed in the window.
