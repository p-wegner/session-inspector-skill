#!/usr/bin/env node
/**
 * subagent-results.mjs — recover the outcomes of subagents a cut-off orchestrator
 * session dispatched, so you can CONTINUE the work without blindly re-running them.
 *
 * The problem it solves
 * ─────────────────────
 * When an orchestrator (parent) session spawns Agent/Task subagents and is then
 * cut off (usage/rate limit, crash, interrupt), the subagents' work is stranded:
 *
 *   • A subagent may have COMPLETED, but its result reached the parent as a
 *     `<task-notification>` the parent never got to act on (async), or as a
 *     tool_result at the very tail with no assistant turn after it → the result
 *     exists and is RECOVERABLE (act on it; don't re-run).
 *   • A subagent may itself have been CUT OFF (shared-account limits cut parent
 *     AND children together) → only PARTIAL progress exists → it must be
 *     continued / re-run, but from its partial trail, not from zero.
 *   • An async subagent may still have been RUNNING at the cutoff → no delivery
 *     in the parent at all, but a finished transcript on disk → RE-INJECT it.
 *
 * A naive "is there a tool_result for this toolUseId?" check is WRONG for async
 * agents: the immediate tool_result is only the "Async agent launched
 * successfully" ACK — the real result arrives later as a task-notification.
 * This tool distinguishes ack / delivery / processing / self-cutoff.
 *
 * Subagent transcripts live at:  <session>/<sessionId>/subagents/agent-<id>.jsonl
 * with a sibling agent-<id>.meta.json carrying { agentType, description,
 * toolUseId, spawnDepth }. `toolUseId` is the parent Agent tool_use id — the join
 * key back to the parent transcript.
 *
 * Usage
 *   node subagent-results.mjs <path.jsonl | sessionId | projectDir/sessionId>
 *   node subagent-results.mjs --latest
 *   node subagent-results.mjs <locator> --unresolved     # only ones needing action
 *   node subagent-results.mjs <locator> --full            # full recovered text (no truncation)
 *   node subagent-results.mjs <locator> --id <agent-id>   # focus one subagent, full trail
 *   node subagent-results.mjs <locator> --brief [-o FILE] # write a continuation brief (md)
 *   node subagent-results.mjs <locator> --json
 *   (+ --profile <name> / --config-dir <path> to prefer a home when resolving by id)
 *
 * Node builtins only.
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "fs";
import { join, resolve, basename, dirname } from "path";
import { homedir } from "os";
import { claudeProjectDirs } from "./lib/config.mjs";

const BANNER = /hit your (session|usage|weekly) limit|resets \d+(:\d+)?\s*(am|pm)/i;

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : null);
const jsonOut = has("--json");
const fullText = has("--full");
const onlyUnresolved = has("--unresolved");
const wantBrief = has("--brief");
const focusId = val("--id");
const briefOut = val("-o") || val("--out");
const VALUE_FLAGS = new Set(["--profile", "--config-dir", "--id", "-o", "--out"]);
const positional = argv.find((a, i) => !a.startsWith("-") && !VALUE_FLAGS.has(argv[i - 1]));

// ── resolve the parent transcript path ─────────────────────────────────────────
function resolveConfigDir() {
  if (has("--config-dir") && val("--config-dir")) return val("--config-dir");
  if (has("--profile") && val("--profile")) return join(homedir(), `.claude-${val("--profile")}`);
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return join(homedir(), ".claude");
}

function listAll() {
  const out = [];
  for (const base of claudeProjectDirs()) {
    let dirs; try { dirs = readdirSync(base); } catch { continue; }
    for (const dir of dirs) {
      const dp = join(base, dir);
      let files; try { files = readdirSync(dp).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        const p = join(dp, f);
        out.push({ path: p, id: f.replace(/\.jsonl$/, ""), mtime: statSync(p).mtime });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function resolveTarget() {
  if (has("--latest")) {
    const all = listAll();
    if (!all.length) fail("No sessions found.");
    return all[0].path;
  }
  if (!positional) fail("Usage: node subagent-results.mjs <path|sessionId|--latest> [--unresolved|--full|--id ID|--brief|--json]");
  if (existsSync(resolve(positional)) && statSync(resolve(positional)).isFile()) return resolve(positional);
  // locator: bare id / prefix / projectDir/sessionId
  const clean = positional.replace(/\.jsonl$/i, "");
  const segs = clean.split(/[\\/]/).filter(Boolean);
  const idPart = segs[segs.length - 1];
  const dirPart = segs.length > 1 ? segs[segs.length - 2] : null;
  const all = listAll();
  const preferLeaf = (has("--profile") || has("--config-dir")) ? basename(resolveConfigDir()).toLowerCase() : null;
  const exact = [], prefix = [];
  for (const s of all) {
    if (dirPart && !s.path.includes(dirPart)) continue;
    if (s.id === idPart) exact.push(s);
    else if (s.id.startsWith(idPart)) prefix.push(s);
  }
  const pool = exact.length ? exact : prefix;
  if (!pool.length) fail(`No session matching "${positional}" (searched all profile homes).`);
  if (preferLeaf && pool.length > 1) pool.sort((a, b) =>
    (a.path.toLowerCase().includes(preferLeaf) ? 0 : 1) - (b.path.toLowerCase().includes(preferLeaf) ? 0 : 1));
  return pool[0].path;
}

function fail(msg) { console.error(msg); process.exit(1); }

// ── transcript helpers ─────────────────────────────────────────────────────────
function readJsonl(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return "";
}

/** Walk a subagent transcript → { entries, completed, selfCutoff, finalResult, lastSubstantive, turns } */
function analyzeSubagent(path) {
  const msgs = readJsonl(path);
  let lastStop = null, lastAssistantText = "", finalSubstantive = "", turns = 0;
  let trailingBanner = false;
  for (const o of msgs) if (o.type === "assistant" && o.message) turns++;
  // walk from the end for stop_reason + last substantive (non-banner) assistant text
  for (let i = msgs.length - 1; i >= 0; i--) {
    const o = msgs[i];
    if (o.type !== "assistant" || !o.message) continue;
    const txt = textOf(o.message.content).trim();
    if (lastStop === null) { lastStop = o.message.stop_reason || ""; trailingBanner = BANNER.test(txt) && txt.length < 200; }
    if (txt && !lastAssistantText) lastAssistantText = txt;
    if (txt && !BANNER.test(txt)) { finalSubstantive = txt; break; }
  }
  const endedClean = lastStop === "end_turn";
  // self-cutoff: last real assistant message was a limit banner, or stopped on stop_sequence with no clean end
  const selfCutoff = trailingBanner || (lastStop === "stop_sequence" && BANNER.test(lastAssistantText));
  const incomplete = !endedClean && !selfCutoff && lastStop === "tool_use"; // died mid-tool
  return {
    turns, lastStop, endedClean, selfCutoff, incomplete,
    finalResult: endedClean ? (finalSubstantive || lastAssistantText) : "",
    lastSubstantive: finalSubstantive,
  };
}

