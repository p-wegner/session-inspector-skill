#!/usr/bin/env node
/**
 * Stage ALL launch parameters for spawn-session.ps1 into one JSON file and print
 * its path. spawn.cmd then passes only that single path across cmd -> wt.exe ->
 * PowerShell.
 *
 * Why a file: wt.exe re-splits its command line on ';' after cmd quoting is already
 * satisfied, and an empty `-Foo ""` loses its quotes crossing the layers, so the
 * .ps1 eats the NEXT switch as its value. Both failure modes are documented in
 * spawn.cmd from real launches; on 2026-08-25 a handoff's seeded sessions came up
 * without ever taking their first turn - prompt and profile lost somewhere in that
 * chain - and the workaround was a hand-rolled self-contained launcher. This makes
 * that design the normal path: a file path is inert to every layer, so nothing else
 * crosses wt as an argument.
 *
 * Usage: node stage-launch.mjs [--out <file>] --path <dir> [--prompt-file <f>]
 *          [--profile-dir <p>] [--session-id <id>] [--launch-config-dir <p>]
 *          [--resume-id <id>] [--no-prompt] [--safe] [--detect] [--no-trust]
 *          [-- forwarded claude args...]
 * Prints the JSON file's path on stdout; exits 1 without writing on a bad call.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const argv = process.argv.slice(2);
const out = {};
const forward = [];
let outPath = "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  // a following token that is itself a flag means "no value": PowerShell drops
  // empty "" arguments from native command lines entirely, so `--session-id ""`
  // arrives as `--session-id --launch-config-dir` and must not eat the next flag
  const val = () => {
    const n = argv[i + 1];
    if (n === undefined || n.startsWith("--")) return "";
    i++; return n;
  };
  if (a === "--") { forward.push(...argv.slice(i + 1)); break; }
  else if (a === "--out") outPath = val();
  else if (a === "--path") out.path = val();
  else if (a === "--prompt-file") out.promptFile = val();
  else if (a === "--profile-dir") out.profileDir = val();
  else if (a === "--session-id") out.sessionId = val();
  else if (a === "--launch-config-dir") out.launchConfigDir = val();
  else if (a === "--resume-id") out.resumeId = val();
  else if (a === "--no-prompt") out.noPrompt = true;
  else if (a === "--safe") out.safeMode = true;
  else if (a === "--detect") out.detectOnly = true;
  else if (a === "--no-trust") out.noTrust = true;
  else forward.push(a);
}
// cmd expands an undefined %VAR% inside quotes to "", so empty strings are the
// normal spelling of "not given" - drop them rather than making the .ps1 test each
for (const k of Object.keys(out)) if (out[k] === "") delete out[k];
if (forward.length) out.forward = forward;
if (!out.path) { process.stderr.write("stage-launch: --path is required\n"); process.exit(1); }
if (!outPath) outPath = join(tmpdir(), `spawn-launch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
try {
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
} catch (e) {
  process.stderr.write(`stage-launch: cannot write ${outPath}: ${e.message}\n`);
  process.exit(1);
}
process.stdout.write(outPath + "\n");
