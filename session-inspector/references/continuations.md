# Which work to pick up next — continuations.mjs + the human gate

_session-inspector reference. Moved verbatim out of `SKILL.md` on 2026-08-26 so the skill body stays small; commands are run from the skill directory (`node scripts/…`)._

## WHICH WORK TO PICK UP NEXT → a human-gated spawn plan (`continuations.mjs`)

**Start here when the ask is "what should we continue working on?", "what could we
pick up?", "which sessions have good follow-up steps?", or "spawn sessions for
them".** Do NOT hand-assemble this from `resumable.mjs` + a scan script + `awk`
over CONTINUE.md files — that is exactly what this tool replaces.

The thing to know before reasoning about it: **the answer is usually not in the
transcripts.** They tell you where work STOPPED; what to DO next is written in each
repo's `CONTINUE.md` / `BACKLOG.md`. Cut-offs are one input among several, and on a
measured fleet only 3 of 321 "cut-off" hits were real.

```powershell
node scripts/continuations.mjs                      # ranked shortlist + why, per repo
node scripts/continuations.mjs --days 14 --top 8
node scripts/continuations.mjs --project kanban      # one repo
node scripts/continuations.mjs --profiles 5x,5x_2,5x_3,5x_4   # accounts to spread across
node scripts/continuations.mjs --json
```

It ranks REPOS (not sessions), joining: sessions in the window (who worked where,
what a limit cut off, what a human last asked, and — via `lib/provenance.mjs` —
whether a HUMAN drove it or the board launched it) × the repo's own open items ×
git state (unpushed, dirty) × the present (a live session in that checkout, quota
headroom per profile). Every score term appends its own reason, so the ranking is
readable rather than trusted.

### A CONTINUE.md can hold two contradictory pictures at once

The convention writes passes newest-first and archives older ones out past ~600
lines. When that archive pass is overdue the file keeps *both* pictures, and a
positional read cannot tell them apart.

Measured 2026-08-27 on `agentic-kanban`, whose `CONTINUE.md` had reached **2279
lines**: line 6 was a 2026-08-25 pass headed "#807 done", while line 930 — inside
the 2026-08-23/24 pass — still read *"Operator: decide the push. It unblocks #834
and #807 together."* The tool surfaced the second as the repo's top next step. It
reached a human and a handoff brief before another session caught that #807, #831
and #834 had all closed on 2026-08-26.

So each level-2 pass is dated (from any `YYYY-MM-DD` in its heading), and an item
from a pass older than the newest dated one is **stale**:

- it sorts **after** current items, so it is not what gets quoted or seeded;
- it is scored at ~1 point instead of 3, capped at 2 total — a repo whose open
  items are *all* superseded scores 2, not 15;
- it is printed `⚠stale`, and the seed message tells the spawned session to verify
  it is still open;
- the doc itself gets a `⚠ DOCS` line naming the length and how many items predate
  the newest pass.

**Stale items are demoted, never dropped.** A superseding pass does not always
restate what it replaced, so deleting a stale-looking item can lose real work — the
same asymmetry that makes the parser report anything ambiguous as open. A false
positive costs a glance; a false negative loses the work.

Undated headings are **not** stale: the convention's standing sections ("What is
true today", "Next steps", "Blocked") carry no date and stay live no matter how old
the dated passes below them are. Verified against `slidesmith`, where all five open
items sit in an undated standing section under 28 dated passes and none are flagged.

The `⚠ DOCS` warning fires on length alone, so it also catches a doc whose passes
carry no dates at all — where staleness is undetectable and the length is the only
honest signal available.

Two exclusions, both always reported, never silent:
- **a session is already live there** → not a candidate (spawning a second agent
  into one checkout is how cross-author commits happen). `--include-live` overrides.
- **recent but no open work** (no doc items, clean tree, nothing cut off) → recency
  alone is cheap to earn and should not outrank six documented open items.
  `--include-thin` overrides.

### The human gate

**Nothing spawns without a person picking.** `--plan` writes every candidate
`approved: false`; spawn-session's `-batch` launches only `approved: true` and
exits 3 otherwise. So the gate cannot be forgotten — only answered.

```powershell
node scripts/continuations.mjs --plan plan.json     # writes the plan + prints the summaries
node scripts/continuations.mjs --review plan.json   # a HUMAN at a terminal: y/n/a/q per entry
node scripts/continuations.mjs --approve plan.json --pick 1,3   # an AGENT: record the answer
node scripts/continuations.mjs --approve plan.json --pick none   # reset
& "<repo>\spawn-session\spawn.cmd" -batch plan.json
```

**If you are the agent: you cannot answer `--review`** (its stdin is not a TTY and
it refuses). The correct sequence is: run `--plan`, show the human the per-candidate
`summary` blocks (they are written to be read as-is — repo + git state, why it
surfaced, its top open items quoted from its own docs, the last human instruction,
the evidence session, whether a cut-off there was already picked up, and any
conflict), ask which to spawn, then record it with `--approve --pick`. Never
approve on the human's behalf, and never claim a spawn happened that `-batch` did
not report.

Each approved entry carries a `message` built from that repo's own open items,
ending non-committally ("tell me the state, verified vs claimed, before editing") —
edit it in the plan file if you want something else spawned.