/** Parse the parent transcript: launches, async-ness, deliveries, and whether each was processed. */
function analyzeParent(path) {
  const msgs = readJsonl(path);
  const seqOf = new Map();
  msgs.forEach((o, i) => seqOf.set(o, i));

  const launches = new Map(); // toolUseId -> { seq, ts, description }
  const acks = new Map();      // toolUseId -> { async: bool }  (from immediate tool_result)
  const deliveries = new Map();// toolUseId -> { seq, ts, kind: 'sync'|'notification' }

  for (let i = 0; i < msgs.length; i++) {
    const o = msgs[i];
    const c = o.message?.content;
    if (!Array.isArray(c)) {
      // task-notification arrives as a plain-string user message
      if (o.type === "user" && typeof c === "string" && c.includes("<task-notification>")) {
        const m = c.match(/<tool-use-id>([^<]+)<\/tool-use-id>/);
        if (m && !deliveries.has(m[1])) deliveries.set(m[1], { seq: i, ts: o.timestamp, kind: "notification" });
      }
      continue;
    }
    for (const b of c) {
      if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) {
        launches.set(b.id, { seq: i, ts: o.timestamp, description: b.input?.description || "" });
      } else if (b.type === "tool_result" && b.tool_use_id) {
        const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
        const isAsync = /Async agent launched successfully/i.test(body);
        if (launches.has(b.tool_use_id)) {
          acks.set(b.tool_use_id, { async: isAsync });
          if (!isAsync && !deliveries.has(b.tool_use_id)) {
            // sync agent: this tool_result IS the delivered result
            deliveries.set(b.tool_use_id, { seq: i, ts: o.timestamp, kind: "sync" });
          }
        }
      }
    }
  }

  // did a substantive assistant turn happen AFTER the delivery seq?
  function processedAfter(seq) {
    for (let i = seq + 1; i < msgs.length; i++) {
      const o = msgs[i];
      if (o.type !== "assistant" || !o.message) continue;
      const c = o.message.content;
      if (Array.isArray(c) && c.some((b) => b.type === "tool_use")) return true;
      const txt = textOf(c).trim();
      if (txt && !BANNER.test(txt)) return true;
    }
    return false;
  }

  return { launches, acks, deliveries, processedAfter, endTs: msgs[msgs.length - 1]?.timestamp };
}

