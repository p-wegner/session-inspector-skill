#!/usr/bin/env node
/**
 * Two questions spawn.cmd should never launch without asking, because both
 * failure modes are silent and only visible later:
 *
 *   1. Is a session ALREADY working this repo? Two agents in one checkout is how
 *      you get cross-author commits and a Stop hook handing one session another's
 *      in-flight work. Nothing stopped a duplicate spawn before.
 *   2. Is there ROOM for another whole session? Measured on this box: four
 *      sessions were launched into a machine already swapping at ~9.5k hard
 *      faults/sec, because nothing asked.
 *
 * `system.headroomProcesses` from `fleet snapshot --json` is the right metric
 * HERE and only here: it answers "how many more whole claude.exe sessions fit in
 * RAM". (session-inspector warns against it for SUBAGENT fan-out, which is
 * in-process and costs nothing like a session — different question, same field.)
 *
 * Usage:
 *   node preflight.mjs --target <dir> [--profile <name>] [--json]
 *        exit 0 = clear to launch, 3 = refuse (reason printed), 1 = usage error
 *   node preflight.mjs --pick-profile [--exclude a,b] [--json]
 *        print the profile with the most quota headroom (for `-p auto`)
 *
 * Degrades openly: if fleet is absent or unreadable, the capacity check is
 * SKIPPED and says so — an unavailable check must not read as a passed one.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d = "") => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const asJson = has("--json");
const target = opt("--target");
const pickMode = has("--pick-profile");
const exclude = opt("--exclude").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const FLEET = "C:\\projects\\andrena\\claude-pick\\fleet\\fleet.cmd";

// ── profile homes ────────────────────────────────────────────────────────────
// A sibling `~/.claude-*` dir is only an auth profile if it has a `projects` dir;
// `.claude-share` is a shared-skills folder and was once proposed as one.
function profileHomes() {
  const home = homedir();
  const out = [];
  for (const entry of ["\u002eclaude", ...readdirSync(home).filter((e) => /^\.claude[-_].+/.test(e))]) {
    const dir = join(home, entry);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    if (!existsSync(join(dir, "projects"))) continue;
    out.push({ id: entry.replace(/^\.claude[-_]?/, "") || "default", dir, entry });
  }
  return out;
}

// ── live sessions, straight from each profile's registry ─────────────────────
// One file per running CLI process, deleted on graceful exit. `status` is latched
// (rewritten only on change), so it is NOT a heartbeat — presence + a live pid is
// the signal, and a crashed session leaves a stale file behind forever.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function liveSessions() {
  const out = [];
  for (const p of profileHomes()) {
    const dir = join(p.dir, "sessions");
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      let rec;
      try { rec = JSON.parse(readFileSync(join(dir, f), "utf-8")); } catch { continue; }
      if (!rec || !rec.pid) continue;
      if (!pidAlive(rec.pid)) continue;                      // stale registry file
      out.push({ profile: p.id, configDir: p.dir, ...rec });
    }
  }
  return out;
}

const samePath = (a, b) => String(a || "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()
  === String(b || "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();

// ── fleet snapshot ───────────────────────────────────────────────────────────
// Collecting a snapshot costs ~1s of work but several seconds of process startup,
// and on a machine already at 100% CPU it has timed out outright — so a batch of
// spawns must not pay for it once per session. Cached briefly in TEMP: fresh
// enough that RAM headroom and quota are still true, cheap enough to always ask.
const SNAP_CACHE = join(process.env.TEMP || homedir(), "spawn-fleet-snapshot.json");
const SNAP_TTL_MS = 90_000;

function cachedSnapshot() {
  try {
    const st = statSync(SNAP_CACHE);
    if (Date.now() - st.mtimeMs < SNAP_TTL_MS) {
      return { ok: true, snap: JSON.parse(readFileSync(SNAP_CACHE, "utf-8")), cached: true };
    }
  } catch { /* no usable cache */ }
  return null;
}

