#!/usr/bin/env node
/**
 * live — which Claude sessions are running right now, and are they working or waiting?
 *
 *   node scripts/live.mjs              human table
 *   node scripts/live.mjs --json       machine-readable
 *   node scripts/live.mjs --watch      redraw every 2s
 *   node scripts/live.mjs --no-subagents   skip the subagent mtime globbing
 *
 * Unlike every other script in this skill, this one reads LIVE state (the per-PID
 * session registry) rather than finished transcripts.
 */
import { readLiveSessions } from "./lib/live.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

function collect() {
  return readLiveSessions({ subagents: !has("--no-subagents") });
}

function render({ sessions, unattributed, degraded }) {
  const live = sessions.filter((s) => s.state !== "orphan");
  const active = live.filter((s) => s.state === "active").length;
  const idle = live.filter((s) => s.state === "idle").length;
  const shell = live.filter((s) => s.state === "shell").length;
  const orphans = sessions.length - live.length;
  const subs = live.reduce((n, s) => n + (s.subagents ? s.subagents.active : 0), 0);

  const lines = [];
  lines.push(`${live.length} live  ·  ${active} active  ${idle} idle  ${shell} shell` +
    (subs ? `  ·  ${subs} subagents (approx)` : "") +
    (orphans ? `  ·  ${orphans} orphaned` : "") +
    (unattributed ? `  ·  ${unattributed} unattributed` : ""));
  if (degraded.length) lines.push(`degraded: ${degraded.join(", ")}`);
  lines.push("");

  const rows = live.slice().sort((a, b) =>
    (a.profile || "").localeCompare(b.profile || "") || (a.pid - b.pid));
  const w = (s, n) => String(s == null ? "" : s).slice(0, n).padEnd(n);
  lines.push(w("PROFILE", 18) + w("PID", 7) + w("STATE", 10) + w("NAME", 22) +
    w("UP", 7) + w("LAST", 7) + "CWD");
  for (const s of rows) {
    const mark = (s.disagrees ? "*" : "") + (s.stalled ? "!" : "");
    lines.push(
      w(s.profile, 18) + w(s.pid, 7) + w(s.state + mark, 10) + w(s.name, 22) +
      w(fmtDur(s.uptimeSec), 7) + w(fmtDur(s.lastActivitySec), 7) + (s.cwd || ""));
  }
  if (rows.some((s) => s.disagrees)) lines.push("\n* transcript disagrees with the registry's latched status (transcript wins)");
  if (rows.some((s) => s.stalled)) lines.push("! active but no transcript activity for >10m (long tool call, or wedged)");
  return lines.join("\n");
}

function fmtDur(sec) {
  if (sec == null) return "";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

if (has("--watch")) {
  const tick = () => {
    process.stdout.write("\x1b[2J\x1b[H" + render(collect()) + "\n");
  };
  tick();
  setInterval(tick, 2000);
} else {
  const snap = collect();
  if (has("--json")) console.log(JSON.stringify(snap, null, 2));
  else console.log(render(snap));
}
