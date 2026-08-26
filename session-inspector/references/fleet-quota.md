# Fleet: subscription quota — one profile, all profiles, a calendar range

_session-inspector reference — quota-report, quota-multi, quota-month; all share `lib/quota.mjs`. Commands run from the skill directory (`node scripts/…`); all take `--json`, `--days N`, `--project <substring>`._

`quota-report.mjs` answers **"what did my subscription do this billing week?"** —
it scopes to ONE profile (`--profile <name>` ⇒ `~/.claude-<name>`, or
`--config-dir <path>`) and, unlike `token-sinks.mjs` (which stat-filters whole
FILES by mtime), filters **per turn** by the turn's own timestamp, so a session
straddling the cutoff contributes only its post-cutoff turns. The default cutoff
is the profile's **last weekly reset**, which it **auto-detects per profile** —
different accounts anchor their weekly window on different weekday+times. It reads
the profile's own `"You've hit your weekly limit · resets …"` banners (the
`resets Jul 17, 12pm` / `resets 6am` forms), derives the reset weekday+clock in
Europe/Berlin, and steps back in 7-day multiples to the most recent boundary
at/before now (e.g. `andrena_team_5x` → Tue 6am, `andrena_team_5x_2` → Fri 12pm).
Override the cutoff with `--since <ISO>`, disable detection with
`--no-auto-reset` (falls back to Fri 12:00 Berlin), and set the UTC offset with
`--tz N` (default 2 = CEST). The detected schedule + the banner it came from are
shown in the dashboard's verification callout and in `meta.resetInfo`. **Subagent transcripts are
included** (`<session>/subagents/agent-*.jsonl`) because they hit the API and burn
the same quota. It reports totals (sessions, subagents, assistant turns, tool
calls + errors, tokens, est. USD "subscription value" at pay-go rates), and
breakdowns by model / project / day / hour-of-day (localized) / tool / top
sessions, plus a **usage-limit banner timeline** (collapsed to distinct messages
with a repeat count) that doubles as evidence for the reset window. `--json` for
the full blob; `--html <file>` writes a **self-contained, theme-aware dashboard**
(inline SVG charts, no external assets) you open locally. Cost model matches
`token-sinks.mjs`. Claude only. Example:
`node scripts/quota-report.mjs --profile andrena_team_5x_2 --html quota.html`.

`quota-multi.mjs` is the **"complete picture"** companion to `quota-report.mjs`:
one self-contained, switchable dashboard covering **every** `andrena_team_5x*`
profile (or `--profiles a,b,…`), **every weekly reset window per profile**, plus
a **Combined grand total** across all profiles. It parses each transcript ONCE
(shared core in `lib/quota.mjs` — pricing, per-turn event parse, banner scan,
`detectWeeklyReset`, `weeklyWindows`, `aggregate`) and slices each window in
memory. Per profile it auto-detects the weekly anchor and generates weekly
windows across that profile's data; profiles with **no weekly-limit banner yet**
(only 5-hour session limits) are honestly flagged "anchor unknown" and shown as a
single span. The **Combined** scope sums everything and breaks down **by profile**
(windows are per-profile because each account resets on a different weekday, so
Combined is a total, not a synchronized window). The HTML has a profile tab row
(each with its total value) + per-profile window chips (`Profile total` + one per
week); each view renders KPIs, token composition, value-by-day, hour-of-day, by
model/project(/profile), tool table, top sessions, and a usage-limit timeline.
`lib/quota.mjs` is the single source of truth for the accounting; reuse it for any
new cross-profile quota view. Example:
`node scripts/quota-multi.mjs --html quota-all.html`.

`quota-month.mjs` is the **calendar-range** view — "what did the team burn in the
whole of July?" Neither of the other two can answer that: `quota-report.mjs` takes
a single `--since` for ONE profile, and `quota-multi.mjs` slices by each account's
own weekly reset, so a month is smeared across windows that start on different
weekdays. This one takes an explicit wall-clock range (`--month 2026-07`, or
`--from`/`--to`; Berlin wall-clock, `--to` exclusive) and reports **all
`andrena_team_5x*` profiles combined + per profile** inside it. Same `lib/quota.mjs`
accounting, so the numbers reconcile with the other two views.

Range-specific behaviour worth knowing: days with no activity are **zero-filled**
so a quiet day reads as a gap rather than as missing data; the daily chart scales
to ~31 bars (weekends tinted, labels thinned, tooltips keep the detail); a
**week-by-week table** (Mon–Sun, clipped to the range) sits above the panels; KPIs
add **per-ACTIVE-day** next to per-calendar-day, which is the honest rate when the
month is half idle. Per-profile chips still follow that account's *own* billing
weeks, clipped to the range and marked `*` when the range cut them short. The
personal `~/.claude` profile is **never** read — team seats only.
`node scripts/quota-month.mjs --month 2026-07 --html quota-july-2026.html`.
