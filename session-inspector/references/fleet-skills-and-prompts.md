# Fleet: skills, reading style, prompting

_session-inspector reference — skill-usage (+ repo-scoped audit and --cost), skill-genesis, read-patterns, slash-goals, prompt-style, user-prompts. Commands run from the skill directory (`node scripts/…`); all take `--json`, `--days N`, `--project <substring>`._

`skill-usage.mjs` answers **"which of my agent skills never get triggered?"** —
it discovers every skill on disk (`~/.claude/skills`, `~/.codex/skills`,
`~/.copilot/skills`, and each repo's `.claude/.codex/skills` reached via session
cwds + `--project-dir`; plugins are opt-in via `--include-plugins`) and cross-
references each against every transcript. It separates a **strong** trigger (an
agent explicitly fired it: Claude `Skill` tool, a `/slash`, or a Copilot skill
field) from a **weak** one (the `SKILL.md` body was merely loaded/read — the only
signal Codex emits). This split matters because skill **materialization** inflates
weak counts: the kanban board copies its built-in skills into every worktree's
`.claude/skills`, so their path appears in thousands of sessions even though no
agent ever invokes them (those are server-triggered, not agent-triggered). The
report buckets skills into **dead** (never invoked but **was available**),
**too-new** (created after ~all scanned sessions — no fair chance to fire),
**loaded-only** (strong=0, present but never agent-invoked), and **agent-invoked**,
plus an orphan list of names triggered in logs with no SKILL.md on disk.
Availability is the fair denominator: a skill's `git` first-add date vs each
session's time gives `avail` = sessions that ran *after* it existed, so a skill
written last week isn't wrongly called dead. Board-independent (no DB). The
git-history pass only runs for never-strong-invoked skills; narrow with `--days`
for a fast windowed audit (`--no-git` skips creation-time entirely).

**Repo-scoped audit** — to answer "which of **this** repo's skills are dead weight
/ badly described?" rather than the fleet-wide question, add `--project <substr>`
(or `--cwd` for the current repo). It scopes **both** the session set **and** the
project-skill universe to that one repo — so a Rails app's audit no longer drags
in a sibling project's `.claude/skills`, and `avail` becomes "*this repo's*
sessions since the skill existed". Matching is separator-normalized, so
`--project webapp` hits both the hyphenated Claude session folder
(`C--…-webapp`) and the underscored repo path (`…\webapp`) — a mismatch that
otherwise silently discovers zero project skills. Add `--repo-only` to report just
the skills **defined in** the matched repo (dropping user-level globals) — the
exact *skills-in-repo × sessions-in-repo* intersection. The most actionable signal
this surfaces is **loaded-only** skills (weak>0, strong=0 over hundreds of matched
sessions): present and paying context tax, but no agent ever fired them — a sign
the skill is redundant *here* or its description doesn't match how work is framed
(e.g. webapp's generic `playwright-test-{planner,generator,healer}` never fire
because the repo's e2e flow goes through `e2e-coverage-lean`/`e2e-test-author`).
**Token tax** — add `--cost` to weight each dead/loaded-only skill by what it
actually costs, because a dead *small* skill is cheap and a dead *large* one is
real waste. It shells out to the `token-budget` skill's `tokt.js skill --json`
(one subprocess per reported skill; opt-in) and reports the progressive-disclosure
tiers the way an agent pays for them: **t0 = alwaysOn** (name+description, in the
system prompt *every turn of every session* whether or not the skill fires) and
**inv = onInvoke** (the SKILL.md body, loaded only when it triggers). The dead and
loaded-only buckets are then ranked by tax (`waste ≈ t0 × avail` — a per-session
lower bound on the always-on tokens paid while it never earned an invocation), and
a headline sums the always-on tax of all never-invoked skills. `tokt.js` is located
via `$TOKT_BIN`, the sibling `token-budget` skill (junctioned next to this one), or
the known repo/profile paths; if none exist, `--cost` degrades to a one-line notice
and the rest of the audit runs unchanged.

`skill-genesis.mjs` answers **"how do skills actually get born and improved on
this machine?"** — a different question from `skill-usage.mjs` (does a skill
ever fire) and `tool-friction.mjs` (which command chains repeat): of the
sessions that touched a `SKILL.md` (Write = looks like genesis; Edit to it or
to its `scripts/`/`references/`/`tools/`/`src/` = improvement), what shape was
the human interaction that led there? It classifies each into **same-prompt**
(the first human message asks for a thing AND asks for a skill/CLI wrapping it,
in one breath — the highest-leverage shape, often naming a sibling skill as the
template), **interactive-then-ask** (a task got done first — several tool
calls — and only *later* in the session did a human message ask to turn it
into a skill), **lab-driven** (the session invoked a `*-lab` companion
meta-skill whose job is to improve another skill), and **compounding** (the
first message explicitly references a prior session/skill — "continue",
"extend the X skill", "as we did before"). A session can match more than one
shape. Cheap-prefiltered (skips any transcript never mentioning `skills/`)
before the full parse, so a multi-thousand-session fleet scan stays fast.
Narrow with `--project <substr>` (repo scope) or `--skill <name>` (only
sessions touching one named skill); `--examples N` prints more than the
default 3 real snippets per shape. Pairs with `tooling-improvement.md`'s
detect→validate→prototype loop — this is the "detect" step for the *skill
authoring* pattern specifically, one level up from command-chain friction.

