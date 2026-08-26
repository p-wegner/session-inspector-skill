# Edit a session's messages — session-edit.mjs (incl. confidentiality rules)

_session-inspector reference. Moved verbatim out of `SKILL.md` on 2026-08-26 so the skill body stays small; commands are run from the skill directory (`node scripts/…`)._

## Edit a session's user/assistant messages (`session-edit.mjs`)

The analyzers above are read-only. To **change what a session says** — fix a
misleading prompt before handing the transcript to a stronger model, redact a
secret you pasted, correct an assistant message that poisoned the rest of the
run — use `scripts/session-edit.mjs`. Raw `.jsonl` is far too noisy to hand-edit
(one line per content block, escaped JSON, uuid chains), so this is a **two-phase
extract → edit-in-your-editor → apply** flow. Claude transcripts only.

```powershell
node scripts/session-edit.mjs extract --latest -o edits.md    # 1. flatten to a readable file
#  … open edits.md in your editor, change the text under any [edit] header …
node scripts/session-edit.mjs apply edits.md --dry-run        # 2. preview the diff
node scripts/session-edit.mjs apply edits.md                  # 3. write it back, in place
```

> ### ⚠️ Confidentiality rules for the `modify` workflow (MANDATORY)
> When the user asks you to **modify / edit / redact / rewrite** a session, the
> whole point is usually that the content is sensitive (a pasted secret, a
> misleading prompt, a poisoned message). So the modification must NOT bleed back
> into *this* conversation's transcript. Follow these two rules exactly:
>
> 1. **The output must not show the modifications.** Always apply with
>    **`--quiet`**, which suppresses the before/after text and prints only counts
>    (`#seq kind (+N chars) [text hidden]`) plus the confirmation. Do **not** run
>    `apply --dry-run` without `--quiet` (its diff echoes the edited text), and do
>    **not** paste, quote, summarize, or otherwise restate what the edit changed —
>    not the old text, not the new text. Report only *that* it was applied and how
>    many blocks changed. To preview safely, use `apply --dry-run --quiet`.
> 2. **Do not read the file afterward.** After applying, you are **not allowed to
>    Read / Get-Content / grep / cat the transcript `.jsonl`, the `edits.md`, or any
>    `.bak-*` backup** to "verify" the result — that would pull the redacted/edited
>    content straight back into context. `apply` already fails loudly if a write
>    doesn't land (atomic tmp+rename, block-level guards), so its exit code and
>    `Applied N change(s)` line are your confirmation. Trust them; don't re-open the
>    file.
>
> The confidential apply is therefore a single command:
> ```powershell
> node scripts/session-edit.mjs apply edits.md --quiet
> ```

`extract` takes `<path.jsonl>`, `--latest`, or `--session <id-prefix>`, plus the
same `--profile <name>` / `--config-dir <path>` resolution the analyzers use.

**The extracted format.** One `@@@ <seq> <kind> <uuid>#<blockIndex> [edit|read-only]`
header per block, body underneath:

```
@@@ 4 user d5109c08-…#0 [edit]
unzip all files in this folder, dedupe images…

@@@ 5 assistant.thinking 20683a7e-…#0 [read-only]
Let me check what's in the folder first…
… [truncated, 12 more line(s)]

@@@ 6 assistant.tool_use:Bash 9e7730b0-…#0 [read-only]
{ "command": "ls -la" }
```

**What's editable.** By default everything textual: human prompts (`user`),
assistant `text`, assistant `thinking`, `tool_result` payloads, and **`system`
recap lines** (`subtype:"away_summary"` — the recap Claude Code shows when you
resume a session after being away; kind shows as `system.away_summary`,
addressed by `uuid#0` since its text is a top-level `content` string, not under
`message`).

`tool_use` inputs are always **truncated `[read-only]` context** — they're there
so you edit with the conversation in view, and are never written back.

Narrow the scope with `--no-thinking` / `--no-tool-results` when you only mean
to fix a prompt — tool_result payloads are bulky and blow up the extract on a
long session. (`--include-thinking` / `--include-tool-results` are still
accepted as no-ops; they're the default now.)

**It never deletes or reorders lines.** Text is rewritten in place, so `uuid` /
`parentUuid` stay intact and `claude --resume <id>` still walks the transcript.
Only the edited lines are re-serialized; every other byte passes through
untouched, and key order within a line is preserved.

**Guard rails** (all fire before anything is written):
- **block-level conflict detection** — the edit file records a sha256 of the whole
  transcript *and* an `h=<hash>` of each editable block's original text. A session
  routinely flushes a final turn on exit, so a whole-file mismatch alone means
  little. `apply` therefore asks the narrower question: *did a block **you edited**
  change?* If not, it applies and prints a note (appended turns are preserved,
  since blocks are addressed by `uuid`, not line offset). If yes — the block was
  rewritten, or has vanished — it refuses and names the blocks (re-extract to
  rebase, or `--force`). v1 edit files have no per-block hashes and keep the old
  strict refusal.
- **live-session guard** — refuses a source modified in the last 120s, since a running agent could append a turn between the read and the write. Exit that session first, or `--force`.
- **backup** — copies to `<transcript>.jsonl.bak-<timestamp>` before writing (`--no-backup` to skip); the write itself is atomic (tmp + rename).

`--dry-run` bypasses the guards with a warning and prints a per-block before/after
diff without touching disk. `--quiet` hides the edited text everywhere (before/after
lines become `[text hidden]`), leaving only per-block counts and the confirmation —
this is what the confidential `modify` workflow above uses, and it composes with
`--dry-run` (`--dry-run --quiet` = a preview that never echoes content). A round-trip
with no edits always reports **0 changes**, so an untouched `apply` is a no-op. Body
lines that look like a `@@@` header are dot-stuffed on extract and unescaped on apply
— message text can safely contain the delimiter.

**Editing the session you're currently in won't work** the way you'd hope: the
live agent holds the transcript open and rewrites it on every turn, so your edits
are overwritten. Edit a *finished* session, then `claude --resume` it.
