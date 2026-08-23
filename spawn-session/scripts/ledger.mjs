#!/usr/bin/env node
/**
 * Append one line to the spawn ledger: who handed what work to whom.
 *
 * Why it exists: a handoff brief records only the SOURCE side (`**from session**`),
 * so nothing on disk said which session actually took the work. Session tooling
 * was left inferring it from text — a session that merely *mentions* another's id
 * looks identical to one that continued it, and acting on that guess HIDES real
 * cut-off work (measured: one fleet-tool run appeared to have continued nine
 * sessions at once). This file is the authoritative record that removes the guess.
 *
 * Read by session-inspector's `lib/successor.mjs` (ledger route, confidence 3).
 *
 * Usage:
 *   node ledger.mjs --source <sessionId> --repo <dir> [--profile <dir>]
 *                   [--agent <acp-name>] [--brief <path>] [--kind spawn|handoff|batch|resume]
 *                   [--resume-target <sessionId>]
 *
 * Never fails the caller: a launcher must not abort a good spawn because a log
 * line could not be written. Problems go to stderr and exit 0.
 */
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const argv = process.argv.slice(2);
const opt = (n, d = "") => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const dir = join(homedir(), ".spawn-session");
const path = join(dir, "ledger.jsonl");

const agent = opt("--agent");
// The ACP name is `<project-slug>--<sid8>`; the 8-hex tail is the new session's
// short id, which is enough to join back to its transcript.
const sid8 = (agent.match(/--([0-9a-f]{8})$/) || [])[1] || "";

const entry = {
  ts: new Date().toISOString(),
  kind: opt("--kind", "spawn"),
  sourceSessionId: opt("--source"),
  targetRepo: opt("--repo"),
  targetProfile: opt("--profile"),
  targetAgent: agent,
  targetSid8: sid8,
  // For a resume the "target" session is the SAME session being reopened, which
  // is exactly the case a successor lookup must not read as a handoff.
  targetSessionId: opt("--resume-target"),
  brief: opt("--brief"),
};

if (!entry.sourceSessionId && !entry.targetAgent && !entry.targetSessionId) {
  process.stderr.write("[ledger] nothing identifiable to record — skipped\n");
  process.exit(0);
}

try {
  mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  process.stderr.write(`[ledger] recorded ${entry.kind}: ${entry.sourceSessionId.slice(0, 8) || "?"} → ${entry.targetAgent || entry.targetSessionId || "?"}\n`);
} catch (e) {
  process.stderr.write(`[ledger] could not append (${e.message}) — continuing\n`);
}
process.exit(0);
