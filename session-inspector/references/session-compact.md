# A compact fork — session-compact.mjs

_session-inspector reference. Commands run from the skill directory (`node scripts/…`)._

## The middle ground between a fork and a handoff

`claude --resume <id> --fork-session` carries the whole conversation, at the whole price: every
file the session read, every command output it scrolled through, every file it wrote. A handoff
brief ([resume-and-handoff](resume-and-handoff.md)) costs a few thousand tokens and starts a
**new** session from a written summary, so the conversation itself is gone. `session-compact.mjs`
is the form in between: a **fork whose history is modified** rather than a new session opened
with a prompt. The prompts and the assistant's replies are kept byte for byte — they are cheap —
and the tool traffic, which is where a working session spends its context, is cut.

```powershell
node scripts/session-compact.mjs <id-prefix|path|--latest> --dry-run          # the numbers only
node scripts/session-compact.mjs <locator> --fork                              # a copy beside the source, new id
node scripts/session-compact.mjs <locator> --fork --mode narrate --recent 2    # smaller, keep the last two prompts' calls
node scripts/session-compact.mjs <locator> --out C:\tmp\copy.jsonl --session-id <uuid>
node scripts/session-compact.mjs <locator> --in-place                          # a copy you already made (refuses a live file)
```

`--fork` prints `SESSION_ID: <id>` and `PATH: <file>` as the last two lines of stdout, the stats
to stderr, so a launcher captures the id and shows the report. Then `claude --resume <id>` in the
transcript's folder, under the account it lives in. No `--fork-session`: the copy already has its
own id. The source is never written.

## What it changes, and what it never touches

Every line stays, in order, with its `uuid` and `parentUuid`, so a resume walks the copy exactly
as it walked the original. Human prompts, assistant text and thinking blocks are untouched
(thinking from earlier turns is not billed on a resume anyway). Only two block kinds change,
and only **before** the cut-off:

| Mode | `tool_use.input` | `tool_result.content` |
|---|---|---|
| `pairs` (default) | the same keys and types; any string over `--input` chars (200) is cut to a head with a `[session-compact: N chars, M lines cut]` note; a `Write`'s content becomes one line naming its size | a head (`--head`, 240) and a tail (`--tail`, 160) with `… [session-compact: N chars, M lines omitted] …` between; an `is_error` result keeps twice as much |
| `narrate` | one line, what was done: `Read src/a.ts`, `Bash: git status — …`, `Edit src/a.ts: "old…" → "new…"`, `Write src/b.ts (80 lines)` | one line, what came back: `200 lines`, `4 lines; first: …; last: …`, `ERROR: … (+30 lines)` |