// ── classification ──────────────────────────────────────────────────────────────
// Combine parent + subagent facts into one actionable status per subagent.
function classify(parent, sub, toolUseId) {
  const launched = parent.launches.has(toolUseId);
  const async = parent.acks.get(toolUseId)?.async ?? false;
  const delivery = parent.deliveries.get(toolUseId);
  const processed = delivery ? parent.processedAfter(delivery.seq) : false;

  if (processed) return { status: "processed", action: "none — result was consumed by the orchestrator", async, delivered: true };

  // not processed by parent — figure out why & what's recoverable
  if (sub.selfCutoff || sub.incomplete) {
    return {
      status: delivery ? "delivered-partial" : "self-cutoff",
      action: "CONTINUE / RE-RUN — subagent hit its own limit mid-work; only a partial trail exists",
      async, delivered: !!delivery,
    };
  }
  if (sub.endedClean && delivery) {
    return { status: "delivered-unprocessed", action: "ACT on the recovered result — do NOT re-run (orchestrator cut off before adjudicating)", async, delivered: true };
  }
  if (sub.endedClean && !delivery) {
    return { status: "undelivered-complete", action: "RE-INJECT the recovered result — subagent finished but parent never received it", async, delivered: false };
  }
  if (!launched) return { status: "orphan-transcript", action: "subagent transcript with no matching parent launch (older/other session?)", async, delivered: false };
  return { status: "unknown", action: "inspect manually", async, delivered: !!delivery };
}

// ── main ──────────────────────────────────────────────────────────────────────
const parentPath = resolveTarget();
const sessionId = basename(parentPath).replace(/\.jsonl$/, "");
const subDir = join(dirname(parentPath), sessionId, "subagents");

if (!existsSync(subDir)) {
  if (jsonOut) { console.log(JSON.stringify({ sessionId, parentPath, subagents: [] }, null, 2)); process.exit(0); }
  console.log(`No subagents dir for session ${sessionId}\n  (looked in ${subDir})\n  This session dispatched no subagents, or ran a Claude build without per-subagent transcripts.`);
  process.exit(0);
}

const parent = analyzeParent(parentPath);
const metas = readdirSync(subDir).filter((f) => f.endsWith(".meta.json"));

const rows = [];
for (const mf of metas) {
  const meta = JSON.parse(readFileSync(join(subDir, mf), "utf8"));
  const agentId = mf.replace(/\.meta\.json$/, "");
  const tPath = join(subDir, `${agentId}.jsonl`);
  if (!existsSync(tPath)) continue;
  const sub = analyzeSubagent(tPath);
  const cls = classify(parent, sub, meta.toolUseId);
  rows.push({
    agentId, path: tPath, description: meta.description, agentType: meta.agentType,
    toolUseId: meta.toolUseId, ...cls,
    turns: sub.turns, lastStop: sub.lastStop,
    result: sub.finalResult, partial: sub.lastSubstantive,
    mtime: statSync(tPath).mtime,
  });
}
rows.sort((a, b) => a.mtime - b.mtime);

const NEEDS = new Set(["delivered-partial", "self-cutoff", "delivered-unprocessed", "undelivered-complete"]);
const shown = onlyUnresolved ? rows.filter((r) => NEEDS.has(r.status)) : rows;
const focus = focusId ? rows.filter((r) => r.agentId.includes(focusId) || r.toolUseId.includes(focusId)) : null;

