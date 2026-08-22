#!/usr/bin/env node
/**
 * Write the handoff brief the spawned session reads first.
 *
 *   node make-handoff.mjs --session <id> --config-dir <profile> --target <repo>
 *                         [--note "..."] [--out <file>]
 *
 * The point of a handoff (as opposed to just starting a session in a repo) is that the
 * new session should not have to rediscover what the old one already knew. Two sources,
 * in descending order of reliability:
 *
 *   1. `--note` — what the outgoing session says it was doing. Highest value, because
 *      only it knows the intent behind the diff.
 *   2. `session-inspector`'s `--handoff` panel, if that skill is installed: the
 *      MACHINE state — background processes still running, monitors armed, the scratchpad
 *      (OS-clearable, so it names what must be salvaged), the last TodoWrite, subagents
 *      whose results were never adjudicated. A continuation that re-runs work that
 *      already finished in a detached process is the failure this prevents.
 *
 * Written to a DURABLE location, never %TEMP%: the brief outlives the session that
 * wrote it by design, and session-inspector's own docs warn that the scratchpad is
 * OS-clearable storage.
 *
 * Best effort by construction — a missing analyzer degrades to "note + git state" and
 * SAYS SO in the file. A brief that silently omits half of what it promised is worse
 * than a short one that is honest about its sources.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const sessionId = flag("--session", "");
const configDir = flag("--config-dir", process.env.CLAUDE_CONFIG_DIR || "");
const target = flag("--target", process.cwd());
const note = flag("--note", "");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const slug = resolve(target).replace(/[^A-Za-z0-9]/g, "-").replace(/^-+/, "").slice(0, 48);
const outPath = resolve(flag("--out") || join(homedir(), ".spawn-session", "handoffs", `${stamp}--${slug}.md`));

function tryExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8", timeout: opts.timeout || 60000, windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    return null;
  }
}

/** session-inspector is junctioned per profile; look under the launching profile first. */
function findAnalyzer() {
  const candidates = [];
  if (configDir) candidates.push(join(configDir, "skills", "session-inspector", "scripts", "analyze-claude-session.mjs"));
  candidates.push(join(homedir(), ".claude", "skills", "session-inspector", "scripts", "analyze-claude-session.mjs"));
  return candidates.find((p) => existsSync(p)) || null;
}

const parts = [];
const sources = [];

parts.push(`# Handoff brief`);
parts.push(``);
parts.push(`- **written**: ${new Date().toISOString()}`);
parts.push(`- **from session**: \`${sessionId || "unknown"}\``);
// The caller's profile is only the SOURCE session's profile when the source is
// the caller. With `-from <id>` (handing over someone else's cut-off session) it
// usually is not — that session lives wherever it ran, which is often a different
// account, since the reason it was cut off is that its own account ran out. So
// verify rather than assert: a wrong profile line in a brief is the kind of detail
// a reader trusts and then cannot resume with.
const sessionLivesHere = Boolean(sessionId) && Boolean(configDir)
  && existsSync(join(configDir, "projects"))
  && readdirSync(join(configDir, "projects")).some((d) => {
    try { return readdirSync(join(configDir, "projects", d)).some((f) => f.startsWith(sessionId)); }
    catch { return false; }
  });
parts.push(`- **from profile**: ${sessionLivesHere ? `\`${configDir}\`` : (configDir
  ? `not \`${configDir}\` — this session lives under another profile (resolved by id)`
  : "unknown")}`);
parts.push(`- **target repo**: \`${resolve(target)}\``);
parts.push(``);
parts.push(`> You are picking up work another session was doing. Read this, then confirm`);
parts.push(`> the state yourself before changing anything — every claim below is the`);
parts.push(`> outgoing session's word, not a verified fact.`);
parts.push(``);

if (note) {
  parts.push(`## What the outgoing session says it was doing`);
  parts.push(``);
  parts.push(note);
  parts.push(``);
  sources.push("outgoing session's note");
}

// Git state of the target, so the incoming session sees the tree it is inheriting
// without having to ask. Cheap, and it is the one thing that is a fact rather than a claim.
const branch = tryExec("git", ["-C", resolve(target), "rev-parse", "--abbrev-ref", "HEAD"]);
const status = tryExec("git", ["-C", resolve(target), "status", "--porcelain"]);
const log = tryExec("git", ["-C", resolve(target), "log", "--oneline", "-8"]);
if (branch || status !== null || log) {
  parts.push(`## Target repo state (measured just now)`);
  parts.push(``);
  parts.push(`- branch: \`${(branch || "?").trim()}\``);
  const dirty = (status || "").split(/\r?\n/).filter(Boolean);
  parts.push(`- uncommitted files: **${dirty.length}**`);
  if (dirty.length) {
    parts.push(``);
    parts.push("```");
    parts.push(dirty.slice(0, 40).join("\n"));
    if (dirty.length > 40) parts.push(`... and ${dirty.length - 40} more`);
    parts.push("```");
  }
  if (log) {
    parts.push(``);
    parts.push(`Recent commits:`);
    parts.push(``);
    parts.push("```");
    parts.push(log.trim());
    parts.push("```");
  }
  parts.push(``);
  sources.push("git state of the target repo");
}

const analyzer = findAnalyzer();
if (analyzer && sessionId) {
  const panel = tryExec("node", [analyzer, sessionId, "--handoff"], { timeout: 120000 });
  if (panel && panel.trim()) {
    parts.push(`## Machine state left behind by the outgoing session`);
    parts.push(``);
    parts.push(`From \`session-inspector --handoff\`. Read the background/detached processes`);
    parts.push(`first: a detached driver often FINISHED the work after the hand-off was`);
    parts.push(`decided, so check its log before redoing anything. The scratchpad is`);
    parts.push(`OS-clearable — salvage anything load-bearing out of it.`);
    parts.push(``);
    parts.push("```");
    parts.push(panel.trim());
    parts.push("```");
    parts.push(``);
    sources.push("session-inspector --handoff panel");
  } else {
    parts.push(`## Machine state: NOT captured`);
    parts.push(``);
    parts.push(`\`session-inspector --handoff\` was found at \`${analyzer}\` but produced`);
    parts.push(`nothing usable for session \`${sessionId}\`. Background processes, armed`);
    parts.push(`monitors and unadjudicated subagent results are therefore **unknown** —`);
    parts.push(`check them by hand before assuming nothing is running.`);
    parts.push(``);
  }
} else {
  parts.push(`## Machine state: NOT captured`);
  parts.push(``);
  parts.push(analyzer
    ? `No session id was passed, so the outgoing session's machine state could not be read.`
    : `\`session-inspector\` is not installed in this profile, so the outgoing session's`
      + ` background processes, armed monitors, scratchpad and subagent results are **unknown**.`);
  parts.push(`Do not assume nothing is running.`);
  parts.push(``);
}

parts.push(`## Sources in this brief`);
parts.push(``);
parts.push(sources.length ? sources.map((s) => `- ${s}`).join("\n") : `- none (empty brief)`);
parts.push(``);
parts.push(`## Reaching the outgoing session`);
parts.push(``);
parts.push(`It may still be open. Over the ACP bus:`);
parts.push(``);
parts.push("```");
parts.push(`node "C:/projects/andrena/acp/acp.js" list`);
parts.push(`node "C:/projects/andrena/acp/acp.js" send --to <its-name> --msg "..."`);
parts.push("```");
parts.push(``);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, parts.join("\n"), "utf8");
process.stdout.write(outPath + "\n");
process.stderr.write(`[handoff] wrote ${outPath} (${sources.length} source(s))\n`);
