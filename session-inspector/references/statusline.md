# Show the session locator in your Claude Code statusline

This skill inspects a session **by file**. The fastest way to point it at the
*current* session is to surface that session's locator in your status line, then
copy-paste it into another agent (or a stronger model) and say *"use the
session-inspector skill on `<paste>`"*. That's the **rescue / model-handover**
move: a weak run gets stuck, you hand its transcript to a stronger one mid-task —
no restart.

Claude Code only. (Codex/Copilot have no equivalent status line; for those, list
with `analyze-codex-session.mjs --list` / `analyze-copilot-session.mjs --list`.)

## What the statusline command receives

Claude Code runs your `statusLine.command` on each update and pipes it a JSON
object on **stdin**. The three fields that matter here:

| Field | Example | Use |
|-------|---------|-----|
| `transcript_path` | `~/.claude/projects/C--andrena-foo/3f2c…b1.jsonl` | The exact transcript file — feed it straight to the analyzer. |
| `session_id` | `3f2c…b1` | The session UUID (also the filename stem). |
| `cwd` | `C:\andrena\foo` | Fallback to derive the project folder when `transcript_path` is absent. |

`transcript_path` already **is** the path the analyzer wants, so the locator is
really just a compact, human-selectable rendering of it:
`<session-id>/<project-folder>` ⇄ `~/.claude/projects/<project-folder>/<session-id>.jsonl`.

**Put the id first, and shorten both parts.** A status line gets truncated on the
right when the terminal is narrow, so whatever you print last is what disappears.
The id is the key; the folder is only a hint. Printing `8e3f1bec/andrena-comet`
instead of `C--projects-andrena-comet/8e3f1bec-4da1-…` means a narrow window still
shows something you can paste. The resolver here handles it:

- **Either order.** `<id>/<folder>` and `<folder>/<id>` both resolve — the segment
  that *looks* like a uuid is taken as the id, whichever side it is on.
- **Id prefixes.** 8 hex digits is plenty; the resolver prefix-matches, and reports
  the candidates if a stub ever matches more than one session.
- **The folder is a tiebreak, never a filter.** A shortened (`andrena-comet`) or
  stale folder narrows the matches when it hits and is ignored when it doesn't, so
  it can't turn a good id into "not found".

## Minimal setup

**1.** Save a small statusline script. This one is Node-only (no `jq`), matching the
skill's "Node builtins" stance — save as `~/.claude/statusline-session.mjs`:

```js
#!/usr/bin/env node
// Prints "🔖 <session-id-prefix>/<project-folder>" for the current Claude Code
// session — id first, so a narrow terminal truncates the folder, not the key.
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let d = {};
  try { d = JSON.parse(raw); } catch { process.stdout.write("Claude"); return; }
  let tp = (d.transcript_path || "").replace(/\\/g, "/");
  let folder = "", sid = d.session_id || "";
  if (tp) {
    const parts = tp.split("/");
    sid = parts[parts.length - 1].replace(/\.jsonl$/, "");
    folder = parts[parts.length - 2] || "";
  } else if (d.cwd) {
    folder = d.cwd.replace(/[^a-zA-Z0-9]/g, "-"); // how Claude derives the project dir name
  }
  // First hex group is enough to resolve (prefix match); drop the "C--projects-"
  // noise from the folder — it stays a substring of the real name, so it still
  // works as the dir hint.
  const short = sid.slice(0, 8);
  folder = folder.replace(/^[a-zA-Z]--/, "").replace(/^projects-/, "");
  const loc = short && folder ? `${short}/${folder}` : short || "(no session)";
  process.stdout.write(`\x1b[2m🔖\x1b[0m \x1b[35m${loc}\x1b[0m`); // dim bookmark + magenta locator
});
```

**2.** Point `statusLine` at it in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline-session.mjs"
  }
}
```

That's it — the locator now sits in your status line. (`type` and `command` are the
only required fields; `padding` and `refreshInterval` are optional.)

### Even simpler (one-liner, exact path)

If you just want the full path and have `jq`, skip the script:

```json
{ "statusLine": { "type": "command", "command": "jq -r '.transcript_path'" } }
```

The locator form above is friendlier to read and select; the raw `transcript_path`
is the most direct thing to feed the analyzer.

## Using it with the skill

Copy the locator from the status line, then either resolve it to a path or hand it
to another agent:

```bash
# the locator works verbatim — no need to expand it to a path first:
node scripts/analyze-claude-session.mjs 8e3f1bec/andrena-comet
node scripts/analyze-claude-session.mjs 8e3f1bec          # id prefix alone is fine
node scripts/analyze-claude-session.mjs ~/.claude/projects/<project-folder>/<session-id>.jsonl
```

…or paste the locator to a fresh/stronger agent: *"use the session-inspector skill
on `8e3f1bec/andrena-comet` — figure out why it stalled and finish it."*

With [cross-machine sync](session-sync.md) running, the same locator is also
searchable from any device: `node scripts/sync-query.mjs search "<session-id>"`,
or open the web UI and filter — so a session that ran on one machine can be inspected
or handed off from another.

## Behavior & caveats

- The command runs on each assistant message / mode change (debounced ~300ms); only
  the **first line** of stdout is shown; ANSI color codes are supported.
- Keep it fast and non-interactive — it's read-only output, re-run constantly.
- A richer status line can fold this locator in alongside model, git, context %, and
  cost; the snippet above is just the minimal piece this skill needs. Full field
  reference: <https://code.claude.com/docs/en/statusline.md>.
