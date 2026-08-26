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
