/**
 * summarize.mjs — Claude Code's OWN compaction, run headlessly on a transcript copy under a
 * cheap profile: `claude -p --resume <copy> "/compact"` with `--model` and `--settings` of the
 * caller's choosing. Claude Code writes a `compact_boundary` system line and a summary user line
 * (`isCompactSummary`) into the copy, and a later `--resume` of the copy — on any settings profile,
 * any model — starts from that summary. That is the "compact on the cheap model, continue on the
 * strong one" pattern with no prompt engineering of our own.
 *
 * Measured 2026-09-19 (Claude Code 2.1.278, haiku): a 34-call copy compacted for $0.03,
 * `preTokens: 103821` in the boundary's metadata.
 *
 * The copy must live in the account the call runs under: `--resume` resolves the id against
 * `CLAUDE_CONFIG_DIR`, so `configDir` is the copy's OWN home (derived from its path), and only the
 * settings profile and the model are free. Slash commands survive `execFileSync` — a POSIX shell
 * (Git Bash) would rewrite "/compact" into a path.
 *
 * Node builtins only; the runner is injectable for tests.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, basename, sep } from "path";

/** The profile home a transcript path belongs to: the parent of its `projects` segment. */
export function configDirOfTranscript(path) {
  const parts = path.split(/[\\/]/);
  const i = parts.lastIndexOf("projects");
  return i > 0 ? parts.slice(0, i).join(sep) : null;
}

export function runCompactCommand(sessionId, { model = null, settings = null, configDir = null, cwd, timeoutMs = 600_000 } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ACP_AGENT_|ANTHROPIC_|API_TIMEOUT_MS)/.test(k)) delete env[k];
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir; else delete env.CLAUDE_CONFIG_DIR;
  const args = ["-p", "--resume", sessionId, "--output-format", "json"];
  if (model) args.push("--model", model);           // else the profile's own model
  if (settings) args.push("--settings", settings);
  args.push("/compact");
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const opts = { env, cwd, timeout: timeoutMs, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] };
  let raw;
  try { raw = execFileSync(exe, args, opts).toString("utf8"); }
  catch (e) {
    if (e.code === "ENOENT" && exe === "claude.exe") raw = execFileSync("claude", args, { ...opts, shell: true }).toString("utf8");
    else throw new Error(`claude -p /compact failed: ${(e.stderr || e.stdout || e.message || "").toString().slice(0, 400)}`);
  }
  let o;
  try { o = JSON.parse(raw); } catch { throw new Error(`claude -p printed no JSON: ${raw.slice(0, 200)}`); }
  if (o.is_error) throw new Error(`claude -p error: ${String(o.result).slice(0, 300)}`);
  return { costUsd: o.total_cost_usd || 0, model: Object.keys(o.modelUsage || {})[0] || model || "(profile default)" };
}

function lastCostState(path) {
  let total = 0;
  try {
    for (const l of readFileSync(path, "utf8").split("\n")) {
      if (!l.includes('"cost-state"')) continue;
      try { const o = JSON.parse(l); if (o.type === "cost-state" && typeof o.totalCostUSD === "number") total = o.totalCostUSD; } catch { /* not that line */ }
    }
  } catch { /* unreadable: 0 */ }
  return total;
}

/**
 * Compact a written copy in place through Claude Code. Returns the report object the stats
 * carry: { ok, model, costUsd, preTokens, error }. `cwd` must be the folder the transcript
 * belongs to (its project dir), or `--resume` will not find it.
 */
export function summarizeCopy(path, { run = runCompactCommand, model, settings, cwd, log = () => {} } = {}) {
  const sessionId = basename(path).replace(/\.jsonl$/, "");
  const configDir = configDirOfTranscript(path);
  const report = { ok: false, model: model || "(profile default)", costUsd: 0, preTokens: 0, error: null };
  log(`running Claude Code's /compact on ${sessionId.slice(0, 8)} with ${report.model}${settings ? ` (${basename(settings)})` : ""} …`);
  // `total_cost_usd` of a resumed `-p` call is the SESSION's running total (the copy carries the
  // source's cost-state), so the call's own cost is the difference from the total before it.
  const before = lastCostState(path);
  try {
    const r = run(sessionId, { model, settings, configDir, cwd });
    report.costUsd = Math.max(0, (r.costUsd || 0) - before); if (r.model) report.model = r.model;
  } catch (e) { report.error = String(e.message || e); return report; }
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const l of lines) {
      if (!l.includes('"compact_boundary"')) continue;
      try { const o = JSON.parse(l); if (o.subtype === "compact_boundary") { report.ok = true; report.preTokens = o.compactMetadata?.preTokens || 0; } } catch { /* not that line */ }
    }
    if (!report.ok) report.error = "the call returned but no compact_boundary was written";
  } catch (e) { report.error = String(e.message || e); }
  return report;
}
