/**
 * narrator.mjs — have a MODEL write the one-line narrations of a transcript's tool calls,
 * through a headless `claude -p` under any profile (settings file, config dir) and any model.
 *
 * Why a model at all: `compact.mjs`'s narrate mode is a string cut, so a test run reads
 * "first: …; last: …" rather than "6 pass, 1 fail: the timer test", and a 300-line diff reads
 * as its first line. A cheap model (haiku, or a gateway/provider profile) can write what a
 * stronger model will want to know when it resumes the copy — which is the whole use case:
 * compact on the cheap profile, continue on the expensive one.
 *
 * Why `claude -p` and not the API: a subscription account has no API key to call, and the
 * picker's profiles are Claude Code profiles (a settings file with a provider, a config dir
 * with an account, a nexos gateway home). `claude -p` under that profile is the one call that
 * works for all of them. The floor of such a call is 3.4k tokens once the defaults are off
 * (`--system-prompt` replaces the prompt, `--tools ""` drops the tool schemas,
 * `--setting-sources ""` drops CLAUDE.md and skills; measured 2026-09-19: 51k → 3.4k), and
 * `--no-session-persistence` keeps it out of the projects folder.
 *
 * Node builtins only. The runner is injectable (`run`) so the batching, the prompt and the
 * parse are unit-tested without a model.
 */

import { execFileSync } from "child_process";
import { tmpdir } from "os";

export const NARRATOR_SYSTEM = `You compress a coding agent's tool calls for a transcript that a stronger model will resume.
For each call you get its id, tool, input and result. Write two fields per id:
  "did": what was done, at most 140 characters. Keep exact paths, commands, symbols, flags.
  "got": what came back, at most 220 characters. Keep exact numbers, counts, error messages, file names, test tallies, and any fact the resuming model would otherwise have to re-derive (a version, a measured value, a verdict, a path found).
Facts only: no advice, no evaluation, no "successfully". An error result starts with "ERROR:".
Answer with ONE JSON object keyed by id: {"<id>": {"did": "...", "got": "..."}, ...}. No prose, no code fence.`;

const cut = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + `… [${s.length - n} more chars]` : s);
const headTail = (s, h, t) => (typeof s === "string" && s.length > h + t + 50 ? s.slice(0, h) + `\n… [${s.length - h - t} chars omitted] …\n` + s.slice(-t) : s);

/** Split calls into batches bounded by characters and count, keeping order. */
export function batchCalls(calls, { maxChars = 24_000, maxCalls = 20 } = {}) {
  const batches = [];
  let cur = [], size = 0;
  for (const c of calls) {
    const item = {
      id: c.id, tool: c.name,
      input: cut(JSON.stringify(c.input ?? {}), 3_000),
      result: headTail(c.resultText ?? "", 2_400, 1_200),
      error: c.isError === true || undefined,
    };
    const n = JSON.stringify(item).length;
    if (cur.length && (size + n > maxChars || cur.length >= maxCalls)) { batches.push(cur); cur = []; size = 0; }
    cur.push(item); size += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export function promptFor(batch) {
  return `Tool calls, oldest first:\n${JSON.stringify(batch, null, 1)}\n\nReturn the JSON object keyed by id.`;
}

/** Pull the JSON object out of a model reply that may wrap it in a fence or a sentence. */
export function parseNarrations(text) {
  if (typeof text !== "string") return {};
  const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  let o;
  try { o = JSON.parse(s.slice(start, end + 1)); } catch { return {}; }
  const out = {};
  for (const [id, v] of Object.entries(o)) {
    if (!v || typeof v !== "object") continue;
    const did = String(v.did ?? "").trim(), got = String(v.got ?? "").trim();
    if (did || got) out[id] = { did: did.slice(0, 200), got: got.slice(0, 300) };
  }
  return out;
}

/**
 * The default runner: one `claude -p` per batch under the given profile.
 * @returns {{ text, costUsd, inputTokens, outputTokens, model }}
 */
export function runClaude(prompt, { model = null, settings = null, configDir = null, timeoutMs = 300_000, cwd = tmpdir() } = {}) {
  const env = { ...process.env };
  // A nested session's own variables must not leak into the narrator, and the chosen profile's
  // provider must win over an exported one — the same scrub cfork does before a fork.
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ACP_AGENT_|ANTHROPIC_|API_TIMEOUT_MS)/.test(k)) delete env[k];
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir; else delete env.CLAUDE_CONFIG_DIR;
  const args = ["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--setting-sources", "",
    "--system-prompt", NARRATOR_SYSTEM];
  if (model) args.push("--model", model);           // else the profile's own model
  if (settings) args.push("--settings", settings);
  args.push(prompt);
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  let raw;
  try { raw = execFileSync(exe, args, { env, cwd, timeout: timeoutMs, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8"); }
  catch (e) {
    if (e.code === "ENOENT" && exe === "claude.exe") raw = execFileSync("claude", args, { env, cwd, timeout: timeoutMs, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], shell: true }).toString("utf8");
    else throw new Error(`claude -p failed: ${(e.stderr || e.stdout || e.message || "").toString().slice(0, 400)}`);
  }
  let o;
  try { o = JSON.parse(raw); } catch { throw new Error(`claude -p printed no JSON: ${raw.slice(0, 200)}`); }
  if (o.is_error) throw new Error(`claude -p error: ${String(o.result).slice(0, 300)}`);
  const u = o.usage || {};
  return {
    text: String(o.result ?? ""), costUsd: o.total_cost_usd || 0,
    inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    outputTokens: u.output_tokens || 0,
    model: Object.keys(o.modelUsage || {})[0] || model || "(profile default)",
  };
}

/**
 * Narrate every call. Returns { narrations: Map id → {did, got}, report: {...} }.
 * A batch whose call fails or parses to nothing is reported and left to the deterministic
 * fallback in compact.mjs; nothing throws past here unless `strict`.
 */
export function narrateCalls(calls, { run = runClaude, model, settings, configDir, maxChars, maxCalls, log = () => {}, strict = false } = {}) {
  const batches = batchCalls(calls, { maxChars, maxCalls });
  const narrations = new Map();
  const report = { batches: batches.length, calls: calls.length, narrated: 0, fallback: 0, failedBatches: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, model: model || "(profile default)", errors: [] };
  batches.forEach((batch, i) => {
    log(`narrating batch ${i + 1}/${batches.length} (${batch.length} calls) …`);
    let r;
    try { r = run(promptFor(batch), { model, settings, configDir }); }
    catch (e) {
      report.failedBatches++; report.errors.push(String(e.message || e));
      if (strict) throw e;
      report.fallback += batch.length;
      return;
    }
    report.costUsd += r.costUsd || 0; report.inputTokens += r.inputTokens || 0; report.outputTokens += r.outputTokens || 0;
    if (r.model) report.model = r.model;
    const got = parseNarrations(r.text);
    for (const c of batch) {
      if (got[c.id]) { narrations.set(c.id, got[c.id]); report.narrated++; }
      else report.fallback++;
    }
    if (!Object.keys(got).length) { report.failedBatches++; report.errors.push(`batch ${i + 1}: reply held no narrations`); if (strict) throw new Error(report.errors.at(-1)); }
  });
  return { narrations, report };
}
