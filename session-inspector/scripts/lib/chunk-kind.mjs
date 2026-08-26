/**
 * Shared classification of CONTEXT CHUNKS for the fleet cost tools (waste.mjs,
 * context-spikes.mjs). Two facts these helpers encapsulate:
 *
 *  - A `type:"user"` text block is not necessarily something a human typed or pasted.
 *    The harness pushes skill bodies ("Base directory for this skill: …"), auto-compact
 *    summaries ("This session is being continued from a previous conversation…") and
 *    handoff briefs through the same channel. Measured on a 14-day kanban fleet they
 *    were 54% of all spike weight and used to be reported as "user-paste".
 *  - A Bash tool_use carries the whole command, not a file path, so a table keyed
 *    "by file" needs the FIRST FILE PATH pulled out of the command (else `bash:<verb>`).
 */

const SKILL_RE = /Base directory for this skill:[ \t]*([^\r\n]+)/;
const COMPACT_RE = /^\s*(?:This session is being continued from a previous conversation|<summary>)/;
const HANDOFF_RE = /taking over work from a session|handoff brief|continuation brief/i;

/** Classify a human-side text block. `kind` uses the waste.mjs spelling (snake_case). */
export function classifyHumanText(text, { pasteMinTok = 1200 } = {}) {
  const head = text.slice(0, 400);
  const m = head.match(SKILL_RE);
  if (m) {
    const skill = m[1].trim().split(/[\\/]+/).filter(Boolean).pop();
    return { kind: "skill_inject", where: "skill:" + skill, fix: "shrink the SKILL.md: short index + on-demand references (tokt skill)" };
  }
  if (COMPACT_RE.test(head))
    return { kind: "compaction", where: "compaction-summary", fix: "shorter sessions / hand off before auto-compact; keep the summary lean" };
  if (HANDOFF_RE.test(head))
    return { kind: "handoff_brief", where: "handoff-brief", fix: "keep the brief to load-bearing state; point at files instead of inlining" };
  if (text.startsWith("<")) return { kind: "harness_inject", where: "", fix: "" };
  const tok = Math.ceil(text.length / 4);
  return tok > pasteMinTok
    ? { kind: "user_paste", where: "", fix: "attach as a file / trim to the relevant part" }
    : { kind: "user_prompt", where: "", fix: "" };
}

const SHELL_KEYWORDS = new Set(["for", "while", "until", "if", "then", "else", "elif", "fi", "do", "done", "case", "esac",
  "export", "set", "local", "time", "sudo", "exec", "eval", "command", "builtin", "nohup", "env"]);
const SRC_EXT = /\.(m?[jt]sx?|cjs|py|rb|go|rs|java|kt|cs|php|md|json|ya?ml|toml|txt|csv|sql|sh|ps1|cmd|html?|css|scss|xml|ini|env|log)$/i;
const PATH_RE = /(?:^|[\s"'=(])((?:[A-Za-z]:)?(?:\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*[\w@-][\w.@-]*\.[A-Za-z]{1,8})(?=[\s"')|;]|$)/;

/** The verb a shell command is "about": first token that is not an assignment, an
 *  operator, a `cd x &&` prefix, loop/conditional scaffolding, or a shell keyword. */
export function bashVerb(cmd) {
  const flat = cmd.replace(/\s+/g, " ").replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, "")
    // drop `for x in …; do`, `while …; do`, `if …; then` so the loop BODY's verb wins,
    // not the loop variable or condition
    .replace(/\b(?:for\s+\w+\s+in\s+[^;]*;|(?:while|until)\s+[^;]*;|if\s+[^;]*;\s*then)\s*(?:do\s+)?/g, "");
  const tokens = flat.split(" ").filter((t) => t && !/^\$?\w+=/.test(t) && !/^[&|;(){}]+$/.test(t) && !SHELL_KEYWORDS.has(t.replace(/^.*[\\/]/, "")));
  return (tokens[0] || "?").replace(/^.*[\\/]/, "").slice(0, 24);
}

/** Key a tool_use by the FILE it concerns. Non-shell tools already carry a path/pattern. */
export function fileKey(toolName, where) {
  if (!where) return where;
  if (toolName !== "Bash" && toolName !== "PowerShell") return where;
  const cmd = where.replace(/\s+/g, " ");
  const m = cmd.match(PATH_RE);
  // a bare `name.ext` (no directory) only counts with a source/doc extension — otherwise
  // `sys.stdin` or `obj.method` inside an inline script would masquerade as a file
  if (m && (/[\\/]/.test(m[1]) || SRC_EXT.test(m[1]))) return m[1];
  return "bash:" + bashVerb(cmd);
}

/** Shorten a path for a fixed-width column WITHOUT losing the parts that identify it:
 *  the basename and its nearest ancestors (a worktree id like `ak-903` lives there).
 *  Drops the middle, keeps the root: `C:/…/ak-903/packages/server/x.ts`. */
export function shortPath(p, max = 60) {
  if (!p || p.length <= max) return p || "";
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 3) return "…" + p.slice(-(max - 1));
  const root = parts[0];
  let tail = parts[parts.length - 1];
  for (let i = parts.length - 2; i > 0; i--) {
    const cand = parts[i] + "/" + tail;
    if (root.length + 3 + cand.length > max) break;
    tail = cand;
  }
  const s = root + "/…/" + tail;
  return s.length <= max ? s : "…" + tail.slice(-(max - 1));
}

/** Pad a label into `w` columns, truncating from the LEFT (keep the tail) with an ellipsis. */
export function padTail(s, w) {
  s = String(s);
  return s.length <= w ? s.padEnd(w) : "…" + s.slice(-(w - 1));
}
