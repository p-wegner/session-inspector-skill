/**
 * locate.mjs — resolve a session locator to a transcript path, across every
 * `~/.claude*` profile home.
 *
 * The same resolution the single-session analyzers do (bare id, id prefix,
 * `<folder>/<id>` in either order, a path, `--latest`), lifted out so a new tool
 * does not have to re-implement it. Profiles are a PREFERENCE, never a filter:
 * `--profile` only breaks ties.
 *
 * Node builtins only.
 */

import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join, resolve, basename } from "path";
import { homedir } from "os";
import { claudeProjectDirs } from "./config.mjs";
import { locatorCandidates } from "./sessions.mjs";

export function listAllSessions() {
  const out = [];
  for (const base of claudeProjectDirs()) {
    let dirs; try { dirs = readdirSync(base); } catch { continue; }
    for (const dir of dirs) {
      const dp = join(base, dir);
      let files; try { files = readdirSync(dp).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        const p = join(dp, f);
        let mtime; try { mtime = statSync(p).mtime; } catch { continue; }
        out.push({ path: p, id: f.replace(/\.jsonl$/, ""), project: dir, mtime });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * @param {string|null} locator  path | sessionId | id-prefix | dir/id | null
 * @param {object} opts  { latest, profile, configDir }
 * @returns {string} absolute transcript path
 */
export function resolveTranscript(locator, { latest = false, profile = null, configDir = null } = {}) {
  if (latest) {
    const all = listAllSessions();
    if (!all.length) throw new Error("No sessions found in any profile home.");
    return all[0].path;
  }
  if (!locator) throw new Error("No session given. Pass a path, a session id, or --latest.");
  const asPath = resolve(locator);
  if (existsSync(asPath) && statSync(asPath).isFile()) return asPath;

  const all = listAllSessions();
  const preferLeaf = configDir ? basename(configDir).toLowerCase()
    : profile ? `.claude-${profile}`.toLowerCase() : null;
  let pool = [];
  for (const { idPart, dirPart } of locatorCandidates(locator)) {
    const exact = [], prefix = [];
    for (const s of all) {
      if (s.id === idPart) exact.push(s);
      else if (idPart && s.id.startsWith(idPart)) prefix.push(s);
    }
    pool = exact.length ? exact : prefix;
    const inDir = dirPart ? pool.filter((s) => s.path.toLowerCase().includes(dirPart.toLowerCase())) : [];
    if (inDir.length) pool = inDir;
    if (pool.length) break;
  }
  if (!pool.length) throw new Error(`No session matching "${locator}" (searched all profile homes).`);
  if (preferLeaf && pool.length > 1)
    pool.sort((a, b) => (a.path.toLowerCase().includes(preferLeaf) ? 0 : 1) - (b.path.toLowerCase().includes(preferLeaf) ? 0 : 1));
  return pool[0].path;
}

export function readLines(path) {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
}

/** Standard flag plumbing shared by the new single-session tools. */
export function parseArgs(argv, valueFlags = []) {
  const VALUE = new Set(["--profile", "--config-dir", "-o", "--out", "--lens", "--top", "--bucket", ...valueFlags]);
  const has = (f) => argv.includes(f);
  const val = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : null);
  const positional = argv.find((a, i) => !a.startsWith("-") && !VALUE.has(argv[i - 1]));
  return { has, val, positional };
}

export function configDirFrom(has, val) {
  if (has("--config-dir") && val("--config-dir")) return val("--config-dir");
  if (has("--profile") && val("--profile")) return join(homedir(), `.claude-${val("--profile")}`);
  return null;
}
