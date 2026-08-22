/**
 * WHO started this session — the question every "which sessions should we pick
 * up?" tool needs and none of them had. A fleet of 95 recent transcripts is not
 * 95 candidates: most are board-launched ticket agents, handoff-seeded
 * continuations, or stop-hook drivers, and only a handful were a human sitting
 * down to work. Before this lib each caller open-coded a cwd regex
 * (`/worktrees/`) and got a different answer.
 *
 * Companion to `classify()` in prompts.mjs, which answers the narrower question
 * "is this ONE user entry human-typed?". This answers "what KIND of session is
 * this?" over the whole prompt sequence.
 *
 * Node builtins only.
 */
import { extractClaudePrompts } from "./prompts.mjs";

// Ordered most-specific first: the first matcher that fires on the opening
// prompts wins. Order matters — a board builder's prompt also carries a handoff
// block, and a stop-hook session's LAST prompt is hook feedback while its FIRST
// is the goal, so "board" must outrank both.
const SIGNATURES = [
  {
    kind: "board", label: "board-launched",
    test: (t) => /^\[PRE-COMPUTED CONTEXT/m.test(t)
      || /^You are an AI code reviewer/.test(t)
      || /stage of this issue's workflow/.test(t)
      || /^Architecture Improvement \(/.test(t),
  },
  {
    kind: "monitor", label: "board monitor",
    test: (t) => /^You are the autonomous BOARD MONITOR/.test(t),
  },
  {
    kind: "handoff", label: "handoff-seeded",
    test: (t) => /^You are TAKING OVER work from another Claude session/.test(t)
      || /Read the handoff brief at /.test(t)
      || /^\[SESSION HANDOFF/.test(t),
  },
  {
    kind: "stop-hook", label: "stop-hook driven",
    test: (t) => /^A session-scoped Stop hook is now active/.test(t),
  },
  {
    kind: "skill", label: "skill/slash invocation",
    test: (t) => /^Base directory for this skill:/.test(t),
  },
];

/**
 * A worktree cwd is strong evidence of an agent workspace rather than a human's
 * checkout, and it survives a transcript whose prompts look ordinary.
 */
export function isAgentWorkspace(cwd) {
  const p = String(cwd || "").replace(/\\/g, "/").toLowerCase();
  return /\/\.?worktrees\//.test(p);
}

/**
 * Classify a session from its transcript content.
 *
 * @returns {{kind, label, humanDriven, humanPrompts, firstHuman, lastHuman, signals}}
 *   kind          board | monitor | handoff | stop-hook | skill | human | empty
 *   humanDriven   did a person steer this beyond the seed? The signal that
 *                 matters for "is this session worth a human picking up".
 *   humanPrompts  count of genuinely human-typed prompts (classify() kind=human)
 */
export function classifyProvenance(content, cwd = "") {
  const prompts = extractClaudePrompts(content);
  const human = prompts.filter((p) => p.kind === "human");
  const opening = prompts.slice(0, 3).map((p) => p.text).join("\n");

  let kind = "human";
  let label = "human-driven";
  const signals = [];
  for (const sig of SIGNATURES) {
    if (!sig.test(opening)) continue;
    signals.push(sig.kind);
    if (kind === "human") { kind = sig.kind; label = sig.label; }
  }
  if (isAgentWorkspace(cwd)) {
    signals.push("agent-workspace");
    // A worktree session with no other signature is still an agent workspace,
    // not someone's own checkout.
    if (kind === "human") { kind = "board"; label = "agent workspace"; }
  }
  if (!prompts.length) { kind = "empty"; label = "no prompts"; }

  // "Human-driven" is deliberately generous about HOW it started: a session
  // seeded by a handoff or opened by a slash command is still a person's as soon
  // as they type anything of their own. A board agent never qualifies — every
  // prompt it gets is machine-authored.
  const seedIsHuman = kind === "human" || kind === "skill";
  const humanDriven = kind !== "board" && kind !== "monitor" && kind !== "empty"
    && (seedIsHuman || human.length > 0);

  return {
    kind, label, signals, humanDriven,
    humanPrompts: human.length,
    firstHuman: human[0]?.text || "",
    lastHuman: human[human.length - 1]?.text || "",
  };
}