function snapshot() {
  const hit = cachedSnapshot();
  if (hit) return hit;
  if (!existsSync(FLEET)) return { ok: false, reason: "fleet not installed" };
  try {
    // A .cmd is not an executable image: execFileSync on it fails with EINVAL on
    // Windows unless it goes through the shell. That failure was indistinguishable
    // from "fleet not installed", so the capacity check silently never ran.
    const out = execFileSync(process.env.COMSPEC || "cmd.exe", ["/c", FLEET, "snapshot", "--json"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    });
    const snap = JSON.parse(out);
    try { writeFileSync(SNAP_CACHE, JSON.stringify(snap)); } catch { /* cache is optional */ }
    return { ok: true, snap };
  } catch (e) {
    return { ok: false, reason: `fleet snapshot failed: ${String(e.message).split("\n")[0]}` };
  }
}

// ── mode: pick a profile ─────────────────────────────────────────────────────
if (pickMode) {
  const homes = profileHomes().filter((p) => p.id !== "default");
  const pool = homes.filter((p) => !exclude.includes(p.id.toLowerCase()) && !exclude.includes(p.entry.toLowerCase()));
  const list = pool.length ? pool : homes;
  const s = snapshot();
  const byId = new Map();
  if (s.ok) for (const p of s.snap.profiles || []) byId.set(p.id, p);

  // Least-loaded first: the 5-hour window is what actually bites during a
  // fan-out, the 7-day window is the tiebreak, live sessions the last one.
  const ranked = list.map((p) => {
    const q = byId.get(p.id)?.quota || {};
    const sess = byId.get(p.id)?.sessions || {};
    return {
      ...p,
      fiveHour: q.fiveHour?.utilization ?? null,
      sevenDay: q.sevenDay?.utilization ?? null,
      active: (sess.active || 0) + (sess.idle || 0),
    };
  }).sort((a, b) =>
    (a.fiveHour ?? 50) - (b.fiveHour ?? 50)
    || (a.sevenDay ?? 50) - (b.sevenDay ?? 50)
    || a.active - b.active
    || a.id.localeCompare(b.id));

  const win = ranked[0];
  if (!win) { console.error("[preflight] no auth profile found"); process.exit(1); }
  if (asJson) { console.log(JSON.stringify({ picked: win, ranked, quotaKnown: s.ok, note: s.ok ? "" : s.reason }, null, 2)); process.exit(0); }
  // stdout is consumed by spawn.cmd via `for /f`, so it must be the value alone.
  console.log(win.dir);
  process.exit(0);
}

// ── mode: preflight a target ─────────────────────────────────────────────────
if (!target) {
  console.error("usage: preflight.mjs --target <dir> [--profile <name>] [--json]");
  console.error("       preflight.mjs --pick-profile [--exclude a,b]");
  process.exit(1);
}

const findings = [];
const refusals = [];

const dupes = liveSessions().filter((s) => samePath(s.cwd, target));
if (dupes.length) {
  refusals.push({
    check: "duplicate-session",
    detail: `a session is already live in ${target}: ${dupes.map((d) => `${d.name || d.sessionId?.slice(0, 8)}@${d.profile} (pid ${d.pid})`).join(", ")}`,
    advice: "Message that session over ACP instead, or pass -force if two agents in one checkout is genuinely intended.",
  });
}

const s = snapshot();
if (!s.ok) {
  findings.push({ check: "capacity", status: "skipped", detail: s.reason });
} else {
  const room = s.snap.system?.headroomProcesses;
  const swapping = s.snap.system?.memory?.hardFaultsPerSec || 0;
  if (typeof room === "number" && room < 1) {
    refusals.push({
      check: "capacity",
      detail: `no RAM headroom for another session (headroomProcesses=${room}${swapping ? `, swapping at ${swapping}/s` : ""})`,
      advice: "Close something (a browser, a WSL/Docker VM, an idle session) or wait, then retry. -force overrides.",
    });
  } else {
    findings.push({ check: "capacity", status: "ok", detail: `room for ~${room} more session(s)` });
  }
}

if (asJson) {
  console.log(JSON.stringify({ target, ok: !refusals.length, refusals, findings }, null, 2));
  process.exit(refusals.length ? 3 : 0);
}
for (const f of findings) console.log(`[preflight] ${f.check}: ${f.status} — ${f.detail}`);
if (!refusals.length) process.exit(0);
for (const r of refusals) {
  console.log(`[preflight] REFUSE ${r.check}: ${r.detail}`);
  console.log(`[preflight]   ${r.advice}`);
}
process.exit(3);
