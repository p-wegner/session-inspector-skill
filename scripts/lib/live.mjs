/**
 * Live-session primitives: who is running RIGHT NOW, and is it working or waiting?
 *
 * Everything else in this skill is post-hoc — it reads transcripts of sessions that
 * already happened. This module answers the live question, and it does so from a
 * source most tooling doesn't know exists:
 *
 *   <CLAUDE_CONFIG_DIR>/sessions/<PID>.json
 *
 * Claude Code writes one such file per running CLI process and deletes it on exit.
 * It carries pid, sessionId, cwd, a friendly name, and — the useful bit — a live
 * `status` field ("busy" | "idle" | "shell") with an `updatedAt` heartbeat. The
 * PROFILE is simply whichever config dir the file was found in, so no environment
 * inspection is needed (and none is possible: reading another process's env on
 * Windows requires PEB spelunking, and the obvious PowerShell approach silently
 * returns your OWN environment instead).
 *
 * Registry files are deleted on graceful exit but NOT on kill, so a crashed session
 * leaves a stale file behind forever. Callers must cross-check `pid` against the
 * live process table — see liveClaudePids() — or their fleet counts inflate silently.
 */
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { existsSync, readdirSync, statSync, readFileSync, openSync, readSync, closeSync, fstatSync } from "fs";
import { execFileSync } from "child_process";

/** Registry `status` values that mean "an agent is doing work right now". */
export const BUSY_STATUSES = new Set(["busy"]);

/**
 * Transcript entry types that carry no timestamp and are rewritten in place as a
 * session runs. They tell you nothing about progress, so the tail walk must skip
 * them — a transcript whose last line is `last-prompt` may be mid-tool-call.
 */
const SENTINEL_TYPES = new Set([
  "last-prompt", "mode", "permission-mode", "ai-title", "queue-operation", "attachment",
]);

/**
 * Every Claude profile home on this box: ~/.claude plus sibling ~/.claude-<suffix>
 * dirs. Mirrors the discovery in config.mjs::claudeProjectDirs(), but returns the
 * profile ROOT rather than its projects/ subdir, because callers here need
 * sessions/, projects/ and .credentials.json from the same root.
 *
 * Returns [{ id, dir }] with the main profile first. `id` is "default" for
 * ~/.claude and the suffix otherwise (e.g. "andrena_team_5x_2").
 */
export function claudeProfileHomes() {
  const out = [];
  const push = (id, dir) => {
    if (!dir || !existsSync(dir)) return;
    if (out.some((p) => p.dir === dir)) return;
    out.push({ id, dir });
  };

  const home = homedir();
  push("default", join(home, ".claude"));

  try {
    for (const entry of readdirSync(home)) {
      if (!/^\.claude[-_].+/.test(entry)) continue;
      const dir = join(home, entry);
      let st; try { st = statSync(dir); } catch { continue; }
      if (st.isDirectory()) push(entry.replace(/^\.claude[-_]/, ""), dir);
    }
  } catch { /* home unreadable — degrade to whatever we already have */ }

  // An explicitly-set config dir may live outside the sibling convention entirely.
  for (const env of [process.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_HOME]) {
    if (env) push(basename(env).replace(/^\.claude[-_]?/, "") || "default", env);
  }

  return out;
}

/**
 * Read every live-session registry file across every profile.
 *
 * This does NOT verify the processes still exist — that needs the process table,
 * which is a separate (and much more expensive) call. Use liveClaudePids() and
 * reconcile, or call readLiveSessions() which does both.
 */
