/** Shared config for the session-sync server + clients. Host-agnostic. */
import { join, basename, dirname } from "path";
import { homedir, hostname, userInfo } from "os";
import { existsSync, readdirSync, statSync } from "fs";

export const DEFAULT_PORT = 8765;

/**
 * Claude Code reads its home from CLAUDE_CONFIG_DIR; when unset it defaults to
 * ~/.claude. Teams / parallel setups run with a per-profile config dir — a
 * SIBLING of ~/.claude such as ~/.claude-andrena_team_5x — so transcripts land
 * under ~/.claude-<suffix>/projects, invisible to any tool that hard-codes
 * ~/.claude/projects. This helper returns EVERY Claude projects dir on the box.
 *
 * Order of precedence (all deduped, only existing dirs returned):
 *   1. $CLAUDE_PROJECT_DIRS  — explicit, os-pathsep-separated list of projects dirs
 *   2. $CLAUDE_CONFIG_DIR/projects and $CLAUDE_HOME/projects — the active profile
 *   3. ~/.claude/projects plus every sibling profile home (~/.claude-<suffix>, ~/.claude_<suffix>)
 *
 * Set CLAUDE_PROJECT_DIRS to bypass discovery entirely (e.g. a synced/mounted copy).
 */
export function claudeProjectDirs() {
  const out = [];
  const push = (d) => { if (d && existsSync(d) && !out.includes(d)) out.push(d); };

  const explicit = process.env.CLAUDE_PROJECT_DIRS;
  if (explicit) {
    for (const p of explicit.split(/[;:]/).map((s) => s.trim()).filter(Boolean)) push(p);
    if (out.length) return out;
  }

  for (const env of [process.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_HOME]) {
    if (env) push(join(env, "projects"));
  }

  const home = homedir();
  push(join(home, ".claude", "projects"));
  // Sibling profile homes: ~/.claude-<suffix> or ~/.claude_<suffix>
  try {
    for (const entry of readdirSync(home)) {
      if (!/^\.claude[-_].+/.test(entry)) continue;
      let st; try { st = statSync(join(home, entry)); } catch { continue; }
      if (st.isDirectory()) push(join(home, entry, "projects"));
    }
  } catch { /* home unreadable — ignore */ }

  return out;
}

/**
 * Which auth profile a Claude projects dir belongs to — the config-dir name with
 * the `.claude` prefix stripped:
 *
 *   ~/.claude/projects                      -> "default"
 *   ~/.claude-andrena_team_5x_2/projects    -> "andrena_team_5x_2"
 *
 * A profile is a separate *account*, so this is the field you filter on when
 * bundling "everything that ran under my andrena subscriptions". Dirs reached via
 * $CLAUDE_PROJECT_DIRS that don't follow the convention fall back to the dir name.
 */
export function profileOfProjectsDir(dir) {
  const home = basename(dirname(dir));
  if (home === ".claude") return "default";
  const m = home.match(/^\.claude[-_](.+)$/);
  return m ? m[1] : home;
}

/**
 * Which human this corpus belongs to. Device tags separate *machines*; this
 * separates *people*, so transcripts pooled from several developers stay
 * attributable (and can't collide on a shared sessionId).
 * Override with SESSION_SYNC_USER or --user.
 */
export function userName(argv = []) {
  const i = argv.indexOf("--user");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.SESSION_SYNC_USER) return process.env.SESSION_SYNC_USER;
  try { return userInfo().username; } catch { return "unknown"; }
}

/** Server base URL clients talk to. Override with SESSION_SYNC_URL or --server. */
export function serverUrl(argv = []) {
  const i = argv.indexOf("--server");
  if (i >= 0 && argv[i + 1]) return argv[i + 1].replace(/\/$/, "");
  if (process.env.SESSION_SYNC_URL) return process.env.SESSION_SYNC_URL.replace(/\/$/, "");
  return `http://127.0.0.1:${DEFAULT_PORT}`;
}

/** Where the SERVER persists uploaded sessions + index. Override with SESSION_SYNC_DATA. */
export function dataDir() {
  return process.env.SESSION_SYNC_DATA || join(homedir(), ".session-sync");
}

/** This machine's device tag. Override with SESSION_SYNC_DEVICE or --device. */
export function deviceName(argv = []) {
  const i = argv.indexOf("--device");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.SESSION_SYNC_DEVICE || hostname();
}

/** Read a --flag value from argv, or undefined. */
export function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