if (jsonOut) {
  console.log(JSON.stringify({ sessionId, parentPath, endTs: parent.endTs, subagents: (focus || shown) }, null, 2));
  process.exit(0);
}

// ── focus mode: dump one subagent fully ─────────────────────────────────────────
if (focus) {
  for (const r of focus) {
    console.log("═".repeat(70));
    console.log(`${r.agentId}  [${r.status}]`);
    console.log(`  ${r.description}  (${r.agentType}, ${r.turns} turns, stop=${r.lastStop})`);
    console.log(`  → ${r.action}`);
    console.log("─".repeat(70));
    console.log(r.result || r.partial || "(no substantive text recovered)");
  }
  process.exit(0);
}

// ── summary table ────────────────────────────────────────────────────────────────
const ICON = {
  processed: "✅", "delivered-unprocessed": "📥", "undelivered-complete": "📤",
  "delivered-partial": "⚠️ ", "self-cutoff": "⛔", "orphan-transcript": "❔", unknown: "❔",
};
console.log("═".repeat(70));
console.log("SUBAGENT RESULTS RECOVERY");
console.log("═".repeat(70));
console.log(`Session:   ${sessionId}`);
console.log(`Parent:    ${parentPath}`);
console.log(`Subagents: ${rows.length}   (needing action: ${rows.filter((r) => NEEDS.has(r.status)).length})`);
console.log("");

const counts = {};
for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
console.log("STATUS TALLY: " + Object.entries(counts).map(([k, v]) => `${ICON[k] || "•"} ${k}=${v}`).join("   "));
console.log("");
console.log("Legend: ✅ processed · 📥 delivered-unprocessed (ACT, don't re-run) · 📤 undelivered-complete (re-inject)");
console.log("        ⚠️  delivered-partial / ⛔ self-cutoff (continue/re-run from partial trail)");
console.log("─".repeat(70));

for (const r of shown) {
  console.log(`${ICON[r.status] || "•"} ${r.status.padEnd(22)} ${r.description}`);
  console.log(`   ${r.agentId}  ${r.async ? "async" : "sync"}  ${r.turns} turns  stop=${r.lastStop}`);
  console.log(`   → ${r.action}`);
  const body = r.status === "delivered-unprocessed" || r.status === "undelivered-complete" ? r.result : r.partial;
  if (body) {
    const snip = fullText ? body : (body.length > 400 ? body.slice(0, 400) + " …" : body);
    console.log("   ┌─ recovered " + (r.result ? "RESULT" : "PARTIAL TRAIL") + " ─────");
    for (const ln of snip.split("\n")) console.log("   │ " + ln);
    console.log("   └─────");
  }
  console.log("");
}

if (!fullText && shown.some((r) => (r.result || r.partial))) {
  console.log(`(use --full for complete recovered text, or --id <agent-id> to dump one subagent)`);
}

// ── continuation brief ──────────────────────────────────────────────────────────
if (wantBrief) {
  const lines = [];
  lines.push(`# Subagent continuation brief — ${sessionId}`, "");
  lines.push(`Parent orchestrator: \`${parentPath}\``);
  lines.push(`Ended: ${parent.endTs}`, "");
  const need = rows.filter((r) => NEEDS.has(r.status));
  lines.push(`## ${need.length} subagent(s) need attention`, "");
  for (const r of need) {
    lines.push(`### ${r.description}  \`[${r.status}]\``);
    lines.push(`- agent: \`${r.agentId}\` (${r.agentType}, ${r.async ? "async" : "sync"}, ${r.turns} turns, stop=${r.lastStop})`);
    lines.push(`- action: **${r.action}**`);
    const body = (r.result || r.partial || "").trim();
    if (body) {
      lines.push("", "```", body.length > 4000 ? body.slice(0, 4000) + "\n…(truncated)" : body, "```");
    }
    lines.push("");
  }
  const processed = rows.filter((r) => r.status === "processed");
  if (processed.length) {
    lines.push(`## ${processed.length} already processed (no action)`, "");
    for (const r of processed) lines.push(`- ${r.description} \`${r.agentId}\``);
  }
  const md = lines.join("\n");
  if (briefOut) { writeFileSync(briefOut, md); console.log(`\nBrief written to ${briefOut}`); }
  else { console.log("\n" + "═".repeat(70) + "\n" + md); }
}