export function readLiveRegistry(profiles = claudeProfileHomes()) {
  const out = [];
  for (const { id, dir } of profiles) {
    const sessDir = join(dir, "sessions");
    let names;
    try { names = readdirSync(sessDir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(sessDir, name);
      let rec;
      try { rec = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
      if (!rec || typeof rec.pid !== "number") continue;
      out.push({
        profile: id,
        configDir: dir,
        file,
        pid: rec.pid,
        sessionId: rec.sessionId || null,
        cwd: rec.cwd || null,
        name: rec.name || null,
        status: rec.status || null,
        kind: rec.kind || "interactive",
        entrypoint: rec.entrypoint || null,
        version: rec.version || null,
        startedAt: rec.startedAt || null,
        updatedAt: rec.updatedAt || null,
        statusUpdatedAt: rec.statusUpdatedAt || rec.updatedAt || null,
        procStart: rec.procStart || null,
      });
    }
  }
  return out;
}

/**
 * Is this PID alive? Signal 0 performs the permission/existence check without
 * delivering anything. ESRCH means gone; EPERM means alive but not ours.
 *
 * Measured at ~0ms against tasklist's ~420ms, so this is the per-tick liveness
 * check and the full table sweep is reserved for the data only it can provide
 * (per-process RSS, and PIDs with no registry file). It cannot detect PID reuse
 * on its own — callers that care pass a real pid set from liveClaudePids().
 */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

/**
 * PIDs of running claude processes, as a Set.
 *
 * Costs ~420ms on Windows (process-table enumeration, not the spawn), so call it
 * on a slow cadence and pass the result down — do not put it on a 1s tick. Returns
 * null — NOT an empty set — when the table can't be read, so callers can tell
 * "nothing running" from "we don't know" and avoid declaring every session an
 * orphan on a transient failure.
 */
export function liveClaudePids({ imageName = "claude.exe" } = {}) {
  if (process.platform !== "win32") return liveClaudePidsPosix();
  let out;
  try {
    out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8", windowsHide: true, timeout: 5000,
    });
  } catch { return null; }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"[^"]*","(\d+)"/);
    if (m) pids.add(Number(m[1]));
  }
  return pids;
}

function liveClaudePidsPosix() {
  try {
    const out = execFileSync("ps", ["-eo", "pid,comm"], { encoding: "utf8", timeout: 5000 });
    const pids = new Set();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m && /(^|\/)claude$/.test(m[2].trim())) pids.add(Number(m[1]));
    }
    return pids;
  } catch { return null; }
}

/**
 * Classify a transcript's tail as idle (turn finished, waiting for the human) or
 * active (mid-turn). This is the fallback for when a registry `status` has gone
 * stale — it works for any transcript, including ones whose process is gone.
 *
 * The walk goes BACKWARDS from the end, skipping SENTINEL_TYPES, because those are
 * rewritten in place and would otherwise mask the real last event. Reading only the
 * tail keeps this cheap on transcripts that routinely reach tens of megabytes.
 */
export function classifyFromTranscript(path, { tailBytes = 64 * 1024 } = {}) {
  for (const size of [tailBytes, 512 * 1024]) {
    const text = readTail(path, size);
    if (text === null) return { state: "unknown", lastRealTs: null, reason: "unreadable" };
    const verdict = classifyTailText(text);
    if (verdict.state !== "unknown") return verdict;
    // A tail that yielded nothing may simply have been cut mid-record; widen once.
    if (size >= 512 * 1024) break;
  }
  return { state: "unknown", lastRealTs: null, reason: "no-real-entry" };
}

/** Exported for tests: the pure part of classifyFromTranscript. */
export function classifyTailText(text) {
  const lines = text.split("\n");
  // The first line is very likely a partial record (we sliced mid-file); drop it
  // only when we actually sliced, which the caller signals by a leading fragment.
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== "{") continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.type) continue;
    if (SENTINEL_TYPES.has(e.type)) continue;

    const ts = e.timestamp ? Date.parse(e.timestamp) : null;

    if (e.type === "system") {
      // turn_duration is emitted when a turn completes — the cleanest idle marker.
      if (e.subtype === "turn_duration" || e.subtype === "away_summary") {
        return { state: "idle", lastRealTs: ts, reason: `system/${e.subtype}` };
      }
      continue; // other system subtypes are informational, keep walking
    }

    if (e.type === "assistant") {
      const stop = e.message && e.message.stop_reason;
      if (stop === "tool_use") return { state: "active", lastRealTs: ts, reason: "assistant/tool_use" };
      if (stop === "end_turn" || stop === "stop_sequence") {
        return { state: "idle", lastRealTs: ts, reason: `assistant/${stop}` };
      }
      // stop_reason null = the message is still streaming.
      return { state: "active", lastRealTs: ts, reason: "assistant/streaming" };
    }

    if (e.type === "user") {
      return { state: "active", lastRealTs: ts, reason: "user" };
    }
  }
  return { state: "unknown", lastRealTs: null, reason: "no-real-entry" };
}

