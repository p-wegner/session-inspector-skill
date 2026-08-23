#!/usr/bin/env node
/**
 * Learn the identity of a session we just spawned.
 *
 * `spawn.cmd` returns as soon as the tab is open — it cannot know the new session's
 * id, because `claude` has not started yet. But every Claude session registers on the
 * ACP bus from its SessionStart hook under `<cwd-slug>--<sid8>`, so the identity can
 * be read back from the roster. That is what makes a handoff verifiable rather than
 * hopeful: without it the launcher can only say "I opened a tab", never "your work is
 * now with <name>".
 *
 * Two modes, because the launcher has to snapshot BEFORE spawning:
 *
 *   node wait-for-agent.mjs --snapshot <file> --cwd <dir>
 *   node wait-for-agent.mjs --wait <file> --cwd <dir> [--timeout 90]
 *
 * `--wait` prints the newly-appeared agent's name on stdout (nothing else, so it can
 * be captured), a human summary on stderr, and exits 0. Exit 2 = timed out with no new
 * agent; exit 3 = the bus is unreachable. Both are reported, never papered over: a
 * handoff whose recipient cannot be named has not happened.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

const ACP_JS = process.env.ACP_JS || "C:/projects/andrena/acp/acp.js";
const cwdArg = flag("--cwd", process.cwd());
const timeoutSec = Number(flag("--timeout", "90")) || 90;

/** The same rule acp.js uses (acp.js:2194) — kept in sync deliberately, not guessed. */
function slugFor(dir) {
  return String(dir || "agent")
    .replace(/[^A-Za-z0-9]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48) || "agent";
}

/**
 * `acp list` has no --json mode (it ignores the flag), so parse its stable text form:
 *   "  <name> seen=<n>s ago"
 * Anything that does not match that shape is a banner line and is skipped — the same
 * banner-pollution trap that bites the kanban CLI's --json.
 */
function roster() {
  let out;
  try {
    out = execFileSync("node", [ACP_JS, "list"], {
      encoding: "utf8", timeout: 20000, windowsHide: true,
    });
  } catch (e) {
    return null;                       // bus unreachable / hub down
  }
  const names = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+seen=/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const snapshotPath = flag("--snapshot");
const waitPath = flag("--wait");

if (snapshotPath) {
  const names = roster();
  // A null roster is written as an empty baseline on purpose: if the bus is down now
  // and up later, "everything is new" is the safe direction — it can only make the
  // wait ambiguous, never make it claim a wrong recipient (an ambiguous result is
  // reported as ambiguous below).
  writeFileSync(resolve(snapshotPath), (names || []).join("\n"), "utf8");
  process.exit(0);
}

if (!waitPath) {
  process.stderr.write("usage: wait-for-agent.mjs (--snapshot <file> | --wait <file>) --cwd <dir> [--timeout N]\n");
  process.exit(64);
}

const before = new Set(
  existsSync(resolve(waitPath))
    ? readFileSync(resolve(waitPath), "utf8").split(/\r?\n/).filter(Boolean)
    : []
);
const prefix = slugFor(cwdArg) + "--";

const deadline = Date.now() + timeoutSec * 1000;
let lastErr = false;
while (Date.now() < deadline) {
  const names = roster();
  if (names === null) { lastErr = true; await sleep(2000); continue; }
  lastErr = false;
  const fresh = names.filter((n) => n.startsWith(prefix) && !before.has(n));
  if (fresh.length === 1) {
    process.stdout.write(fresh[0] + "\n");
    process.stderr.write(`[spawn] handed off to ${fresh[0]}\n`);
    process.exit(0);
  }
  if (fresh.length > 1) {
    // More than one new session appeared in the same repo while we waited — someone
    // else spawned one too. Naming the wrong recipient is worse than naming none, so
    // report the ambiguity and let a human pick.
    process.stderr.write(
      `[spawn] AMBIGUOUS: ${fresh.length} new sessions appeared under ${prefix}:\n` +
      fresh.map((n) => `    ${n}\n`).join("") +
      `[spawn] cannot say which one is yours - check the tab title.\n`);
    process.exit(2);
  }
  await sleep(1500);
}

process.stderr.write(
  lastErr
    ? `[spawn] the ACP bus is unreachable (${ACP_JS}); cannot confirm the new session's identity.\n`
    : `[spawn] timed out after ${timeoutSec}s: no new session registered under ${prefix}.\n` +
      `[spawn] the tab may still be starting, or this profile has no ACP SessionStart hook.\n`);
process.exit(lastErr ? 3 : 2);
