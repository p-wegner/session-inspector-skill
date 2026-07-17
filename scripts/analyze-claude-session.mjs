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
import { join, resolve, basename, dirname } from "path";
import { homedir } from "os";
import { parseClaude as parseClaudeSession, fmtDuration, fmtTokens, runEventsMode } from "./lib/parse.mjs";
import { claudeProjectDirs } from "./lib/config.mjs";

/** Short tag for the Claude home a projects dir belongs to (".claude", ".claude-team_5x", …). */
function homeTag(projectsDir) {
  return basename(dirname(projectsDir));
}

/** Collapse whitespace and truncate to n chars for single-line display. */
function oneLine(text, n = 100) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** One-line health verdict: what's interesting about how this session ended. */
function glanceFlags(s) {
  const flags = [];
  // Strong signal first: the limit banner was the session's FINAL message → it was
  // actually cut off here and is resumable. Fall back to the weak any-mention flag
  // (marked "mentioned") so a session that merely discusses limits isn't sold as cut off.
  if (s.endedOnLimit === "usage-limit") flags.push("⛔ HIT USAGE LIMIT (cut off — resumable)");
  else if (s.endedOnLimit === "rate-limit") flags.push("⛔ RATE-LIMITED (cut off — resumable)");
  else if (s.hitLimit === "usage-limit") flags.push("⚠ usage limit mentioned (not terminal)");
  else if (s.hitLimit === "rate-limit") flags.push("⚠ rate limit mentioned (not terminal)");
  if (s.endedInterrupted) flags.push("✋ ended on user interrupt");
  if (s.compactions) flags.push(`🗜 ${s.compactions} compaction${s.compactions > 1 ? "s" : ""}`);
  if (s.toolCalls && s.failedToolCalls / s.toolCalls >= 0.2) flags.push(`⚠ ${Math.round((100 * s.failedToolCalls) / s.toolCalls)}% tool failures`);
  if (s.stopReason === "tool_use") flags.push("… ended mid-tool-call (interrupted/still running)");
  return flags;
}

