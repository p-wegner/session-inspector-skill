# Claude homes/profiles, directory naming, stop_reason, tips

_session-inspector reference. Moved verbatim out of `SKILL.md` on 2026-08-26 so the skill body stays small; commands are run from the skill directory (`node scripts/…`)._

## Multiple Claude homes (profiles / teams) — sibling `.claude-*` dirs

Claude Code reads its config dir from `CLAUDE_CONFIG_DIR`; unset, it defaults to
`~/.claude`. Parallel/team setups run with a **per-profile config dir that is a
sibling** of `~/.claude` — e.g. `~/.claude-andrena_team_5x` — so those sessions
land under `~/.claude-<suffix>/projects/…`, **invisible to any tool that hard-codes
`~/.claude/projects`**. If a session you know exists doesn't show up, this is almost
always why.

Every Claude-reading script now discovers **all** of these via
`claudeProjectDirs()` (`scripts/lib/config.mjs`), which returns, deduped:
1. `$CLAUDE_PROJECT_DIRS` — explicit `;`/`:`-separated list (bypasses discovery; use for a mounted/synced copy)
2. `$CLAUDE_CONFIG_DIR/projects` and `$CLAUDE_HOME/projects` — the active profile
3. `~/.claude/projects` **plus every `~/.claude-<suffix>` / `~/.claude_<suffix>` sibling home**

In `--list`, when more than one home exists the dir label is prefixed with the home
tag (`.claude-andrena_team_5x/C--projects-…`) so identically-named project dirs across
profiles stay distinguishable. Codex (`~/.codex`) and Copilot (`~/.copilot`) are
single-home and unaffected.

**Resolving a session by id is cross-profile by default — `--profile` is a
preference, never a filter.** Because rate limits force frequent mid-work profile
switches, a session id (or a `sessionId/projectDir` locator, in either order) is *usually* NOT under
your current profile. So `analyze-claude-session.mjs <id>` and `session-edit.mjs
--session <id>` **always search every sibling home** and resolve the (globally
unique) id wherever it lives; passing `--profile`/`--config-dir` only floats that
home's matches first. When a match resolves from a *different* profile than the one
named, both scripts print a one-line `ℹ … (profile switch)` note so the switch is
visible. Don't pre-`find` the `.jsonl` path or guess the profile — just pass the id.

## Directory naming convention (Claude)

Each working directory maps to a session dir by replacing path separators with `--`:
- `C:\andrena\.worktrees\feature_ak-17-...` → `C--andrena--worktrees-feature-ak-17-...`
- `C:\andrena\agentic-kanban\packages\.worktrees\feature_ak-N-...` → `C--andrena-agentic-kanban-packages--worktrees-feature-ak-N-...`

Multiple `.jsonl` files in one dir = multiple sessions (e.g. original run + re-launched review). Sort by `LastWriteTime` descending to find the latest.

Subagent transcripts live under `<session-dir>/<session-id>/subagents/agent-<id>.jsonl`
and are prefixed `agent-` — pass the full filename to the analyzer (dropping the prefix
gives ENOENT).

## Common stop_reason values and what they mean (Claude)

| stop_reason | Meaning |
|-------------|---------|
| `end_turn` | Agent finished normally — said what it wanted to say |
| `tool_use` | Agent was mid-execution of a tool call when session ended (interrupted or still running) |
| `stop_sequence` | A stop sequence triggered — often auth failure ("Invalid API key") or rate limit |
| `max_tokens` | Hit context/output token limit |
| *(absent)* | Session file has user prompt but no assistant entry — agent never responded |

## Tips

- **Never `Get-Content` a large JSONL without `-Tail`** — some files are 1-2MB+ and will flood the terminal.
- Each line is a self-contained JSON object; parse line-by-line with `ConvertFrom-Json -ErrorAction SilentlyContinue`.
- For **Claude sessions**: the `sessionId` field is on most entries and matches the filename (minus `.jsonl`). `ai-title`, `queue-operation`, `attachment` entries are metadata — only `user` and `assistant` entries carry content.
- For **Codex sessions**: every line wraps in `{ timestamp, type, payload }`. Use the `analyze-codex-session.mjs` script for structured summaries.
- For **Copilot sessions**: full transcripts in `~/.copilot/session-state/<uuid>/events.jsonl`. Use `analyze-copilot-session.mjs` for structured summaries.
- Sessions with 8 lines and no `assistant` entry = the process started but exited before Claude responded. Check for auth errors or process kills.