Two more depths use a **model**, and take a profile of their own — that is their point: compact
on a cheap profile or model, resume on the strong one. `--llm-model` (haiku when empty and no
profile is named; with one, no `--model` is passed and the profile's own `ANTHROPIC_MODEL` runs),
`--llm-settings <settings.json>` (a provider profile), `--llm-config-dir <home>` (an account
or a nexos gateway home):

| Mode | What runs | What the copy holds |
|---|---|---|
| `llm` | one headless `claude -p` per batch of ~20 calls under the compactor profile (`lib/narrator.mjs`), asked for a `did` / `got` pair per call, facts kept: paths, counts, error text, test tallies. Floor per call 3.4k tokens (`--system-prompt`, `--tools ""`, `--setting-sources ""`, no session persistence). A call the model skipped falls back to the `narrate` cut. | the same pairs as `narrate`, written by the model: `Count node.exe total, vitest workers by parent ProcessId` → `39 node.exe total, 17 vitest workers; parents: …` |
| `summary` | Claude Code's own `/compact`, run headlessly on the copy: `claude -p --resume <copy> --model … "/compact"` (`lib/summarize.mjs`). The copy's account is fixed by where it lives; the settings profile and the model are free. | the whole copy plus a `compact_boundary` and Claude Code's summary; a resume starts at the summary, the conversation is gone from context — the handoff end of the scale, with the transcript kept on disk |

The `tool_use` id, name and the `tool_result` id and `is_error` are kept in every mode, so the
API still sees a valid pair. `pairs` is shape-preserving, so anything that renders a past turn
(the TUI's history view reads `toolUseResult`) meets the types it expects; the sidecar fields
Claude Code writes beside the blocks (`toolUseResult`, `wireToolInputs`) are shrunk the same way,
type-preservingly, so the file shrinks with the context.

**The cut-off.** Calls after the last `--recent` human prompts (default 1) stay verbatim: the
file the session was just reading is the one the continuation needs whole. `--recent 0`
compacts everything. A compaction summary (`isCompactSummary`) is not a prompt. Fewer prompts
than `--recent` means nothing changes. Subagent sidechain lines are never touched.

## Measured 2026-09-19

On an uncompacted 34-call, 3-prompt session in this repo (Claude Code 2.1.278, first resumed
turn, `claude -p --resume`, same cwd, cold cache; the base is a fresh session in the same folder):

| Copy | Context on the first turn | History over the base |
|---|---|---|
| fresh session, no history | 59.6k | – |
| plain copy (a fork) | 99.5k | 39.8k |
| `pairs --recent 0` | 83.7k | 24.1k (−40 %) |
| `narrate --recent 0` | 78.7k | 19.0k (−52 %) |
| `llm --recent 0`, haiku narrating | 77.8k | 18.2k (−54 %), $0.11 to make (3 calls, 36k in / 7.8k out) |
| `summary`, haiku compacting | 62.3k | 2.6k (−93 %), $0.03 to make |

All five resumed and answered. **The provider case, measured the same day:** the same two
depths through a zai settings profile (`--llm-settings settings_zai.json`, `ANTHROPIC_BASE_URL`
→ api.z.ai, a GLM model) both worked — `/compact` accepted the Anthropic-signed transcript and
wrote a 13k-char summary in 206 s, the narrator answered all 34 calls in valid JSON — and both
copies then resumed on the default Anthropic account (opus) and answered a content question
correctly. Two things to know: with a profile named, the tool passes **no `--model`**, so the
profile's own `ANTHROPIC_MODEL` runs (the first run had defaulted to `haiku`, which zai maps to
its `glm-4.5-air`; that is fixed); and the `$` figures for a provider profile are Claude Code's
estimate at Anthropic prices for the mapped model name, not the provider's bill.

`llm` is not smaller than `narrate` in tokens; it is what the
lines say that differs (a measured value, a count, an error text instead of "first: …; last:
…"). `summary` is the cheapest to resume and the most lossy: what survives is what Claude Code's
compaction prompt keeps. The remaining history is prompts, replies, tool_use inputs and
the per-turn system reminders Claude Code re-injects, which the tool does not touch.

Two things the measurement settled, both worth knowing before reaching for this:

- **A session that was already compacted gains nothing.** Claude Code resumes from the last
  compaction summary, so the tool calls before it are not in context whatever the file holds.
  The dry run still reports them as compacted; the saving is on disk only.
- **The chars/4 estimate the tool prints is an estimate of the message content**, not of the
  resumed context: JSON tokenises worse than 4 chars a token, and the resume adds reminders
  the file does not carry. Quote the measured table, not the estimate, for a saving.

Claude Code's own binary carries a time-based microcompact (`[Old tool result content
cleared]`, keep-recent). It did **not** fire on this session at 99.5k, with timestamps a month
old or two minutes old, so the tool is not duplicating something the resume would have done.
Whether it fires nearer the context limit was not tested.

## When to use which

| You want | Use |
|---|---|
| The same conversation, everything in it, on another settings profile | fork (`--fork-session`) |
| The conversation's thread and decisions, without the files it read and the outputs it saw | **compact fork**, `pairs` |
| The thread only, smallest, and the session can re-read anything it needs | **compact fork**, `narrate` |
| A different account, a different harness, or a session cut off by a limit an hour ago | handoff brief — the cache is dead and the account is the problem, not the size |
| A wrong turn to correct before continuing | `session-edit.mjs` on a copy, then compact if it is also long |

The agent-pick branch wizard (Ctrl+Alt+F) offers **compact** as an action next to fork, edit,
continue, handoff and new, with `[c]` choosing the depth; `! cfork -compact` (`-narrate` for the
smaller form) does the same from inside a session. Both call this tool with `--fork --recent 1`.
