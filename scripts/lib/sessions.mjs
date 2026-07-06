/**
 * Shared session discovery + lightweight metadata extraction.
 *
 * Used by the sync client (sync-push.mjs) so that the metadata indexed on the
 * server is extracted the SAME way the analyzers read it. Node builtins only.
 *
 * A "session" is one transcript file:
 *   claude  -> ~/.claude/projects/<dir>/<uuid>.jsonl
 *   codex   -> ~/.codex/sessions/YYYY/MM/DD/<file>.jsonl
 *   copilot -> ~/.copilot/session-state/<uuid>/events.jsonl
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";

export const PROVIDERS = ["claude", "codex", "copilot"];

// ── Discovery ──────────────────────────────────────────────────────────────

function discoverClaude() {
  const base = join(homedir(), ".claude", "projects");
  const out = [];
  if (!existsSync(base)) return out;
  for (const dir of readdirSync(base)) {
    const dirPath = join(base, dir);
    let files;
    try { files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = join(dirPath, f);
      const st = statSync(p);
      out.push({ provider: "claude", path: p, sessionId: f.replace(/\.jsonl$/, ""), size: st.size, mtime: st.mtime });
    }
  }
  return out;
}

function discoverCodex() {
  const base = join(homedir(), ".codex", "sessions");
  const out = [];
  if (!existsSync(base)) return out;
  try {
    for (const year of readdirSync(base).filter((d) => /^\d{4}$/.test(d))) {
      const ydir = join(base, year);
      for (const month of readdirSync(ydir).filter((d) => /^\d{2}$/.test(d))) {
        const mdir = join(ydir, month);
        for (const day of readdirSync(mdir).filter((d) => /^\d{2}$/.test(d))) {
          const ddir = join(mdir, day);
          for (const f of readdirSync(ddir).filter((f) => f.endsWith(".jsonl"))) {
            const p = join(ddir, f);
            const st = statSync(p);
            out.push({ provider: "codex", path: p, sessionId: f.replace(/\.jsonl$/, ""), size: st.size, mtime: st.mtime });
          }
        }
      }
    }
  } catch { /* ignore partial trees */ }
  return out;
}

function discoverCopilot() {
  const base = join(homedir(), ".copilot", "session-state");
  const out = [];
  if (!existsSync(base)) return out;
  for (const dir of readdirSync(base)) {
    const full = join(base, dir);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    const eventsPath = join(full, "events.jsonl");
    if (!existsSync(eventsPath)) continue;
    const est = statSync(eventsPath);
    out.push({ provider: "copilot", path: eventsPath, sessionId: dir, size: est.size, mtime: est.mtime });
  }
  return out;
}

/** Discover all session files for one provider (or "all"). */
export function discover(provider = "all") {
  const all = [];
  if (provider === "all" || provider === "claude") all.push(...discoverClaude());
  if (provider === "all" || provider === "codex") all.push(...discoverCodex());
  if (provider === "all" || provider === "copilot") all.push(...discoverCopilot());
  return all.sort((a, b) => b.mtime - a.mtime);
}

// ── Lightweight metadata extraction (cheap, no full friction parse) ──────────

function firstLast(arr) {
  if (!arr.length) return { first: "", last: "" };
  return { first: arr[0], last: arr[arr.length - 1] };
}

function extractClaudeMeta(lines) {
  const m = { sessionId: "", cwd: "", model: "", startTime: "", endTime: "" };
  const prompts = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.timestamp) { if (!m.startTime) m.startTime = o.timestamp; m.endTime = o.timestamp; }
    if (o.sessionId && !m.sessionId) m.sessionId = o.sessionId;
    if (o.cwd && !m.cwd) m.cwd = o.cwd;
    if (o.type === "assistant" && o.message?.model) m.model = o.message.model;
    if (o.type === "user" && o.message) {
      const c = o.message.content;
      if (typeof c === "string") { if (!c.startsWith("<")) prompts.push(c); }
      else if (Array.isArray(c)) for (const b of c) if (b.type === "text" && b.text) prompts.push(b.text);
    }
  }
  const fl = firstLast(prompts);
  return { ...m, firstPrompt: fl.first, lastPrompt: fl.last };
}

