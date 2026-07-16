# Tooling improvement — turning session friction into a shipped fix

This is a use case beyond debugging one session or ranking a fleet by pain:
**mine many sessions for repeated interaction patterns, then change the tool
(CLI, skill, default, or prompt) so the pattern stops being necessary.** The
loop is:

```
detect (script)  →  validate (read a few real sessions)  →  prototype the fix
   →  re-run detect on fresh sessions  →  confirm the pattern shrank
```

Detection alone is not the deliverable — a ranked list of "agents do X a lot"
is only useful once someone reads a few real instances and turns the pattern
into a decision: bake it into a default, add a combined verb, or leave it
alone because the friction is intentional (a safety gate, a deliberate
two-step confirm).

## Two distinct friction signals — don't conflate them

| Signal | What it means | Where it's already measured |
|---|---|---|
| **Repeated identical command, same session** | A retry/rerun loop — the agent tried something, it didn't work (or wasn't verified), so it ran the same thing again. Friction from **failure**. | `repeatedCommands` in `lib/parse.mjs`, surfaced by `analyze-*-session.mjs` and `incidents.mjs` (`reruns` score). |
| **Ordered chain of DIFFERENT commands, recurring across MANY sessions** | The agent is manually gluing together steps that a single tool call should do. Friction from **the tool's shape**, not from failure. | `scripts/tool-friction.mjs` (new — see below). |

The first is "this session struggled." The second is "every session pays this
tax, and it's not the agent's fault — it's a gap in the tool." This doc is
about the second kind.

## `tool-friction.mjs` — detect recurring command chains

```powershell
node scripts/tool-friction.mjs --days 60 --min-sessions 4        # fleet-wide
node scripts/tool-friction.mjs --project <substr> --days 90       # one project
node scripts/tool-friction.mjs --grep rb-refactor --n 2,3          # narrow to one CLI
node scripts/tool-friction.mjs --json                              # for scripting
```

