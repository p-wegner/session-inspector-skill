/** Shared config for the session-sync server + clients. Host-agnostic. */
import { join, basename, dirname } from "path";
import { homedir, hostname, userInfo } from "os";
import { existsSync, readdirSync, statSync } from "fs";

export const DEFAULT_PORT = 8765;

/**
 * Claude Code reads its home from CLAUDE_CONFIG_DIR; when unset it defaults to
 * ~/.claude. Teams / parallel setups run with a per-profile config dir — a
 * SIBLING of ~/.claude such as ~/.claude-acme_team — so transcripts land
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
 *   ~/.claude-acme_team_2/projects          -> "acme_team_2"
 *
 * A profile is a separate *account*, so this is the field you filter on when
 * bundling "everything that ran under my work subscriptions". Dirs reached via
 * $CLAUDE_PROJECT_DIRS that don't follow the convention fall back to the dir name.
 */
export function profileOfProjectsDir(dir) {
  const home = basename(dirname(dir));
  if (home === ".claude") return "default";
  const m = home.match(/^\.claude[-_](.+)$/);
  return m ? m[1] : home;
}

/**
 * Every AUTH PROFILE on this box that has transcripts — the sibling config dirs
 * `~/.claude-<suffix>` / `~/.claude_<suffix>`, as bare suffixes.
 *
 * This used to be copy-pasted into the quota tools as a literal
 * `/^\.claude-(<one team's profile prefix>.*)$/`, which meant they found nothing at
 * all on any machine but the author's and exited 1 with "no profiles found". The
 * discovery rule is the same convention `claudeProjectDirs()` already implements,
 * so it belongs here once rather than in each caller with a different hard-coded
 * family baked in.
 *
 *   includeDefault  also return the personal `~/.claude` as "default". Off by
 *                   default: the quota views are about *accounts you pay for
 *                   separately*, and the personal profile is deliberately excluded.
 *
 * $CLAUDE_PROFILES (comma-separated) overrides discovery entirely — the escape
 * hatch for a layout this convention does not describe, and the portable
 * replacement for editing the regex.
 */
export function authProfiles({ includeDefault = false } = {}) {
  const env = (process.env.CLAUDE_PROFILES || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  const out = [];
  for (const dir of claudeProjectDirs()) {
    const p = profileOfProjectsDir(dir);
    if (p === "default" && !includeDefault) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * A display shortener for a set of profile names: strips the longest common
 * prefix, so `acme_team_5x` / `acme_team_5x_2` render as `5x` / `5x_2` without
 * anyone hard-coding what the shared part is. One profile keeps its full name —
 * there is no common prefix to remove, and a lone empty label is useless.
 */
export function profileShortener(profiles) {
  const names = [...profiles];
  if (names.length < 2) return (n) => n;
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  // only cut on a separator, so `acme_team_5x`/`acme_team_9` never becomes `x`/`9`
  const cut = Math.max(prefix.lastIndexOf("_"), prefix.lastIndexOf("-"));
  const at = cut >= 0 ? cut + 1 : 0;
  return (n) => (at && n.length > at ? n.slice(at) : n);
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
