# Session shape: verification, message length, and the dashboard

Three tools that answer "how did this session BEHAVE", as opposed to "what did it do"
(`analyze-claude-session.mjs`) or "what did it cost the fleet" (the aggregate tools).

They share `lib/turns.mjs` (a per-event view of one transcript) and `lib/metrics.mjs`
(the derived numbers), so the text reports and the dashboard cannot disagree about the
same session.

| Tool | Answers |
|---|---|
| `verify-runs.mjs` | Did it ever run the tests? When, how often, what did the output cost? |
| `message-stats.mjs` | How long were its messages? Did it talk to itself? Where did the output tokens actually come from? |
| `session-dashboard.mjs` | All of the above as one self-contained HTML page, plus a workflow-specific panel |

## verify-runs.mjs

```bash
node verify-runs.mjs <path|sessionId|--latest> [--all] [--full] [--json]
```

Classifies every shell command into `test / typecheck / lint / build / run-app /
install / git / write / inspect / speckit-script / format / other`, joins each to its
result, and reports:

- **when verification first happened**, and how many file writes preceded it
- **flying-blind stretches** — consecutive file writes with no verification between
  them. The worst stretch is the number worth quoting; a median of 2 with a worst of
  19 is a different session from a flat median of 19.
- **output cost** — what the verification output added to context, how much of it was
  identical text arriving again (a verbose runner re-printing a passing suite), and
  how many runs were already filtered through `head`/`grep` or a quiet reporter.

### Classification is not a regex over the whole command

Two corrections, both of which produced wrong answers first:

- **Heredoc bodies are stripped.** `cat > package.json <<'EOF' … "test": "vitest run" …
  EOF` mentions the test runner without running it. Uncorrected, it moved "first
  verification" six minutes earlier than the truth, which is the headline this tool
  exists to give.
- **Quoted strings are blanked.** A commit message, a `grep` pattern, and the machine
  capacity probe (`Where-Object CommandLine -match 'vitest'`) all name build tools
  they do not run.

Compound commands (`sed …; tsc --noEmit; vitest run`) get a SET of categories; the
primary is the most load-bearing one, so a call that edits then tests counts as a test
run. `commandCategories()` in `lib/turns.mjs` returns the whole set.

## message-stats.mjs

```bash
node message-stats.mjs <path|sessionId|--latest> [--top N] [--json]
```

- **Length distribution** as a histogram plus percentiles. A mean is useless here: the
  lengths span three orders of magnitude, and the shape is usually one long final
  report over a floor of one-line asides.
- **Narration vs reports.** A text block is a REPORT if no tool call follows it before
  control returns to a human; everything else was written mid-run for no reader. In an
  autonomous run even the reports have no live reader, and the tool says so.
- **Where the output tokens came from.** Assistant prose is usually the smallest of the
  four sources — tool INPUTS (writing files, composing commands) dominate. The exact
  billed `output_tokens` are printed next to the character-based estimate, so the gap
  is visible: it is mostly reasoning tokens, billed but not stored in the transcript.

Human turns are counted through `lib/prompts.mjs` `classify()`, so harness text does
not masquerade as a typed prompt. That classifier now also drops
`(Re-invocation of /<skill>)` and `Skill /<name> is already loaded above` — measured on
a five-feature Spec Kit run where 7 of 8 apparent "human" turns were those notices.

## session-dashboard.mjs

```bash
node session-dashboard.mjs <path|sessionId|--latest> [-o out.html]
    [--lens auto|cost|speckit|none] [--repo <dir>] [--json] [--md]
```

