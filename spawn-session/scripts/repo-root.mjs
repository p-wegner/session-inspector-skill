// repo-root.mjs — where this checkout's SIBLING repos are, without naming one machine.
//
// `spawn` resolves a bare name (`code-metrics`) to a directory, and two helpers shell out to
// neighbouring repos (`acp`, `claude-pick`). All three used to carry one developer's absolute
// path, which made the tool work on exactly one box and published that box's layout.
//
// The root is derived, not configured: this file sits at
// `<root>/<checkout>/spawn-session/scripts/`, so three levels up is the folder that holds the
// checkout and its siblings. `realpathSync` first, because every skill dir here is junctioned
// into several Claude profiles — without it the root would come out as `~/.claude/skills`.
//
// `SPAWN_ROOT` overrides it, for a layout where the siblings are not siblings. Nothing here
// falls back to a guess: a helper returns the path it computed, and the caller reports it when
// the file is not there, so a wrong root names itself instead of failing obscurely.

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The directory holding this checkout and its sibling repos. */
export function cloneRoot() {
  if (process.env.SPAWN_ROOT) return resolve(process.env.SPAWN_ROOT);
  let here = dirname(fileURLToPath(import.meta.url));
  try { here = realpathSync(here); } catch { /* not junctioned, or already real */ }
  return resolve(here, "..", "..", "..");
}

/** A sibling repo path under the clone root — always a string, `.exists` says whether it is there. */
export function sibling(...parts) {
  const path = join(cloneRoot(), ...parts);
  return { path, exists: existsSync(path) };
}

/** The ACP client. `ACP_JS` wins, so a checkout elsewhere needs no root override. */
export function acpJs() {
  return process.env.ACP_JS || sibling("acp", "acp.js").path;
}

/** claude-pick's fleet launcher. `FLEET_CMD` wins, same reason. */
export function fleetCmd() {
  return process.env.FLEET_CMD || sibling("claude-pick", "fleet", "fleet.cmd").path;
}

// `node repo-root.mjs --print` — so spawn.cmd derives the root by the SAME rule rather than a
// second one in batch syntax. cmd's `%~dp0` does not dereference a junction and this does, which
// is exactly the case a per-profile skill link produces.
if (process.argv[2] === "--print") process.stdout.write(cloneRoot() + "\n");
