#!/usr/bin/env node
/**
 * Analyze a Codex CLI session JSONL file.
 *
 * Usage:
 *   node scripts/analyze-codex-session.mjs <path-to-session.jsonl>
 *   node scripts/analyze-codex-session.mjs --list                   # list recent sessions
 *   node scripts/analyze-codex-session.mjs --latest                 # analyze most recent session
 *   node scripts/analyze-codex-session.mjs --events <path> [--type tool_call] [--grep npm] [--limit 50] [--verbose] [--json]
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { parseCodex as parseCodexSession, fmtDuration as formatDuration, fmtTokens as formatTokens, runEventsMode, runFrictionMode } from "./lib/parse.mjs";

function printSummary({ stats }) {
  console.log("═".repeat(60));
  console.log("CODEX SESSION SUMMARY");
  console.log("═".repeat(60));

  console.log(`\nSession:    ${stats.sessionId.slice(0, 8)}…`);
  console.log(`Model:      ${stats.model}`);
  console.log(`CWD:        ${stats.cwd}`);
  console.log(`CLI:        v${stats.cliVersion}`);
  console.log(`Duration:   ${formatDuration(stats.durationSec)}`);
  console.log(`Turns:      ${stats.turns}`);
  console.log(`Tokens:     ${formatTokens(stats.inputTokens)} in / ${formatTokens(stats.outputTokens)} out`);

  if (stats.userMessages.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("USER MESSAGES");
    console.log("─".repeat(40));
    for (const msg of stats.userMessages) {
      const truncated = msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
      console.log(`  → ${truncated}`);
    }
  }

  if (stats.toolCalls) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("TOOL USAGE");
    console.log("─".repeat(40));
    const sorted = Object.entries(stats.toolNames).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      console.log(`  ${name}: ${count} calls`);
    }
  }

  if (stats.commands.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("COMMANDS RUN");
    console.log("─".repeat(40));
    for (const cmd of stats.commands) {
      const truncated = cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd;
      console.log(`  $ ${truncated}`);
    }
  }

  if (stats.webSearches.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("WEB SEARCHES");
    console.log("─".repeat(40));
    for (const q of stats.webSearches) {
      console.log(`  🔍 ${q}`);
    }
  }

  if (stats.patchesApplied.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("PATCHES APPLIED");
    console.log("─".repeat(40));
    for (const patch of stats.patchesApplied) {
      const status = patch.success ? "✓" : "✗";
      for (const f of patch.files) {
        console.log(`  ${status} ${f.replace(/^.*[\\/]packages/, "packages")}`);
      }
    }
  }

  if (stats.agentMessages.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("AGENT MESSAGES (last 5)");
    console.log("─".repeat(40));
    const last5 = stats.agentMessages.slice(-5);
    for (const msg of last5) {
      const truncated = msg.length > 300 ? msg.slice(0, 300) + "…" : msg;
      console.log(`  ${truncated}`);
      console.log();
    }
  }

  console.log("═".repeat(60));
}

// ── Session Discovery ────────────────────────────────────────────────────

function findCodexSessionsDir() {
  return join(homedir(), ".codex", "sessions");
}

function listSessions(sessionsDir) {
  const sessions = [];
  try {
    const years = readdirSync(sessionsDir).filter(d => /^\d{4}$/.test(d)).sort().reverse();
    for (const year of years) {
      const monthsDir = join(sessionsDir, year);
      const months = readdirSync(monthsDir).filter(d => /^\d{2}$/.test(d)).sort().reverse();
      for (const month of months) {
        const daysDir = join(monthsDir, month);
        const days = readdirSync(daysDir).filter(d => /^\d{2}$/.test(d)).sort().reverse();
        for (const day of days) {
          const filesDir = join(daysDir, day);
          const files = readdirSync(filesDir).filter(f => f.endsWith(".jsonl"));
          for (const file of files) {
            const filePath = join(filesDir, file);
            const stat = statSync(filePath);
            sessions.push({ path: filePath, name: file, size: stat.size, modified: stat.mtime });
          }
        }
      }
    }
  } catch (e) {
    console.error(`Error reading sessions: ${e.message}`);
  }
  return sessions.sort((a, b) => b.modified - a.modified);
}

// ── Main ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sessionsDir = findCodexSessionsDir();
const VALUE_FLAGS = new Set(["--type", "--grep", "--limit", "--around", "--context", "--top"]);
const eventsMode = args.includes("--events");
const arg = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));

if (!args.length) {
  console.log("Usage: node analyze-codex-session.mjs <path-to-session.jsonl>");
  console.log("       node analyze-codex-session.mjs --list");
  console.log("       node analyze-codex-session.mjs --latest");
  console.log("       node analyze-codex-session.mjs --events <path> [--type tool_call] [--grep s] [--limit N] [--verbose] [--json]");
  process.exit(1);
}

if (args.includes("--list")) {
  const sessions = listSessions(sessionsDir);
  console.log(`Found ${sessions.length} sessions in ${sessionsDir}\n`);
  for (const s of sessions.slice(0, 20)) {
    const sizeKB = (s.size / 1024).toFixed(0);
    const date = s.modified.toISOString().slice(0, 16);
    console.log(`  ${date}  ${sizeKB}KB  ${s.name.slice(0, 60)}…`);
  }
  process.exit(0);
}

let targetPath;
if (args.includes("--latest")) {
  const sessions = listSessions(sessionsDir);
  if (!sessions.length) {
    console.error("No sessions found.");
    process.exit(1);
  }
  targetPath = sessions[0].path;
  if (!eventsMode) console.log(`Analyzing latest session: ${sessions[0].name}\n`);
} else if (arg) {
  targetPath = resolve(arg);
} else {
  console.error("No session path given.");
  process.exit(1);
}

const content = readFileSync(targetPath, "utf-8");
if (args.includes("--friction")) {
  console.log(runFrictionMode("codex", content, args));
} else if (eventsMode) {
  console.log(runEventsMode("codex", content, args));
} else {
  printSummary(parseCodexSession(content.split("\n")));
}
