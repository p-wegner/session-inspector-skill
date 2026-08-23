#!/usr/bin/env node
/**
 * Write one argument to a file, verbatim.
 *
 *   node write-text.mjs --out <file> --text "<anything>"
 *
 * Exists so that prompt text NEVER travels on the `wt.exe` command line. Windows
 * Terminal treats `;` as its own command separator, and it does so *after* cmd and
 * PowerShell quoting have already been satisfied — so a perfectly-quoted prompt
 * containing a semicolon is torn in half and wt tries to execute the remainder as a
 * program. That is not hypothetical: the first handoff attempt failed with
 *
 *     Fehler 2147942402 (0x80070002) beim Start von `" the brief says how." -ProfileDir ...`
 *
 * because the default handoff prompt said "reachable over ACP; the brief says how".
 * Escaping `;` as `\;` would fix that one character and leave the class open. Passing a
 * FILE PATH is the fix that closes it: paths here contain nothing wt reinterprets, and
 * arbitrary prompt text — semicolons, quotes, ampersands, newlines, non-ASCII — rides
 * inside the file where no parser touches it.
 *
 * Prints the path it wrote, so the caller can capture it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const out = flag("--out");
// Not defaulted to "": an empty prompt and a missing --text are different mistakes, and
// silently writing an empty file would spawn a session with no instructions at all.
let text = flag("--text", null);
const useStdin = argv.includes("--stdin");

if (!out || (text === null && !useStdin)) {
  process.stderr.write('usage: write-text.mjs --out <file> (--text "<text>" | --stdin)\n');
  process.exit(64);
}

if (useStdin) {
  // Same rule as --text: an EMPTY read is a failure, not an empty prompt. A caller
  // whose stdin is the null device (any agent tool) would otherwise stage a blank
  // file and spawn a session with no instructions — the exact silent corruption
  // this script exists to prevent.
  try {
    const { readFileSync: rf } = await import("node:fs");
    text = rf(0, "utf8");
  } catch (e) {
    process.stderr.write(`[write-text] cannot read stdin: ${e.message}\n`);
    process.exit(65);
  }
  if (!String(text).trim()) {
    process.stderr.write("[write-text] stdin was empty — refusing to stage a blank prompt\n");
    process.exit(65);
  }
}

try {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), text, "utf8");
} catch (e) {
  process.stderr.write(`[write-text] cannot write ${out}: ${e.message}\n`);
  process.exit(4);
}
process.stdout.write(resolve(out) + "\n");
