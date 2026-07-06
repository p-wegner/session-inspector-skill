#!/usr/bin/env node
/**
 * Analyze a Claude Code session JSONL transcript (~/.claude/projects/<dir>/<uuid>.jsonl).
 *
 * Parity with analyze-codex-session.mjs / analyze-copilot-session.mjs, plus the
 * friction metrics the fleet-analysis workflow cares about: tool-call counts,
 * FAILED tool calls (per tool), repeated commands, and error excerpts.
 *
 * Usage:
 *   node scripts/analyze-claude-session.mjs <path-to-session.jsonl>
 *   node scripts/analyze-claude-session.mjs --list [--worktrees]
 *   node scripts/analyze-claude-session.mjs --latest
 *   node scripts/analyze-claude-session.mjs --json <path>   # machine-readable
 *   node scripts/analyze-claude-session.mjs --events <path> [--type tool_error] [--grep git] [--limit 50] [--verbose] [--json]
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { parseClaude as parseClaudeSession, fmtDuration, fmtTokens, runEventsMode } from "./lib/parse.mjs";

function printSummary(s) {
  console.log("═".repeat(60));
  console.log("CLAUDE SESSION SUMMARY");
  console.log("═".repeat(60));
  console.log(`\nSession:    ${(s.sessionId || "?").slice(0, 8)}…`);
  console.log(`Model:      ${s.model}`);
  console.log(`CWD:        ${s.cwd}`);
  console.log(`Duration:   ${fmtDuration(s.durationSec)}`);
  console.log(`Asst turns: ${s.assistantTurns}`);
  console.log(`Tokens:     ${fmtTokens(s.inputTokens)} in / ${fmtTokens(s.outputTokens)} out / ${fmtTokens(s.cacheReadTokens)} cache-read`);
  console.log(`Tool calls: ${s.toolCalls}  (failed: ${s.failedToolCalls}${s.toolCalls ? `, ${Math.round((100 * s.failedToolCalls) / s.toolCalls)}%` : ""})`);
  console.log(`Stop:       ${s.stopReason || "(none / interrupted)"}`);

  const tools = Object.entries(s.toolNames).sort((a, b) => b[1].count - a[1].count);
  if (tools.length) {
    console.log(`\n${"─".repeat(40)}\nTOOL USAGE (failed/total)\n${"─".repeat(40)}`);
    for (const [name, { count, failed }] of tools) {
      console.log(`  ${name}: ${failed}/${count}${failed ? "  ⚠" : ""}`);
    }
  }
  if (s.repeatedCommands.length) {
    console.log(`\n${"─".repeat(40)}\nREPEATED COMMANDS (wasted-turn signal)\n${"─".repeat(40)}`);
    for (const { command, count } of s.repeatedCommands.slice(0, 10)) {
      console.log(`  ${count}×  ${command}`);
    }
  }
  if (s.errors.length) {
    console.log(`\n${"─".repeat(40)}\nERROR EXCERPTS (${s.errors.length})\n${"─".repeat(40)}`);
    for (const e of s.errors.slice(0, 5)) console.log(`  ✗ ${e.replace(/\s+/g, " ")}`);
  }
  if (s.assistantTexts.length) {
    console.log(`\n${"─".repeat(40)}\nLAST ASSISTANT MESSAGE\n${"─".repeat(40)}`);
    const last = s.assistantTexts[s.assistantTexts.length - 1];
    console.log(`  ${last.slice(0, 400)}${last.length > 400 ? "…" : ""}`);
  }
  console.log("═".repeat(60));
}

function listSessions(onlyWorktrees) {
  const base = join(homedir(), ".claude", "projects");
  const out = [];
  if (!existsSync(base)) return out;
  for (const dir of readdirSync(base)) {
    if (onlyWorktrees && !/worktrees-feature-ak-/.test(dir)) continue;
    const dirPath = join(base, dir);
    let files;
    try { files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = join(dirPath, f);
      const st = statSync(p);
      out.push({ path: p, name: f, dir, size: st.size, modified: st.mtime });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const VALUE_FLAGS = new Set(["--type", "--grep", "--limit"]);
const arg = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));

if (args.includes("--list")) {
  const sessions = listSessions(args.includes("--worktrees"));
  console.log(`Found ${sessions.length} Claude sessions\n`);
  for (const s of sessions.slice(0, 25)) {
    console.log(`  ${s.modified.toISOString().slice(0, 16)}  ${(s.size / 1024).toFixed(0)}KB  ${s.dir.slice(0, 50)}  ${s.name.slice(0, 12)}`);
  }
  process.exit(0);
}

let targetPath;
if (args.includes("--latest")) {
  const sessions = listSessions(false);
  if (!sessions.length) { console.error("No sessions found."); process.exit(1); }
  targetPath = sessions[0].path;
} else if (arg) {
  targetPath = resolve(arg);
} else {
  console.log("Usage: node analyze-claude-session.mjs <path.jsonl> | --list [--worktrees] | --latest [--json]");
  process.exit(1);
}

const content = readFileSync(targetPath, "utf-8");
if (args.includes("--events")) {
  console.log(runEventsMode("claude", content, args));
} else if (jsonOut) {
  console.log(JSON.stringify(parseClaudeSession(content.split("\n")), null, 2));
} else {
  printSummary(parseClaudeSession(content.split("\n")));
}
