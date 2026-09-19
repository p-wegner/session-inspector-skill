/**
 * turns.mjs — a per-event view of ONE Claude transcript.
 *
 * `parse.mjs` answers "what happened in this session" as totals. This one keeps
 * the CHRONOLOGY and the SIZES, which is what the shape questions need:
 *
 *   • how long was each assistant message (histogram, not a mean)
 *   • how big was each tool result (verbose test output is the suspect)
 *   • when did verification actually run, relative to the writing
 *   • which git branch / which skill was active at the time
 *
 * It deliberately keeps no full text beyond a short excerpt: a 6 MB transcript
 * must fold into something a dashboard can embed.
 *
 * Token figures here are ESTIMATES from character counts (chars/4) — a transcript
 * carries per-API-call usage, not per-block usage, so the only honest way to say
 * "this tool result cost N tokens" is to estimate it. Every consumer labels them
 * `~`. The per-call usage totals (apiCalls below) are exact and come from the same
 * first-row-only rule as lib/usage.mjs.
 *
 * Node builtins only.
 */

import { createHash } from "crypto";
import { firstRowOf, lateOutput } from "./usage.mjs";
import { classify } from "./prompts.mjs";
import { toolDisplayName } from "./parse.mjs";
import { reach } from "./reach.mjs";

/** Rough token estimate from characters. Stated as `~` wherever it is printed. */
export const estTokens = (chars) => Math.round((chars || 0) / 4);

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("\n");
  return content == null ? "" : String(content);
};

/**
 * Parse a Claude .jsonl into ordered events plus a joined tool-call table.
 *
 * Returns:
 *   meta      { sessionId, cwd, model, startTime, endTime, durationSec, version }
 *   events    [{ seq, ts, kind, ... }]  kind: user | assistant_text | thinking |
 *             tool_use | tool_result | compaction
 *   calls     [{ seq, ts, id, tool, command, input, branch, skill, ok, resultChars,
 *               resultLines, durationSec, excerpt }]  — tool_use joined to its result
 *   apiCalls  [{ ts, input, output, cacheRead, cacheCreate, cacheCreate1h, ctx, model }]
 *             (exact usage, deduped)
 */
export function claudeTurns(lines) {
  const meta = { sessionId: "", cwd: "", model: "", startTime: "", endTime: "", durationSec: 0, version: "" };
  const events = [];
  const apiCalls = [];
  const callById = new Map();
  const calls = [];
  const seenUsage = new Set();
  const apiById = new Map();
  let seq = 0;
  let branch = "";
  let skill = ""; // most recent Skill: tool_use — the phase an event belongs to

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { reach.badLine(); continue; }

    if (obj.timestamp) { if (!meta.startTime) meta.startTime = obj.timestamp; meta.endTime = obj.timestamp; }
    if (obj.sessionId && !meta.sessionId) meta.sessionId = obj.sessionId;
    if (obj.cwd && !meta.cwd) meta.cwd = obj.cwd;
    if (obj.version) meta.version = obj.version;
    if (obj.gitBranch) branch = obj.gitBranch;
    if (obj.isCompactSummary) events.push({ seq: seq++, ts: obj.timestamp, kind: "compaction", branch, skill });

    const msg = obj.message;
    if (!msg) continue;

    if (obj.type === "assistant") {
      if (msg.model && msg.model !== "<synthetic>") meta.model = msg.model;
      const u = msg.usage;
      if (u && !firstRowOf(msg, seenUsage)) {
        // repeat row: only output can have grown (a subagent's streaming snapshots)
        const rec = apiById.get(msg.id);
        if (rec) rec.output += lateOutput(msg, seenUsage);
      } else if (u) {
        apiCalls.push({
          ts: obj.timestamp,
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreate: u.cache_creation_input_tokens || 0,
          cacheCreate1h: u.cache_creation?.ephemeral_1h_input_tokens || 0,
          ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0),
          model: msg.model || "",
          branch, skill,
        });
        if (msg.id) apiById.set(msg.id, apiCalls[apiCalls.length - 1]);
      }
      for (const block of msg.content || []) {
        if (block.type === "text" && block.text) {
          events.push({
            seq: seq++, ts: obj.timestamp, kind: "assistant_text", branch, skill,
            chars: block.text.length, tokens: estTokens(block.text.length),
            excerpt: block.text.slice(0, 160),
          });
        } else if (block.type === "thinking" && block.thinking) {
          events.push({
            seq: seq++, ts: obj.timestamp, kind: "thinking", branch, skill,
            chars: block.thinking.length, tokens: estTokens(block.thinking.length),
          });
        } else if (block.type === "tool_use") {
          const tool = toolDisplayName(block.name, block.input);
          if (tool.startsWith("Skill:")) skill = tool.slice(6);
          const command = typeof block.input?.command === "string" ? block.input.command
            : typeof block.input?.script === "string" ? block.input.script : "";
          const call = {
            seq: seq++, ts: obj.timestamp, id: block.id, tool, command,
            filePath: block.input?.file_path || block.input?.notebook_path || "",
            description: block.input?.description || "",
            inputChars: JSON.stringify(block.input || {}).length,
            // a Read's view: the same file at another offset is pagination, not a re-read
            range: block.name === "Read" ? `${block.input?.offset ?? ""}:${block.input?.limit ?? ""}` : "",
            branch, skill,
            ok: null, resultChars: 0, resultLines: 0, durationSec: null, excerpt: "",
          };
          callById.set(block.id, call);
          calls.push(call);
          events.push({ seq: call.seq, ts: obj.timestamp, kind: "tool_use", tool, command, branch, skill, id: block.id });
        }
      }
    } else if (obj.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        events.push({
          seq: seq++, ts: obj.timestamp, kind: "user", branch, skill,
          chars: content.length, tokens: estTokens(content.length),
          interrupt: /\[Request interrupted by user/.test(content),
          role: classify(content)?.kind || "noise",
          excerpt: content.slice(0, 160),
        });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const txt = textOf(block.content);
            const call = callById.get(block.tool_use_id);
            const ev = {
              seq: seq++, ts: obj.timestamp, kind: "tool_result", branch, skill,
              id: block.tool_use_id, tool: call?.tool || "",
              chars: txt.length, tokens: estTokens(txt.length),
              lines: txt ? txt.split("\n").length : 0,
              isError: !!block.is_error,
            };
            events.push(ev);
            if (call) {
              call.ok = !block.is_error;
              call.resultChars = txt.length;
              call.resultLines = ev.lines;
              call.excerpt = txt.slice(0, 200);
              // identity of the full result, so a repeat can be found without keeping the text
              call.hash = txt.length > 200 ? createHash("sha1").update(txt).digest("hex").slice(0, 16) : "";
              if (call.ts && obj.timestamp) call.durationSec = Math.round((new Date(obj.timestamp) - new Date(call.ts)) / 1000);
            }
          } else if (block.type === "text" && block.text) {
            events.push({
              seq: seq++, ts: obj.timestamp, kind: "user", branch, skill,
              chars: block.text.length, tokens: estTokens(block.text.length),
              role: classify(block.text)?.kind || "noise",
              excerpt: block.text.slice(0, 160),
            });
          }
        }
      }
    }
  }

  if (meta.startTime && meta.endTime)
    meta.durationSec = Math.round((new Date(meta.endTime) - new Date(meta.startTime)) / 1000);
  return { meta, events, calls, apiCalls };
}

