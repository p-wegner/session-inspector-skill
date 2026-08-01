/**
 * Zip create/extract for session bundles.
 *
 * Node has no builtin zip, and a bundle is meant to be handed to another person
 * (possibly on another OS) who just double-clicks it — so we shell out to
 * whatever archiver the platform already ships rather than inventing a format:
 *
 *   Windows 10 1803+/11 : bsdtar (`tar`) reads AND writes zip via `-a` / `-x`
 *   macOS               : bsdtar too, plus `zip`/`unzip`
 *   Linux               : GNU tar canNOT do zip -> `zip`/`unzip` (usually present)
 *
 * Every helper degrades loudly: if no archiver is found the caller is told to
 * use the plain directory form (`--format dir`), which always works.
 */

import { spawnSync } from "child_process";
import { existsSync, rmSync, mkdirSync } from "fs";
import { dirname, basename, resolve } from "path";
import { platform } from "os";

const isWin = platform() === "win32";

function have(cmd) {
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return !probe.error;
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
  if (r.error) return { ok: false, err: r.error.message };
  if (r.status !== 0) return { ok: false, err: (r.stderr || r.stdout || `exit ${r.status}`).trim() };
  return { ok: true };
}

/**
 * Zip `srcDir` so the archive contains ONE top-level folder named after it
 * (`bundle.zip` -> `bundle/manifest.json`, …). Extracting can never splatter
 * files into the recipient's cwd.
 */
export function zipDir(srcDir, outZip) {
  const src = resolve(srcDir);
  const out = resolve(outZip);
  const parent = dirname(src);
  const name = basename(src);
  if (existsSync(out)) rmSync(out, { force: true });

  // bsdtar picks the format from the extension with -a; GNU tar would silently
  // write a .zip-named tarball instead, so only trust it where bsdtar ships.
  const attempts = isWin
    ? [["tar", ["-a", "-c", "-f", out, "-C", parent, name]]]
    : [["zip", ["-q", "-r", out, name]], ["tar", ["-a", "-c", "-f", out, "-C", parent, name]]];

  const errs = [];
  for (const [cmd, args] of attempts) {
    if (!have(cmd)) { errs.push(`${cmd}: not found`); continue; }
    const r = run(cmd, args, cmd === "zip" ? parent : undefined);
    if (r.ok) return { ok: true, tool: cmd, path: out };
    errs.push(`${cmd}: ${r.err}`);
  }
  return { ok: false, err: `no working archiver (${errs.join("; ")}). Re-run with --format dir.` };
}

/** Extract a zip into `destDir` (created if absent). Returns {ok, tool} or {ok:false, err}. */
export function unzipTo(zipPath, destDir) {
  const zip = resolve(zipPath);
  const dest = resolve(destDir);
  mkdirSync(dest, { recursive: true });

  const attempts = isWin
    ? [["tar", ["-x", "-f", zip, "-C", dest]]]
    : [["unzip", ["-q", "-o", zip, "-d", dest]], ["tar", ["-x", "-f", zip, "-C", dest]]];

  const errs = [];
  for (const [cmd, args] of attempts) {
    if (!have(cmd)) { errs.push(`${cmd}: not found`); continue; }
    const r = run(cmd, args);
    if (r.ok) return { ok: true, tool: cmd, path: dest };
    errs.push(`${cmd}: ${r.err}`);
  }
  return { ok: false, err: `cannot extract ${zip} (${errs.join("; ")})` };
}