/** Read the last `bytes` of a file as utf8, or null if unreadable. */
function readTail(path, bytes) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    // Prepend a newline so classifyTailText's "skip index 0" rule never eats a
    // complete first record when the whole file fit in the window.
    return "\n" + buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * Claude's cwd -> project-dir encoding: every non-alphanumeric character becomes a
 * dash, so "C:\projects\andrena\claude-pick" -> "C--projects-andrena-claude-pick".
 * Verified against the live tree; findTranscript still falls back to a scan if the
 * encoding ever changes, so this is an optimization rather than a dependency.
 */
export function cwdToSlug(cwd) {
  return cwd ? cwd.replace(/[^a-zA-Z0-9]/g, "-") : null;
}

/**
 * Locate a session's transcript.
 *
 * Deriving the slug from cwd turns this into one stat; the exhaustive scan behind
 * it costs ~150ms for five sessions here (424 project dirs x 5 = ~2000 stats), so
 * the fast path matters on a polling caller. Results are memoized because such a
 * caller asks for the same handful of ids every tick.
 */
const transcriptCache = new Map();
export function findTranscript(sessionId, profiles = claudeProfileHomes(), cwd = null) {
  if (!sessionId) return null;
  const hit = transcriptCache.get(sessionId);
  if (hit && existsSync(hit)) return hit;

  const wanted = `${sessionId}.jsonl`;

  const slug = cwdToSlug(cwd);
  if (slug) {
    for (const { dir } of profiles) {
      const cand = join(dir, "projects", slug, wanted);
      if (existsSync(cand)) { transcriptCache.set(sessionId, cand); return cand; }
    }
  }

  for (const { dir } of profiles) {
    const projects = join(dir, "projects");
    let slugs;
    try { slugs = readdirSync(projects); } catch { continue; }
    for (const s of slugs) {
      const cand = join(projects, s, wanted);
      if (existsSync(cand)) { transcriptCache.set(sessionId, cand); return cand; }
    }
  }
  return null;
}

/**
 * Count subagents that recently wrote to their transcript.
 *
 * IMPORTANT CAVEAT, and it is not fixable from here: subagents run IN-PROCESS.
 * They spawn no OS process, so the process table cannot see them and this mtime
 * heuristic is the only available signal. It over-counts an agent that finished
 * quietly within the window and under-counts one blocked in a long tool call. Treat
 * the result as "recently active (approx)" and never let it drive a decision.
 *
 * `dir` is the parent session's transcript path or its sibling <sessionId>/ dir.
 */
export function countActiveSubagents(sessionTranscript, { windowMs = 45000, now = Date.now() } = {}) {
  if (!sessionTranscript) return { total: 0, active: 0, ids: [] };
  const base = sessionTranscript.endsWith(".jsonl")
    ? join(dirname(sessionTranscript), basename(sessionTranscript, ".jsonl"))
    : sessionTranscript;
  const subDir = join(base, "subagents");
  let names;
  try { names = readdirSync(subDir); } catch { return { total: 0, active: 0, ids: [] }; }

  const ids = [];
  let total = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    total++;
    let st; try { st = statSync(join(subDir, name)); } catch { continue; }
    if (now - st.mtimeMs <= windowMs) ids.push(basename(name, ".jsonl"));
  }
  return { total, active: ids.length, ids };
}

