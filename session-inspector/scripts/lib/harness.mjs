/**
 * What each agent's transcript actually carries, and which tool needs what.
 *
 * Two readers, and that is the point of stating it as data:
 *
 *   - tools, to refuse honestly. `refuse(tool, provider)` prints ONE line naming the
 *     missing fact and its reason, and exits 3. A tool that cannot answer for an agent
 *     must say so — printing a zero (no cache, no cost, no subagents) is the same
 *     failure as a fleet number quoted without its population, which lib/reach.mjs exists
 *     to prevent.
 *   - docs/agent-feature-matrix.md, which is GENERATED from here by
 *     scripts/harness-matrix.mjs and pinned by test/harness.test.mjs. The matrix used to
 *     be read off the scripts by hand and carried a "re-check a cell before relying on
 *     it" warning; a generated one cannot disagree with the code.
 *
 * FACTS are properties of the TRANSCRIPT, never of a tool: "does this agent record
 * per-call usage", not "does token-sinks support codex". A fact is `true`, or a string
 * saying why it is absent — the string is what a refusal prints, so it is written for
 * someone who just got told no.
 *
 * Adding an agent = a HARNESS entry + a column in the generated matrix. Adding a tool =
 * a TOOLS row. Neither touches the tools that already run.
 */

/** The facts, in the order the matrix legend explains them. */
export const FACTS = {
  transcripts: "a transcript on disk that lib/sessions.mjs discovers",
  events: "prompts, replies and tool calls in a parseable order",
  perCallUsage: "token usage per API call",
  cacheRead: "cache-read (or cached-input) tokens per call",
  cacheWrite: "cache-write tokens, split by TTL",
  growingOutput: "output_tokens that grow across the rows of one call",
  pricing: "a model id and token split this skill prices in dollars",
  toolIo: "tool calls with their file paths and result sizes",
  toolErrors: "failed tool calls, marked as failures",
  subagents: "nested subagent transcripts beside the session",
  skills: "skill invocations visible in the transcript",
  slashCommands: "slash commands and their expansion",
  hooks: "hook executions with their latency",
  compaction: "compaction/summary boundaries in the transcript",
  limitSignals: "why the session stopped (limit, stop_reason)",
  handoffArtifacts: "background jobs, monitors and scratchpad state left running",
  sessionRegistry: "a live registry of running sessions",
  rateLimits: "subscription rate-limit windows",
};

const ALL = Object.keys(FACTS);
const yes = (keys) => Object.fromEntries(keys.map((k) => [k, true]));

/**
 * Claude Code is the reference implementation: every fact is true there, which is why
 * the tools are Claude-shaped and why a second agent is cheapest to add by naming what
 * it LACKS rather than by re-deriving what it has.
 */
export const HARNESS = {
  claude: {
    label: "Claude Code",
    layout: "~/.claude*/projects/<slug>/<id>.jsonl, subagents in <id>/subagents/",
    facts: yes(ALL),
  },
  codex: {
    label: "Codex",
    layout: "~/.codex/sessions/YYYY/MM/DD/<file>.jsonl (plus CODEX_HOME, CODEX_HOMES)",
    facts: {
      ...yes(["transcripts", "events", "perCallUsage", "cacheRead", "toolErrors", "skills", "rateLimits"]),
      cacheWrite: "a rollout's token_count event reports cached input, not a write or a TTL split",
      growingOutput: "one usage event per call, not one row per content block",
      pricing: "rollouts carry no cost, and the gateway that served them prices elsewhere",
      toolIo: "tool output is text inside function_call_output, without the path and size shape these tools read",
      subagents: "Codex runs no nested sessions",
      slashCommands: "Codex has no slash-command layer in the rollout",
      hooks: "Codex has no hooks",
      compaction: "a rollout records no compaction boundary",
      limitSignals: "a rollout records no stop_reason",
      handoffArtifacts: "background jobs and monitors are a Claude Code layer",
      sessionRegistry: "no per-pid registry is written",
    },
  },
  copilot: {
    label: "Copilot",
    layout: "~/.copilot/session-state/<uuid>/events.jsonl",
    facts: {
      ...yes(["transcripts", "events", "toolErrors", "skills"]),
      perCallUsage: "Copilot writes no usage records at all",
      cacheRead: "no usage records",
      cacheWrite: "no usage records",
      growingOutput: "no usage records",
      pricing: "no usage records",
      toolIo: "tool results are summarised, without sizes",
      subagents: "Copilot runs no nested sessions",
      slashCommands: "not in the event stream",
      hooks: "Copilot has no hooks",
      compaction: "no compaction boundary is recorded",
      limitSignals: "no stop reason is recorded",
      handoffArtifacts: "a Claude Code layer",
      sessionRegistry: "no registry is written",
      rateLimits: "no rate-limit window is recorded",
    },
  },
};