// ── command classification ───────────────────────────────────────────────────
//
// What a shell command was FOR. Two things make this harder than a regex over the
// whole string, and both produced wrong answers before they were handled:
//
//   1. HEREDOC BODIES. `cat > package.json <<'EOF' … "test": "vitest run" … EOF`
//      mentions vitest, so a naive match reports a test run six minutes before the
//      first test actually ran — and "when did it first verify" is the headline
//      number this tool exists to give.
//   2. COMPOUND COMMANDS. Agents chain `sed -i …; tsc --noEmit; vitest run` into one
//      call. One command is genuinely several actions, so it gets a SET of
//      categories, and the primary is the most load-bearing of them.
//
// So: strip heredoc bodies, split on the shell's own separators, strip the
// leading noise (`cd …`, `timeout 120`, `npx`, env assignments), and classify each
// segment. Everything that fits no rule is `other` rather than being forced into a
// bucket that would later be quoted as a finding.

const RULES = [
  ["test", /\b(vitest|jest|pytest|mocha|ava|playwright\s+test|npx?\s+tap|go\s+test|cargo\s+test|gradle(w)?\s+\S*test|mvn\s+\S*test|dotnet\s+test|rspec|phpunit|node\s+--test|node:test)\b|\bnpm\s+(run\s+)?test\b|\b(pnpm|yarn|bun)\s+(run\s+)?test\b/i],
  ["typecheck", /\btsc\b|\bmypy\b|\bpyright\b|\btype-?check\b|\bnpm\s+run\s+typecheck\b/i],
  ["lint", /\beslint\b|\bruff\b|\bflake8\b|\bclippy\b|\bktlint\b|\bdetekt\b|\bnpm\s+run\s+lint\b/i],
  ["format", /\bprettier\b|\bblack\b|\bgofmt\b|\bnpm\s+run\s+format\b/i],
  ["build", /\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\bwebpack\b|\bvite\s+build\b|\bgradle(w)?\s+build\b|\bmvn\s+package\b|\bcargo\s+build\b|\bdotnet\s+build\b/i],
  ["run-app", /\bnode\s+(dist|src|bin|\.\/)|\btsx\s+|\bnpx\s+tsx\b|\bpython\s+-m\s+\w/i],
  ["install", /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip\s+install\b|\buv\s+(add|pip)\b/i],
  ["git", /^\s*(cd\s+\S+\s*(;|&&)\s*)?git\b|\bgit\s+(status|add|commit|checkout|merge|log|diff|branch|switch)\b/i],
  ["speckit-script", /\.specify[\/\\]scripts|specify\s+(init|check|artifact)/i],
  // `write` is tested BEFORE `inspect`: `cat > f <<EOF` is a write, and the inspect
  // rule would otherwise claim it on the leading `cat`.
  ["write", /^\s*(python\s+-\s*<<|cat\s*>|printf\s+[^|]*>|echo\s+[^|]*>|Set-Content\b|Out-File\b|tee\b)/i],
  ["inspect", /^\s*(cat|head|tail|sed\s+-n|ls|dir|find|grep|rg|wc|Get-Content|Get-ChildItem|Select-String)\b/i],
];