function printSummary(s) {
  console.log("═".repeat(60));
  console.log("CLAUDE SESSION SUMMARY");
  console.log("═".repeat(60));

  // ── AT A GLANCE — the interesting stuff first ──────────────────────────────
  console.log(`\nGoal:       ${s.aiTitle || "(no title)"}`);
  if (s.firstPrompt) console.log(`First ask:  ${oneLine(s.firstPrompt, 100)}`);
  if (s.lastPrompt && s.lastPrompt !== s.firstPrompt) console.log(`Last ask:   ${oneLine(s.lastPrompt, 100)}`);
  const flags = glanceFlags(s);
  if (flags.length) console.log(`Signals:    ${flags.join("  ·  ")}`);

  console.log(`\nSession:    ${(s.sessionId || "?").slice(0, 8)}…`);
  console.log(`Model:      ${s.model}`);
  console.log(`CWD:        ${s.cwd}`);
  console.log(`Duration:   ${fmtDuration(s.durationSec)}`);
  console.log(`Asst turns: ${s.assistantTurns}${s.compactions ? `  (${s.compactions} compaction${s.compactions > 1 ? "s" : ""})` : ""}`);
  console.log(`Tokens:     ${fmtTokens(s.inputTokens)} in / ${fmtTokens(s.outputTokens)} out / ${fmtTokens(s.cacheReadTokens)} cache-read${s.maxContextTokens ? `  ·  peak ctx ${fmtTokens(s.maxContextTokens)}` : ""}`);
  console.log(`Tool calls: ${s.toolCalls}  (failed: ${s.failedToolCalls}${s.toolCalls ? `, ${Math.round((100 * s.failedToolCalls) / s.toolCalls)}%` : ""})`);
  console.log(`Stop:       ${s.stopReason || "(none / interrupted)"}${s.endedOnLimit ? `  ⛔ ${s.endedOnLimit} (cut off here)` : (s.hitLimit ? `  ⚠ ${s.hitLimit} mentioned` : "")}`);

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

// Resolve the Claude config dir (which profile's transcripts to read).
// Priority: --config-dir <path> | --profile <name> (=> ~/.claude-<name>) |
// $CLAUDE_CONFIG_DIR | default ~/.claude. Lets --list/--latest see non-default
// auth profiles (e.g. ~/.claude-andrena_team_5x) instead of only ~/.claude.
export function resolveConfigDir(argv = process.argv) {
  const cd = argv[argv.indexOf("--config-dir") + 1];
  if (argv.includes("--config-dir") && cd) return cd;
  const pf = argv[argv.indexOf("--profile") + 1];
  if (argv.includes("--profile") && pf) return join(homedir(), `.claude-${pf}`);
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return join(homedir(), ".claude");
}

function listSessions(onlyWorktrees) {
  const homes = claudeProjectDirs();
  const multiHome = homes.length > 1;
  const out = [];
  for (const base of homes) {
    const tag = homeTag(base);
    for (const dir of readdirSync(base)) {
      if (onlyWorktrees && !/worktrees-feature-ak-/.test(dir)) continue;
      const dirPath = join(base, dir);
      let files;
      try { files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        const p = join(dirPath, f);
        const st = statSync(p);
        // Prefix the dir label with the home tag when more than one home exists,
        // so identically-named project dirs across profiles stay distinguishable.
        const label = multiHome ? `${tag}/${dir}` : dir;
        out.push({ path: p, name: f, dir: label, size: st.size, modified: st.mtime });
      }
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const VALUE_FLAGS = new Set(["--type", "--grep", "--limit", "--config-dir", "--profile", "--session"]);
const arg = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));

if (args.includes("--list")) {
  const sessions = listSessions(args.includes("--worktrees"));
  console.log(`Found ${sessions.length} Claude sessions\n`);
  for (const s of sessions.slice(0, 25)) {
    console.log(`  ${s.modified.toISOString().slice(0, 16)}  ${(s.size / 1024).toFixed(0)}KB  ${s.dir.slice(0, 64)}  ${s.name.slice(0, 12)}`);
  }
  process.exit(0);
}

// Resolve a session locator that is NOT a filesystem path: a bare session-id (or
// id-prefix), or a "<projectDir>/<sessionId>" locator (the form the statusline and
// skill docs emit), with or without a trailing .jsonl. Scans every profile home via
// listSessions(); honors --profile/--config-dir by restricting to that home.
function findSessionByLocator(locator, argv = process.argv) {
  const clean = String(locator).replace(/\.jsonl$/i, "");
  const segs = clean.split(/[\\/]/).filter(Boolean);
  const idPart = segs[segs.length - 1];
  const dirPart = segs.length > 1 ? segs[segs.length - 2] : null;

  let sessions = listSessions(false);

  // Restrict to a single profile home when the caller named one.
  if (argv.includes("--profile") || argv.includes("--config-dir")) {
    const home = resolveConfigDir(argv);
    const homeLeaf = basename(home).toLowerCase();
    sessions = sessions.filter((s) => s.path.toLowerCase().includes(homeLeaf));
  }

  const exact = [];
  const prefix = [];
  for (const s of sessions) {
    const id = s.name.replace(/\.jsonl$/i, "");
    if (dirPart) {
      const dirLeaf = s.dir.split(/[\\/]/).pop();
      if (dirLeaf !== dirPart && !s.dir.includes(dirPart)) continue;
    }
    if (id === idPart) exact.push(s);
    else if (id.startsWith(idPart)) prefix.push(s);
  }
  // Prefer an exact id match; fall back to prefix matches (both newest-first).
  return exact.length ? exact : prefix;
}

let targetPath;
if (args.includes("--latest")) {
  const sessions = listSessions(false);
  if (!sessions.length) { console.error("No sessions found."); process.exit(1); }
  targetPath = sessions[0].path;
} else {
  // A positional arg that names a real file wins; otherwise treat the positional
  // OR --session <id> as a session locator and resolve it across profile homes.
  const sessionFlagIdx = args.indexOf("--session");
  const sessionArg = sessionFlagIdx >= 0 ? args[sessionFlagIdx + 1] : null;
  if (arg && existsSync(resolve(arg)) && statSync(resolve(arg)).isFile()) {
    targetPath = resolve(arg);
  } else {
    const locator = sessionArg || arg;
    if (!locator) {
      console.log("Usage: node analyze-claude-session.mjs <path.jsonl | sessionId | projectDir/sessionId> | --session <id> | --list [--worktrees] | --latest [--json]");
      process.exit(1);
    }
    const matches = findSessionByLocator(locator, args);
    if (!matches.length) {
      console.error(`No session found matching "${locator}" (searched all profile homes). Try --list to browse.`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`⚠ "${locator}" matched ${matches.length} sessions; using the most recent. Candidates:`);
      for (const m of matches.slice(0, 5)) {
        console.error(`    ${m.modified.toISOString().slice(0, 16)}  ${m.dir.slice(0, 48)}/${m.name.slice(0, 12)}`);
      }
    }
    targetPath = matches[0].path;
  }
}

const content = readFileSync(targetPath, "utf-8");
if (args.includes("--events")) {
  console.log(runEventsMode("claude", content, args));
} else if (jsonOut) {
  console.log(JSON.stringify(parseClaudeSession(content.split("\n")), null, 2));
} else {
  printSummary(parseClaudeSession(content.split("\n")));
}