/** Read by cache-health only, and deliberately not a matrix column while that holds. */
export const EXTRA_STORES = {
  opencode: "the OpenCode SQLite store (`cache-health --agent opencode`, Node 22.5+)",
};

export const PROVIDERS = Object.keys(HARNESS);

/**
 * Tools, what each needs from a transcript, and which agents it is WIRED for today.
 *
 * `needs` decides whether a tool COULD work; `wired` says whether anyone built it.
 * The difference is the honest half of the matrix: a `cand` cell is work nobody has
 * asked for, not a limitation of the agent. Build one when that agent has sessions and
 * someone asks the question — symmetry is not a reason.
 */
export const TOOLS = [
  // --- one session -------------------------------------------------------------
  { tool: "analyze-<agent>-session", section: "one", needs: ["events"], wired: ["claude", "codex", "copilot"], note: "one analyzer per agent; --events and --friction are the same parser" },
  { tool: "… --handoff", section: "one", needs: ["handoffArtifacts"], wired: ["claude"] },
  { tool: "subagent-results", section: "one", needs: ["subagents"], wired: ["claude"] },
  { tool: "verify-runs", section: "one", needs: ["toolIo"], wired: ["claude"] },
  { tool: "message-stats", section: "one", needs: ["perCallUsage"], wired: ["claude"] },
  { tool: "session-dashboard", section: "one", needs: ["perCallUsage", "toolIo"], wired: ["claude"] },
  { tool: "session-dashboard --lens cost", section: "one", needs: ["pricing", "cacheWrite", "compaction"], wired: ["claude"], note: "prices the prefix, the carry and the subagents" },
  { tool: "session-edit", section: "one", needs: ["events"], wired: ["claude"], note: "editing a rollout has never been asked for" },
  { tool: "session-compact", section: "one", needs: ["toolIo", "compaction"], wired: ["claude"] },
  { tool: "resumable, session-resume", section: "one", needs: ["limitSignals"], wired: ["claude"] },
  { tool: "brief", section: "one", needs: ["events"], wired: ["claude", "codex", "copilot"], note: "--for codex|claude" },
  { tool: "cache-health --session", section: "one", needs: ["cacheRead"], wired: ["claude", "codex"] },

  // --- fleet -------------------------------------------------------------------
  { tool: "token-sinks", section: "fleet", needs: ["perCallUsage"], wired: ["claude", "codex"], note: "Codex counted, not costed (no `pricing`)" },
  { tool: "tool-failures", section: "fleet", needs: ["toolErrors"], wired: ["claude", "codex"] },
  { tool: "user-prompts", section: "fleet", needs: ["events"], wired: ["claude", "codex"] },
  { tool: "incidents, tool-friction, prompt-style", section: "fleet", needs: ["events"], wired: ["claude", "codex", "copilot"] },
  { tool: "skill-usage", section: "fleet", needs: ["skills"], wired: ["claude", "codex", "copilot"] },
  { tool: "cache-health --days", section: "fleet", needs: ["cacheRead"], wired: ["claude", "codex"] },
  { tool: "fleet-stats", section: "fleet", needs: ["perCallUsage", "cacheRead"], wired: ["claude"], note: "Codex token_count events carry cached tokens since 2026-09-18, so it is buildable" },
  { tool: "context-growth", section: "fleet", needs: ["cacheRead", "compaction"], wired: ["claude"] },
  { tool: "cold-cache", section: "fleet", needs: ["cacheRead", "cacheWrite"], wired: ["claude"], note: "needs the write to price a re-warm" },
  { tool: "waste, context-spikes, reread-causes, read-patterns", section: "fleet", needs: ["toolIo"], wired: ["claude"] },
  { tool: "hook-cost", section: "fleet", needs: ["hooks"], wired: ["claude"] },
  { tool: "slash-goals", section: "fleet", needs: ["slashCommands"], wired: ["claude"] },
  { tool: "skill-genesis", section: "fleet", needs: ["skills", "toolIo"], wired: ["claude"] },
  { tool: "quota-report, quota-multi, quota-month", section: "fleet", needs: ["rateLimits"], wired: ["claude"], note: "Codex rollouts carry rate_limits; worth building if a Codex limit starts to bind" },
  { tool: "live, continuations", section: "fleet", needs: ["sessionRegistry"], wired: ["claude"] },
  { tool: "sync-*, session-bundle, hub-service", section: "fleet", needs: ["transcripts"], wired: ["claude", "codex", "copilot"] },
];