/**
 * The full live picture: registry ∪ process table ∪ transcripts, reconciled.
 *
 * ── How the two state signals actually behave (measured, not assumed) ──
 *
 * The registry's `status` is a LATCHED value, not a heartbeat: the file is
 * rewritten only when the status CHANGES. Observed live, a session sat at
 * `"busy"` with `updatedAt` 39 minutes old while genuinely working. So age is
 * NOT a staleness signal here, and gating on it (the obvious design) would push
 * every session down the fallback path within the first minute.
 *
 * That makes the transcript tail the more precise signal for active-vs-idle: it
 * records every turn boundary, so it cannot miss a transition the way a latched
 * value can. The registry remains authoritative for two things the transcript
 * cannot express — identity (pid -> profile/cwd/name) and the `shell` state.
 *
 * Reconciliation:
 *   1. pid absent from the process table   -> orphan (stale file from a killed session)
 *   2. registry says "shell"               -> shell (transcript has no such concept)
 *   3. transcript classifies                -> use it; record disagreement with the registry
 *   4. transcript unreadable/inconclusive   -> fall back to the latched registry status
 *
 * `unattributed` reports processes in the table with no registry file. A monitor
 * that cannot see a session must say so rather than quietly under-count.
 */
export function readLiveSessions({
  now = Date.now(),
  subagents = true,
  subagentWindowMs = 45000,
  stalledAfterMs = 10 * 60 * 1000,
  pids: givenPids,
} = {}) {
  const profiles = claudeProfileHomes();
  const registry = readLiveRegistry(profiles);
  // A caller running a slow process-table sweep on its own cadence passes the pid
  // set in; a one-shot caller gets the ~0ms signal-0 check instead of paying 420ms
  // for a table it would only use for liveness. `undefined` = use the cheap path.
  const pids = givenPids === undefined ? null : givenPids;
  const degraded = [];
  if (givenPids === null) degraded.push("proctable");

  const sessions = [];
  const seenPids = new Set();

  for (const r of registry) {
    seenPids.add(r.pid);
    const alive = pids === null ? pidAlive(r.pid) : pids.has(r.pid);
    if (!alive) {
      sessions.push({
        ...r, transcript: null, state: "orphan", stateSource: "pid",
        disagrees: false, uptimeSec: null, idleForSec: null, lastActivitySec: null,
        stalled: false, subagents: { total: 0, active: 0, ids: [] },
      });
      continue;
    }

    const registryState = r.status === "busy" ? "active" : r.status === "shell" ? "shell" : "idle";
    const transcript = findTranscript(r.sessionId, profiles, r.cwd);

    let state = registryState;
    let stateSource = "registry";
    let lastRealTs = r.statusUpdatedAt || null;
    let disagrees = false;

    if (r.status === "shell") {
      // A shell/headless session never waits on a human; the transcript can't
      // distinguish it from an ordinary one, so the registry wins outright.
      stateSource = "registry";
    } else if (transcript) {
      const c = classifyFromTranscript(transcript);
      if (c.state !== "unknown") {
        state = c.state;
        stateSource = "transcript";
        if (c.lastRealTs) lastRealTs = c.lastRealTs;
        disagrees = c.state !== registryState;
      }
    }

    const lastActivitySec = lastRealTs ? Math.max(0, Math.round((now - lastRealTs) / 1000)) : null;
    // An "active" session whose last recorded event is ancient is either inside a
    // very long tool call or wedged. Either way it is not currently burning quota,
    // so surface it rather than letting it inflate the active count unexamined.
    const stalled = state === "active" && lastRealTs != null && (now - lastRealTs) > stalledAfterMs;

    sessions.push({
      ...r,
      transcript,
      state,
      stateSource,
      disagrees,
      stalled,
      uptimeSec: r.startedAt ? Math.max(0, Math.round((now - r.startedAt) / 1000)) : null,
      idleForSec: state === "idle" ? lastActivitySec : null,
      lastActivitySec,
      subagents: subagents && state === "active"
        ? countActiveSubagents(transcript, { windowMs: subagentWindowMs, now })
        : { total: 0, active: 0, ids: [] },
    });
  }

  // Only a real process-table sweep can reveal a claude.exe with no registry file;
  // the signal-0 path has nothing to enumerate, so report null ("unknown") rather
  // than 0 ("we checked and there are none").
  const unattributed = pids === null ? null : [...pids].filter((p) => !seenPids.has(p)).length;

  return { sessions, unattributed, degraded, profiles };
}
