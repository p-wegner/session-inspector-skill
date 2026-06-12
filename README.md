# session-inspector (portable agent skill)

A self-contained, portable copy of the **session-inspector** agent skill: inspect
agent session transcripts from **Claude Code** (`~/.claude/projects/`), **Codex CLI**
(`~/.codex/sessions/`), and **GitHub Copilot CLI** (`~/.copilot/session-state/`) to
debug why a session stopped, what it did, and whether it produced output.

Unlike the version embedded in the [agentic-kanban](https://github.com/p-wegner/agentic-kanban)
repo, this copy **bundles its own analyzer scripts** and depends only on Node builtins
(`fs`/`path`/`os`) — no monorepo checkout, server, package install, or board required.

## Layout

```
SKILL.md                 # the skill entrypoint (frontmatter name: session-inspector)
references/
  claude-recipes.md      # manual PowerShell recipes for Claude transcripts
  codex-recipes.md       # Codex {timestamp,type,payload} event format + recipes
  copilot-recipes.md     # Copilot events.jsonl format + recipes
  aggregate-tools.md     # usage for the fleet-wide fan-out scripts
scripts/
  analyze-claude-session.mjs    # single Claude session → structured summary
  analyze-codex-session.mjs     # single Codex session  → structured summary
  analyze-copilot-session.mjs   # single Copilot session → structured summary
  token-sinks.mjs               # rank token/cost sinks across MANY sessions
  tool-failures.mjs             # rank failed tool calls across MANY sessions
  user-prompts.mjs              # extract real human-typed prompts across MANY sessions
```

## Quick start

```bash
node scripts/analyze-claude-session.mjs  --latest
node scripts/analyze-codex-session.mjs   --latest
node scripts/analyze-copilot-session.mjs --latest

node scripts/token-sinks.mjs    --days 7
node scripts/tool-failures.mjs  --by error
node scripts/user-prompts.mjs   --today
```

Requires Node 18+. All scripts read from the standard agent home dirs
(`~/.claude`, `~/.codex`, `~/.copilot`) and write only to stdout.

## Install as an agent skill

**Claude Code** — clone, then junction/symlink into your skills dir under the
skill's frontmatter name (`session-inspector`):

```powershell
# Windows (junction)
New-Item -ItemType Junction -Path "$HOME\.claude\skills\session-inspector" -Target "C:\path\to\session-inspector-skill"
```
```bash
# macOS / Linux (symlink)
ln -s /path/to/session-inspector-skill ~/.claude/skills/session-inspector
```

**Codex** — junction/symlink the same target into `~/.codex/skills/session-inspector`
so both harnesses share one implementation.

## Notes

- A few snippets in `copilot-recipes.md` and `aggregate-tools.md` reference an
  agentic-kanban **board API** / server-side `fleet-analysis` roll-up. Those paths
  are **optional** and only apply if you run that board — every bundled script works
  standalone with nothing but Node.
- Source of truth for the non-portable version lives in
  `agentic-kanban/.claude/skills/session-inspector` + `agentic-kanban/scripts`.
