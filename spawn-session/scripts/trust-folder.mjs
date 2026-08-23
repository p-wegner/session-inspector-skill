#!/usr/bin/env node
/**
 * Pre-accept the "Do you trust the files in this folder?" dialog for one folder in one
 * Claude profile.
 *
 * Why this exists: that dialog is a BLOCKING first-run prompt, and it fires per
 * (profile, folder). Spawning into a profile that has never opened the target repo —
 * exactly the case when handing work to another subscription — parks the new session
 * on a question nobody is watching, which silently converts an unattended handoff into
 * a hang. Observed on first real use.
 *
 *   node trust-folder.mjs --config-dir <profile dir> --path <repo> [--check]
 *
 * The flag lives at `projects["<path>"].hasTrustDialogAccepted` in
 * `<config dir>/.claude.json`, keyed by the path with FORWARD slashes.
 *
 * Written in node, deliberately, and not in the surrounding PowerShell: PS 5.1's
 * `ConvertTo-Json` defaults to `-Depth 2`, so a round-trip through it would silently
 * truncate a deeply-nested 60-100 KB config into rubbish. `JSON.parse`/`stringify` has
 * no depth limit and preserves everything it did not touch.
 *
 * Exit: 0 = trusted (already, or now). 1 = --check and not trusted. 4 = could not read
 * or write. Never silently succeeds — a "handoff" into a blocked prompt is worse than a
 * refusal, because the launcher would report success.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const configDir = flag("--config-dir");
const target = flag("--path");
const checkOnly = argv.includes("--check");

if (!configDir || !target) {
  process.stderr.write("usage: trust-folder.mjs --config-dir <dir> --path <repo> [--check]\n");
  process.exit(64);
}

/** Claude Code keys `projects` by absolute path with forward slashes, no trailing slash. */
const key = resolve(target).replace(/\\/g, "/").replace(/\/+$/, "");
const file = join(configDir, ".claude.json");

let doc = {};
let existed = false;
if (existsSync(file)) {
  existed = true;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    // A corrupt config is not ours to repair, and rewriting it from scratch would
    // discard the user's whole configuration.
    process.stderr.write(`[trust] cannot parse ${file}: ${e.message}\n`);
    process.exit(4);
  }
}
if (!doc || typeof doc !== "object") doc = {};
if (!doc.projects || typeof doc.projects !== "object") doc.projects = {};

const entry = doc.projects[key];
const already = !!(entry && entry.hasTrustDialogAccepted === true);

if (checkOnly) {
  process.stdout.write(already ? "trusted\n" : "untrusted\n");
  process.exit(already ? 0 : 1);
}
if (already) {
  // stdout, not stderr: a PowerShell caller that redirects a native command's stderr
  // with 2>&1 turns each line into an ErrorRecord, which THROWS under
  // $ErrorActionPreference='Stop'. This very success message did that and killed the
  // launcher before it ever reached `claude`. Status belongs on stdout.
  process.stdout.write(`already-trusted ${key}\n`);
  process.exit(0);
}

// Merge into whatever is there — an entry can already exist with the flag false (that
// is what an earlier declined or unanswered dialog leaves behind), and it carries
// sibling state such as allowedTools that must survive.
doc.projects[key] = { ...(entry && typeof entry === "object" ? entry : {}), hasTrustDialogAccepted: true };

try {
  if (existed) {
    // Keep one backup. This file is also written by any LIVE session in the same
    // profile, so a concurrent write can lose one of the two — best effort, and the
    // backup is what makes that recoverable rather than merely regrettable.
    copyFileSync(file, file + ".spawn-session.bak");
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  const tmp = file + ".spawn-session.tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  renameSync(tmp, file);                       // atomic: no half-written config
} catch (e) {
  process.stderr.write(`[trust] cannot write ${file}: ${e.message}\n`);
  process.exit(4);
}

process.stdout.write(`accepted ${key}${existed ? "" : " (created .claude.json)"}\n`);
process.exit(0);