`read-patterns.mjs` answers **"how do agents actually read files, and does progressive
disclosure keep up?"** — Claude Code auto-loads a nested `CLAUDE.md` and a path-scoped
`.claude/rules/*.md` only when a file in that subtree is touched through **Read/Edit/Write**.
Newer models read search-first: the built-in Grep/Glob tools and shell readers (`cat`,
`sed -n`, `grep`, `rg`, `head`, `Get-Content`) touch the same files and trigger **nothing**.
The script measures both halves per model: read style (Read full vs partial `offset`/`limit`,
Grep/Glob counts, shell calls carrying a read verb, a search-first ratio) and the disclosure gap
per (session × guidance dir): which tool touched the dir first, whether Claude Code's own
`nested_memory` attachment ever arrived, and — when the first touch was indirect but a Read
came later — how many tool calls the agent worked in that subtree *before* its guidance landed.
Guidance dirs are discovered from the session cwd on disk plus every `nested_memory` path seen in
the corpus, so it is not tied to any one repo layout. Measured on 237 kanban builder sessions
(Sonnet 5, 90 days): 33% of Reads partial, search-first ratio 0.65, **15 of 148 guided-subtree
touches (10%) never received their CLAUDE.md — every one of them was a Grep/shell-only touch (0
of 15 injected)**; where a Read followed, the median lag was 1 call but p90 9 and max 16. The
closing mechanism is a PostToolUse hook on `Bash|Grep|Glob` that resolves the touched paths to
nested CLAUDE.md + matching rules and injects them as `additionalContext` — reference
implementation and a `claude -p` A/B eval in `C:projectsandrenacontext-disclosure-hook`.
Claude only.

`slash-goals.mjs` answers **"what was the agent asked to do, and how?"** — per
session it surfaces the **goal** (custom title → ai-title → slug → first typed
prompt, sorted by turns so marathon sessions lead), the **slash commands** the
human invoked (flagging session-hygiene ones — `/clear`, `/compact`, `/model` —
whose *absence* explains runaway context), and the **skill invocations** the
agent fired. Goals give intent, slash gives hygiene, skills give mechanism
(a brainstorming → writing-plans → subagent-driven-development workflow
front-loads big design docs and spawns result-dumping Agents — often the *cause*
of the growth `context-growth.mjs` measures). Claude only.

`prompt-style.mjs` answers "how do I talk to the agent?" — it aggregates every
real human prompt into a length distribution, tone/format signals (lowercase
start %, question %, terse one-liners %, approval-only %, German/umlaut %, …),
opening-word frequencies, and representative samples. Scope it with
`--project <substr>` (matches the Claude projects-dir folder, the session cwd,
or the git remote), `--provider`, and `--days N`; run bare for an all-time,
all-projects profile (with a busiest-projects breakdown). It shares the
human-vs-noise `classify()` filter with `user-prompts.mjs` (both live in
`scripts/lib/prompts.mjs`), so the two tools always agree on what a prompt is.

`user-prompts.mjs` LISTS the real human-typed prompts for a day or window (`--date`, `--today`, `--days N`, `--tree`); `prompt-style.mjs` CHARACTERIZES them. Both share `lib/prompts.mjs`' `classify()`. Full usage in `aggregate-tools.md`.