Three renders of one analysis. `-o f.html` is the page a person opens; `--md` prints the
lens panels as Markdown on stdout, which is what an agent should read (a fifth of the
page's size, the same answers, nothing written to disk); `--json` is everything as data.
The Markdown and the page are printed from the same lens object, so they cannot disagree.

One HTML file, no network calls, light and dark, safe to commit next to the run it
describes. Two halves, deliberately:

- **Generic** — token ledger, context curve with compaction markers, per-minute rhythm
  stacked by what each call was for, verification strip, message shape, tools, failures.
  Comparable across any two sessions.
- **Lens** — the questions that only make sense for one workflow.

`--repo` points at the checkout the session worked in (default: the session's own
`cwd`, if it is still on this machine). The transcript is authoritative for *when* and
*how much*; the repo is authoritative for *what came out*.

### Writing a lens

One file in `lib/lenses/`, registered in `lib/lenses/index.mjs`:

```js
export const id = "mylens";
export const title = "…";
export function detect({ meta, events, calls }) { return /* is this that kind of run? */; }
export function analyze({ meta, events, calls, apiCalls, repoDir, path }) {
  return {
    headline:  [{ label, value, note }],        // stat tiles
    questions: [{ q, a, detail }],              // the answers, stated
    sections:  [{ title, note, table: { cols, rows } }],  // the evidence
  };
}
```

`--lens auto` (the default) runs every lens whose `detect()` says yes. Lens panels come
first on the page: they answer the question the reader came with.

### The cost lens

Answers "this session was expensive; what do I change?" for any session with usage
(`detect` is always true). Every figure is in $ at list price (`lib/quota.mjs`), and it
covers the **main thread and every subagent**: their transcripts sit in
`<session>/subagents/*.jsonl` and are read directly, because a delegating session's main
thread can be a fifth of its cost. The generic half of the page is main-thread only and
says so.

| Panel | Answers | Basis |
|---|---|---|
| total, split, per model | what it cost; main vs subagents; Claude Code's own `cost-state` total and the gap (calls with no usage row) | exact |
| context shape + cost by context band | peak, median, share above 200k; $/call and output/call per band; cache hit rate | exact |
| idle / cold cache | re-writes after a gap longer than **each thread's** TTL (main 1 h, subagents often 5 min) | exact |
| phases | the session cut at every human prompt and compaction, $ main and subagents per phase; share steered by a `/goal` or Stop-hook loop rather than a person | exact |
| costliest 60-minute stretches | sliding window over all calls, labelled with commits, files written, subagents | exact |
| levers | ranked savings, each with a basis: `measured`, `simulated` (compaction replay), `estimated`, `price swap` | mixed, labelled |
| what filled the context, biggest injections, fixed prefix | carry cost: tokens × later calls of the same thread × cache-read price | estimated |
| subagents | per subagent and per launch wave / role: cost, files touched and shared, its final report | exact $ |

**Estimates are sized two ways.** Where a tool result is the only thing added between two
calls, the next call's cache write minus the previous call's output is its measured size
(`=`). Everything else is chars ÷ 4 (`~`); tool output and code are scaled by the median
measured/estimated ratio of that session's results of 1k+ tokens (measured ×1.5–1.6 on two
sessions), prose (CLAUDE.md, the skill listing) is not, since it tokenises close to ÷ 4.

Tuned in five eval rounds on 2026-09-19; the lab record is [lab.md](lab.md) §8.

### The speckit lens

Answers, for a GitHub Spec Kit run: did the prescribed loop actually run, what did each
phase cost, what did the ceremony produce, and which phase leaves nothing behind.

**Phase boundaries are inferred, and they have to be.** Claude Code loads a skill once
per session and emits a re-invocation notice on later uses, so counting `Skill:` calls
alone under-reports every phase after the first feature — measured: 14 skill
invocations for a run that produced all seven artifacts for all five features. A phase
is therefore detected from any of four kinds of evidence, and every row says which one
it rests on:

| mark | evidence |
|---|---|
| `S` | the Spec Kit skill was invoked |
| `s` | its `.specify/scripts/*` script ran |
| `a` | only the artifact it owns appeared |
| `c` | source/test writes (implement) |
| `r` | no in-session marker at all — the evidence is in the committed artifact |

`r` is how `clarify` is recovered: a spec carrying a `## Clarifications` section proves
the phase ran, even though the edit is indistinguishable from any other spec edit in
the transcript. `analyze` has no such artifact, which the lens reports as a finding
about the workflow rather than a gap in the measurement.