It normalizes each Bash-like command to a signature (interpreter/script +
up to 2 bare-word subcommand tokens, flags and paths stripped — e.g. `node
rb-refactor.mjs rename --kind method --file x.rb` → `rb-refactor.mjs
rename`), slides an n-gram window (default sizes 2 and 3) over each session's
command list, and ranks chains by **sessions-that-used-it × occurrences** — a
chain seen in 30 different sessions twice each is a stronger signal than one
session running it 20 times (that's the *other* signal, above).

### Worked example — real output from this machine's fleet

```
node scripts/tool-friction.mjs --days 60 --min-sessions 4 --top 20

  occ  sess chain
   60    41  grep → cd
   45    38  git add → git commit
   42    37  git status → git add
   42    36  ls → cd
   42    33  git status → git diff
   49    27  grep → sed
   31    26  grep → npm run coverage:check
   28    20  git add → git pull
```

Reading these (the "validate" step — don't act on a chain without reading a
few real instances):

- **`grep → cd` / `ls → cd` (41 / 36 sessions)** — the agent is shelling out
  to raw `grep`/`ls`/`cat` to explore, then `cd`-ing into what it found,
  instead of using the harness's own `Grep`/`Glob`/`Read` tools (which don't
  need a `cd` at all — they take an absolute `path` argument). This is a
  **discoverability/enforcement** gap, not a missing CLI verb: the dedicated
  tools already exist and are already documented as preferred, but raw shell
  fallback still wins some of the time. Fix lives in the harness-facing
  instructions (nudge harder, or make raw `grep`/`cat`/`ls` cost a permission
  prompt while `Grep`/`Read`/`Glob` don't), not in a target repo's CLI.
- **`git status → git add` → `git commit` (37 → 38 sessions)** — the classic
  stage-then-commit flow. High frequency, but this is very likely a
  **don't-fuse** case (see below): each step is a distinct human-auditable
  checkpoint (see *what* changed, stage *only* the intended files, write the
  message), and the project's own CLAUDE.md explicitly warns against
  `git add -A`. Collapsing it into one `git commit -a` step would trade a
  safety gate for a few saved tool calls — not worth it.
- **`grep → npm run coverage:check` (26 sessions)** — the agent searches for
  something (a function name, a file) and then runs the *whole* coverage
  check, when it likely only cared about one target. A real candidate: does
  `coverage:check` accept a filter argument? If not, that's a concrete,
  scoped feature request with 26 sessions of evidence behind it.

That's the pattern this doc exists to teach: **the chain ranking tells you
where to look, not what to do** — some hits are "add a verb," others are
"leave it, the friction is the point."

## Strategy catalog

Each strategy: the signal that points at it, why the friction exists, the
fix shape, and a worked/hypothetical example. Use `refactor-skill` (this
machine's own multi-verb Ruby refactoring CLI, `src/rb-refactor.mjs`) as the
sandbox for prototyping any of these — it's a real, actively-used multi-verb
CLI with a uniform dry-run/`--apply` convention, so a fix here is testable
immediately with a real invocation, not a toy.

### 1. Sequence fusion — combine a repeated chain into one verb
**Signal:** an n-gram chain recurring across many sessions where the steps
have no independent value to the human (no intentional checkpoint between
them). **Fix:** add a combined command/flag that does all steps in one call.
**Caveat:** verify the chain isn't a deliberate safety gate first (see the
`git add → git commit` case above) — fusing away a checkpoint is a
regression dressed as an improvement.
**Example in `rb-refactor.mjs`:** every verb is dry-run-by-default with a
separate `--apply` to execute — intentionally NOT fused (that's the
project's safety model). But "apply, then run the test suite to confirm
nothing broke" is a chain worth checking for: if sessions show
`rb-refactor.mjs <verb> --apply` followed by `node test/ruby.mjs` in the
overwhelming majority of cases with no exceptions, an `--apply --verify`
flag that runs the fixture suite automatically after applying (and reports
the diff instead of leaving it to a second manual step) removes a
100%-predictable second call.

### 2. Default-baking — the agent passes the same flag every time
**Signal:** in `tool-friction.mjs`'s raw command list (or `--grep <verb>`
on `analyze-*-session.mjs --events`), one flag shows up on nearly every
invocation of a verb. **Fix:** flip the default; keep the flag only for the
rare opt-out. **Example:** if `rb-refactor.mjs rubocop` is *always* invoked
with `--safe`, safe-only correction should be the default and a
`--unsafe`/`--all` flag should be the one requiring an explicit ask.

### 3. Wrapper CLI verb — agent glues together 2+ *different* tools
**Signal:** a cross-tool chain (not just cross-command within one CLI) —
e.g. `rb-refactor.mjs find --kind method <name>` followed by a hand-rolled
`sed`/sequence of `Edit` calls to do what a dedicated verb already does for
other symbol kinds. **Fix:** extend the existing verb surface instead of
letting the agent hand-roll the equivalent with generic tools — cheaper to
review (one command instead of N edits) and gets the same safety net
(dry-run diff) the rest of the CLI has.

### 4. Guardrail-baking — the agent manually checks before acting
**Signal:** a session's transcript shows the agent reading a file / running
a query to check a precondition before calling the actual tool, and that
check-then-act chain repeats. **Fix:** move the check *into* the tool as a
preflight validation with a clear error, so skipping the check is not an
option that can silently go wrong — this beats "remind the agent to check
first" because it's enforced, not requested. **Example:** `rb-refactor.mjs
safe-delete-method` already does this right (refuses if call sites exist,
rather than relying on the agent to `find` first) — a good pattern to spot
where *other* verbs still expect the agent to self-check.

### 5. Error-recovery loop → root-cause fix
**Signal:** this is the *other* friction signal — `repeatedCommands` /
`incidents.mjs`'s `reruns` score — the same command run 2+ times in one
session. **Fix:** don't add a retry-helper; find out *why* the first call
failed (ambiguous error message? a precondition the tool doesn't check? a
flag whose behavior surprises agents?) and fix that, or improve the error
message so the retry is correct on attempt 2 instead of attempt 4.
**Example:** if `analyze-claude-session.mjs --events --grep <word>` errors
are dominated by one confusing message, that message — not a new flag — is
the fix.

### 6. Verbose-output trimming — the agent re-requests a smaller view
**Signal:** a tool call followed by the agent immediately grepping/filtering
its own output, repeatedly. **Fix:** the tool should offer the filtered view
directly (a `--json`/`--quiet`/`--summary` flag) instead of dumping
everything and making the agent post-process — cheaper in tokens, since the
raw dump was already paid for once and the filter is redone by hand every
time. This skill's own scripts already lean on this (`--json` on nearly
every analyzer) — a good baseline to hold new scripts to.

### 7. Batch mode — repeated single-item calls in a loop
**Signal:** the same verb invoked N times back-to-back with only one
argument differing (e.g. `rb-refactor.mjs rename --kind method` called once
per method in a list). **Fix:** accept a list/glob in one call instead of N
processes — cuts both wall-clock and the N-1 redundant startup/parse costs.

### 8. Discoverability — the agent reinvents something that already exists
**Signal:** a hand-rolled multi-step sequence that duplicates a capability
the CLI or skill already has, just under a name/verb the agent didn't know
to look for (this is the `grep → cd` example above, one level up: the
harness has `Grep`/`Read`/`Glob` and the agent still shells out). **Fix:**
usually not a new feature — improve the verb list's discoverability (put the
capability higher/earlier in `SKILL.md`, name it what an agent would search
for, or make the missing case the FIRST line of the tool's own `--help`).

## Workflow for using this

1. Run `tool-friction.mjs` scoped to the project/CLI you're improving
   (`--project <substr>`, `--grep <cli-name>`). Widen `--days` or lower
   `--min-sessions` if it comes back empty — a young project won't have 40
   sessions of history yet.
2. For each candidate chain, read 2-3 real sessions where it appears
   (`analyze-claude-session.mjs <path> --events --grep <first-command> -v`)
   to confirm it's really the same intent every time, not coincidental
   adjacency.
3. Classify it against the catalog above (which of the 8 patterns, or
   "leave it — it's a deliberate checkpoint").
4. Prototype the fix in the target CLI/skill. `refactor-skill`
   (`src/rb-refactor.mjs`, `src/ruby/refactor.rb`) is a good sandbox: it's a
   real multi-verb CLI with existing conventions (dry-run/`--apply`, `--json`,
   a shared `verbSummary()` formatter) to extend consistently, and
   `test/ruby.mjs` gives immediate pass/fail feedback on a prototype change.
5. Re-run `tool-friction.mjs` against sessions from *after* the fix shipped
   and confirm the chain's occurrence count actually dropped. If it didn't,
   the fix didn't address the real cause (or agents don't know it exists yet
   — loop back to strategy 8).