function extractCodexMeta(lines) {
  const m = { sessionId: "", cwd: "", model: "", startTime: "", endTime: "" };
  const prompts = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.timestamp) { if (!m.startTime) m.startTime = o.timestamp; m.endTime = o.timestamp; }
    const p = o.payload || {};
    if (o.type === "session_meta") { m.sessionId = p.id || m.sessionId; m.cwd = p.cwd || m.cwd; }
    else if (o.type === "turn_context" && p.model) m.model = p.model;
    else if (o.type === "event_msg" && p.type === "user_message" && p.message) prompts.push(p.message);
  }
  const fl = firstLast(prompts);
  return { ...m, firstPrompt: fl.first, lastPrompt: fl.last };
}

function extractCopilotMeta(lines) {
  const m = { sessionId: "", cwd: "", model: "", startTime: "", endTime: "" };
  const prompts = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const d = o.data || {};
    if (o.timestamp) { if (!m.startTime) m.startTime = o.timestamp; m.endTime = o.timestamp; }
    if (o.type === "session.start") {
      m.sessionId = d.sessionId || m.sessionId;
      m.cwd = d.context?.cwd || m.cwd;
      m.startTime = d.startTime || m.startTime;
    } else if (o.type === "session.model_change") m.model = d.newModel || m.model;
    else if (o.type === "user.message" && d.content) prompts.push(d.content);
    else if (o.type === "assistant.message" && d.model && !m.model) m.model = d.model;
  }
  const fl = firstLast(prompts);
  return { ...m, firstPrompt: fl.first, lastPrompt: fl.last };
}

/** Extract index metadata from a session file's content for a given provider. */
export function extractMeta(provider, content) {
  const lines = content.split("\n");
  if (provider === "claude") return extractClaudeMeta(lines);
  if (provider === "codex") return extractCodexMeta(lines);
  if (provider === "copilot") return extractCopilotMeta(lines);
  return { sessionId: "", cwd: "", model: "", startTime: "", endTime: "", firstPrompt: "", lastPrompt: "" };
}

// ── Project identity (robust across machines via git remote) ─────────────────

/** Normalize a git remote URL to a stable cross-machine key, e.g. github.com/p-wegner/acp. */
export function normalizeRemote(url) {
  if (!url) return "";
  let s = url.trim();
  s = s.replace(/^git\+/, "");
  // git@host:owner/repo.git  ->  host/owner/repo
  const scp = s.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z]+:\/\//i, "").replace(/^[^@/]+@/, ""); // strip scheme + creds
  s = s.replace(/\.git$/, "").replace(/\/+$/, "");
  return s.toLowerCase();
}

const remoteCache = new Map();

/** Resolve the origin remote for a working directory (cached). "" if not a repo / git missing. */
export function gitRemote(cwd) {
  if (!cwd || !existsSync(cwd)) return "";
  if (remoteCache.has(cwd)) return remoteCache.get(cwd);
  let remote = "";
  try {
    remote = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
  } catch { /* not a repo or no origin */ }
  remoteCache.set(cwd, remote);
  return remote;
}

/** Build {gitRemote, projectKey, project} for a session's cwd. Falls back to path when no remote. */
export function projectIdentity(cwd) {
  const remote = gitRemote(cwd);
  const key = remote ? normalizeRemote(remote) : (cwd ? cwd.replace(/\\/g, "/").toLowerCase() : "unknown");
  // Display: last 2 segments of the key, or cwd basename.
  const parts = key.split("/").filter(Boolean);
  const project = remote
    ? parts.slice(-2).join("/")
    : (cwd ? basename(cwd) : "unknown");
  return { gitRemote: remote, projectKey: key, project };
}

export function readFile(path) {
  return readFileSync(path, "utf-8");
}