/** The categories that count as "the agent checked its own work". */
export const VERIFY_CATEGORIES = new Set(["test", "typecheck", "lint", "build"]);

// Primary-category preference when one command does several things: a call that
// edits a file and then runs the suite is, for this tool's purpose, a test run.
const PRIORITY = ["test", "typecheck", "lint", "build", "run-app", "install", "speckit-script", "format", "git", "write", "inspect", "other"];

/** Remove heredoc bodies so their contents cannot be mistaken for commands. */
export function stripHeredocs(cmd) {
  let s = String(cmd || "");
  // `<<'TAG'` / `<<"TAG"` / `<<TAG` … up to a line that is just TAG
  const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm;
  s = s.replace(re, "<<HEREDOC");
  // An unterminated heredoc (truncated command) — drop everything after it.
  s = s.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*$/m, "<<HEREDOC");
  return s;
}

/**
 * Blank out quoted string literals. A commit message, a `grep` pattern or a
 * `Where-Object CommandLine -match 'vitest'` capacity probe all mention build
 * tools without running them — measured: the machine-capacity check that greps
 * the process table for `vitest` was counted as a test run, 9 minutes before the
 * first real one. The cost of this is a command whose real work is inside a
 * quoted `-c "…"`, which is rarer than the false positives it removes.
 */
export function stripQuoted(cmd) {
  return String(cmd || "").replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** Split a command line into the segments the shell would run separately. */
export function commandSegments(cmd) {
  return stripQuoted(stripHeredocs(cmd))
    .split(/\s*(?:\|\||&&|[;|\n])\s*/)
    .map((s) => s
      .replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "")   // env assignments
      .replace(/^\s*(?:cd\s+\S+\s*)/, "")                       // cd prefix
      .replace(/^\s*(?:timeout\s+\d+\s+|sudo\s+|&\s+)/, "")      // timeout / sudo / PS call operator
      .trim())
    .filter(Boolean);
}

/** Every category a command touches, most load-bearing first. */
export function commandCategories(cmd) {
  const found = new Set();
  for (const seg of commandSegments(cmd)) {
    for (const [name, re] of RULES) if (re.test(seg)) { found.add(name); break; }
  }
  if (!found.size) return ["other"];
  return PRIORITY.filter((p) => found.has(p));
}

/** The single category a command is best described by (`other` if none fit). */
export function classifyCommand(cmd) {
  return commandCategories(cmd)[0];
}

// ── small stats helpers ──────────────────────────────────────────────────────

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, sum: 0, min: 0, max: 0, mean: 0, median: 0, p90: 0, p99: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))];
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length, sum, min: v[0], max: v[v.length - 1],
    mean: Math.round(sum / v.length), median: q(0.5), p90: q(0.9), p99: q(0.99),
  };
}

/** Log-ish buckets, because message lengths span three orders of magnitude. */
export const DEFAULT_BUCKETS = [0, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, Infinity];

export function histogram(values, edges = DEFAULT_BUCKETS) {
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) bins.push({ lo: edges[i], hi: edges[i + 1], count: 0, sum: 0 });
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    for (const b of bins) if (v >= b.lo && v < b.hi) { b.count++; b.sum += v; break; }
  }
  return bins;
}

export function renderHistogram(bins, { width = 40, unit = "" } = {}) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  const label = (b) => `${fmtN(b.lo)}–${b.hi === Infinity ? "∞" : fmtN(b.hi)}`;
  const w = Math.max(...bins.map((b) => label(b).length));
  return bins
    .filter((b) => b.count)
    .map((b) => `  ${label(b).padStart(w)}${unit}  ${"█".repeat(Math.max(1, Math.round((b.count / max) * width))).padEnd(width)} ${String(b.count).padStart(4)}`)
    .join("\n");
}

export function fmtN(n) {
  if (n === Infinity) return "∞";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
