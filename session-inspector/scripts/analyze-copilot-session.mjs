#!/usr/bin/env node
/**
 * Analyze a Copilot CLI session events.jsonl file.
 *
 * Usage:
 *   node scripts/analyze-copilot-session.mjs <path-to-events.jsonl>
 *   node scripts/analyze-copilot-session.mjs --list
 *   node scripts/analyze-copilot-session.mjs --latest
 *   node scripts/analyze-copilot-session.mjs --events <path> [--type tool_error] [--grep s] [--limit N] [--verbose] [--json]
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { parseCopilot as parseCopilotSession, fmtDuration as formatDuration, runEventsMode, runFrictionMode } from "./lib/parse.mjs";

function printSummary({ stats }) {
  console.log("=".repeat(60));
  console.log("COPILOT SESSION SUMMARY");
  console.log("=".repeat(60));

  console.log(`\nSession:    ${stats.sessionId.slice(0, 8)}...`);
  console.log(`Model:      ${stats.model}`);
  console.log(`Copilot:    v${stats.copilotVersion}`);
  console.log(`CWD:        ${stats.cwd}`);
  console.log(`Branch:     ${stats.branch}`);
  console.log(`Duration:   ${formatDuration(stats.durationSec)} (API: ${formatDuration(Math.round(stats.totalApiDurationMs / 1000))})`);
  console.log(`Shutdown:   ${stats.shutdownType}`);
  console.log(`Turns:      ${stats.turns}`);
  console.log(`Tool calls: ${stats.toolCalls}`);
  if (stats.linesAdded || stats.linesRemoved) {
    console.log(`Changes:    +${stats.linesAdded}/-${stats.linesRemoved} lines in ${stats.filesModified.length} files`);
  }

  if (stats.userMessages.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("USER MESSAGES");
    console.log("─".repeat(40));
    for (const msg of stats.userMessages) {
      const truncated = msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
      console.log(`  -> ${truncated}`);
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
      const truncated = cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd;
      console.log(`  $ ${truncated}`);
    }
  }

  if (stats.assistantMessages.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("AGENT MESSAGES");
    console.log("─".repeat(40));
    for (const msg of stats.assistantMessages) {
      const truncated = msg.length > 300 ? msg.slice(0, 300) + "..." : msg;
      console.log(`  ${truncated}`);
      console.log();
    }
  }

  if (stats.filesModified.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("FILES MODIFIED");
    console.log("─".repeat(40));
    for (const f of stats.filesModified) {
      console.log(`  ${f}`);
    }
  }

  console.log("=".repeat(60));
}

// ── Session Discovery ────────────────────────────────────────────────────

function findCopilotSessionsDir() {
  return join(homedir(), ".copilot", "session-state");
}

function listSessions(sessionsDir) {
  const sessions = [];
  try {
    const dirs = readdirSync(sessionsDir).filter(d => {
      const full = join(sessionsDir, d);
      return statSync(full).isDirectory() && existsSync(join(full, "workspace.yaml"));
    });
    for (const dir of dirs) {
      const fullPath = join(sessionsDir, dir);
      const eventsPath = join(fullPath, "events.jsonl");
      const hasEvents = existsSync(eventsPath);
      const eventsSize = hasEvents ? statSync(eventsPath).size : 0;
      const wsStat = statSync(fullPath);
      sessions.push({
        id: dir,
        path: fullPath,
        eventsPath: hasEvents ? eventsPath : null,
        hasEvents,
        eventsSize,
        modified: wsStat.mtime,
      });
    }
  } catch (e) {
    console.error(`Error reading sessions: ${e.message}`);
  }
  return sessions.sort((a, b) => b.modified - a.modified);
}

// ── Main ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sessionsDir = findCopilotSessionsDir();
const VALUE_FLAGS = new Set(["--type", "--grep", "--limit", "--around", "--context", "--top"]);
const eventsMode = args.includes("--events");
const arg = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));

if (!args.length) {
  console.log("Usage: node analyze-copilot-session.mjs <path-to-events.jsonl>");
  console.log("       node analyze-copilot-session.mjs --list");
  console.log("       node analyze-copilot-session.mjs --latest");
  console.log("       node analyze-copilot-session.mjs --events <path> [--type tool_error] [--grep s] [--limit N] [--verbose] [--json]");
  process.exit(1);
}

if (args.includes("--list")) {
  const sessions = listSessions(sessionsDir);
  console.log(`Found ${sessions.length} sessions in ${sessionsDir}\n`);
  for (const s of sessions.slice(0, 20)) {
    const date = s.modified.toISOString().slice(0, 16);
    const size = s.hasEvents ? `${(s.eventsSize / 1024).toFixed(0)}KB` : "(no events)";
    console.log(`  ${date}  ${size}  ${s.id}`);
  }
  process.exit(0);
}

let targetPath;
if (args.includes("--latest")) {
  const sessions = listSessions(sessionsDir).filter(s => s.hasEvents);
  if (!sessions.length) {
    console.error("No sessions with events.jsonl found.");
    process.exit(1);
  }
  targetPath = sessions[0].eventsPath;
  if (!eventsMode) console.log(`Analyzing latest session: ${sessions[0].id}\n`);
} else if (arg) {
  targetPath = resolve(arg);
} else {
  console.error("No session path given.");
  process.exit(1);
}

const content = readFileSync(targetPath, "utf-8");
if (args.includes("--friction")) {
  console.log(runFrictionMode("copilot", content, args));
} else if (eventsMode) {
  console.log(runEventsMode("copilot", content, args));
} else {
  printSummary({ stats: parseCopilotSession(content.split("\n")) });
}