export const SECTIONS = { one: "One session", fleet: "Fleet" };

/** The facts `tool` needs that `provider` does not have, each with its reason. */
export function missing(tool, provider) {
  const h = HARNESS[provider];
  if (!h) return [{ fact: "transcripts", why: `unknown agent "${provider}"` }];
  const row = TOOLS.find((t) => t.tool === tool);
  const needs = row ? row.needs : [];
  return needs.filter((f) => h.facts[f] !== true).map((f) => ({ fact: f, why: String(h.facts[f] ?? "not recorded") }));
}

/**
 * One cell of the matrix: `y` wired, `cand` buildable and unbuilt, `n/a` the agent has
 * no such data. A tool wired for an agent whose data is missing is a bug, not a cell —
 * the generator refuses rather than printing it.
 */
export function cell(tool, provider) {
  const row = TOOLS.find((t) => t.tool === tool);
  if (!row) throw new Error(`no such tool in the matrix: ${tool}`);
  const gaps = missing(tool, provider);
  const wired = row.wired.includes(provider);
  if (gaps.length && wired) throw new Error(`${tool} claims ${provider} but needs ${gaps.map((g) => g.fact).join(", ")}`);
  if (gaps.length) return { state: "n/a", why: gaps[0].why };
  return { state: wired ? "y" : "cand", why: wired ? "" : "buildable; nobody has asked" };
}

/** The line a tool prints before exiting when it cannot answer for this agent. */
export function refusal(tool, provider) {
  const gaps = missing(tool, provider);
  if (!gaps.length) return null;
  const h = HARNESS[provider];
  const g = gaps[0];
  return `${tool} cannot run on ${h ? h.label : provider}: it needs ${FACTS[g.fact] || g.fact} — ${g.why}.`;
}

/**
 * Tell lib/reach.mjs which agents this tool did not read, and why. A Claude-only tool
 * calls this once after reach.begin(); its reach line then says so, instead of looking
 * identical to a box where the other agents simply have no sessions.
 */
export function declareUnsupported(tool, reachObj) {
  for (const p of PROVIDERS) {
    const gaps = missing(tool, p);
    if (gaps.length) reachObj.unsupported(p, FACTS[gaps[0].fact] + " — " + gaps[0].why);
  }
}

/**
 * Refuse loudly, in the one place a tool would otherwise print zeros. Exit 3 is
 * "this question does not apply here", distinct from 2 (bad arguments).
 */
export function refuse(tool, provider) {
  const line = refusal(tool, provider);
  if (!line) return false;
  console.error(line);
  process.exit(3);
}
