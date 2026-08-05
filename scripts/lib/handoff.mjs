/**
 * HANDOFF extraction — what the NEXT session needs to know to continue a cut-off one.
 *
 * The summary/friction views answer "what happened"; this answers "what is still
 * RUNNING or PARKED on this machine because of that session". Motivating case: an
 * orchestrator is killed by a usage limit after detaching a background driver,
 * arming Monitors on its log, and staging working scripts in its session-scoped
 * TEMP scratchpad — none of which the at-a-glance panel surfaces, so a continuation
 * session has to dig it out of raw events (or worse, never learns the scratchpad
 * existed until the OS clears it).
 *
 * Claude transcripts only (the other providers have no background tools).
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join, basename, dirname } from "path";
import { limitKind, parseClaude, fmtDuration } from "./parse.mjs";

// Detached-process patterns in shell commands: things that outlive the tool call.
const DETACH_RE = /Start-Process|nohup\s|start\s+\/b|-WindowStyle\s+Hidden|setsid\s|schtasks\s|pm2\s+start|&\s*disown/i;
// Local endpoints touched — the services the session assumed were (or left) running.
const SERVICE_RE = /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d{2,5})/g;
// Filesystem paths that look session-temporary (Claude scratchpads, /tmp).
const SCRATCH_RE = /(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'`]*[\\/])?(?:Temp[\\/]claude|scratchpad|tmp)[\\/][^\s"'`]*/i;
// Log-ish paths inside a command — what a detached process writes / a monitor reads.
const LOGPATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`;|)]+\.(?:log|out|err|jsonl|txt)/gi;

function pathsIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(LOGPATH_RE)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

export function handoffExtract(lines) {
  const h = {
    background: [],   // {ts, tool, how, command, paths}  — processes that may outlive the session
    monitors: [],     // {ts, description, persistent, paths, command}
    scratchpadWrites: [], // {ts, tool, path} — files the session staged in temp space
    services: {},     // port -> hits — local endpoints the session talked to
    todos: null,      // {ts, todos:[{content,status}]} — last TodoWrite snapshot
    tasksCreated: [], // {ts, subject} — TaskCreate calls
    notifications: [],// {ts, status, summary} — <task-notification> blocks (esp. at the tail)
    lastSubstantive: [], // last non-banner assistant texts {ts, text}
  };
  const scratchSeen = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj; try { obj = JSON.parse(trimmed); } catch { continue; }
    const ts = obj.timestamp || "";
    const msg = obj.message;
    if (!msg) continue;

    if (obj.type === "assistant") {
      for (const block of msg.content || []) {
        if (block.type === "text" && block.text) {
          if (!limitKind(block.text) && block.text.trim().length > 40) {
            h.lastSubstantive.push({ ts, text: block.text });
            if (h.lastSubstantive.length > 3) h.lastSubstantive.shift();
          }
        } else if (block.type === "tool_use") {
          const name = block.name || "";
          const input = block.input || {};
          const cmd = typeof input.command === "string" ? input.command : "";
          if (name === "Bash" || name === "PowerShell") {
            if (input.run_in_background === true) {
              h.background.push({ ts, tool: name, how: "run_in_background", command: cmd, paths: pathsIn(cmd) });
            } else if (DETACH_RE.test(cmd)) {
              h.background.push({ ts, tool: name, how: "detached", command: cmd, paths: pathsIn(cmd) });
            }
            for (const m of cmd.matchAll(SERVICE_RE)) h.services[m[1]] = (h.services[m[1]] || 0) + 1;
          } else if (name === "Monitor") {
            h.monitors.push({ ts, description: input.description || "", persistent: !!input.persistent, command: cmd, paths: pathsIn(cmd) });
          } else if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") {
            const fp = input.file_path || input.notebook_path || "";
            if (SCRATCH_RE.test(fp) && !scratchSeen.has(fp)) {
              scratchSeen.add(fp);
              h.scratchpadWrites.push({ ts, tool: name, path: fp });
            }
          } else if (name === "TodoWrite" && Array.isArray(input.todos)) {
            h.todos = { ts, todos: input.todos.map((t) => ({ content: t.content, status: t.status })) };
          } else if (name === "TaskCreate" && input.subject) {
            h.tasksCreated.push({ ts, subject: input.subject });
          }
          if (typeof input.url === "string") {
            for (const m of input.url.matchAll(SERVICE_RE)) h.services[m[1]] = (h.services[m[1]] || 0) + 1;
          }
        }
      }
    } else if (obj.type === "user") {
      const content = msg.content;
      const texts = typeof content === "string" ? [content]
        : Array.isArray(content) ? content.filter((b) => b.type === "text" && b.text).map((b) => b.text) : [];
      for (const t of texts) {
        if (t.includes("<task-notification>")) {
          const status = (t.match(/<status>([^<]*)<\/status>/) || [])[1] || "";
          const summary = (t.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "";
          h.notifications.push({ ts, status, summary: summary.trim().slice(0, 200) });
        }
      }
    }
  }
  return h;
}

/** Locate the session's own TEMP scratchpad dir from the transcript path and report on it. */
export function scratchpadInfo(transcriptPath, sessionId) {
  // <home>/projects/<projectDir>/<id>.jsonl → %TEMP%/claude/<projectDir>/<id>/scratchpad
  const projectDir = basename(dirname(transcriptPath));
  const candidates = [];
  const tmp = process.env.TEMP || process.env.TMPDIR || "/tmp";
  candidates.push(join(tmp, "claude", projectDir, sessionId, "scratchpad"));
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    let files = 0, bytes = 0, newest = 0;
    const walk = (d, depth) => {
      if (depth > 3) return;
      let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else { files++; try { const st = statSync(p); bytes += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs; } catch { /* ignore */ } }
      }
    };
    walk(dir, 0);
    return { dir, files, bytes, newest: newest ? new Date(newest).toISOString() : "" };
  }
  return null;
}

function hhmm(ts) { return ts ? String(ts).slice(11, 19) : "?"; }
function oneLine(t, n = 110) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Render the handoff panel. `content` is the transcript text; `targetPath` its file path. */
export function runHandoffMode(content, argv, targetPath) {
  const lines = content.split("\n");
  const s = parseClaude(lines);
  const h = handoffExtract(lines);
  const scratch = scratchpadInfo(targetPath, s.sessionId);
  const subagentsDir = join(dirname(targetPath), s.sessionId, "subagents");
  let subagents = 0;
  try { subagents = readdirSync(subagentsDir).filter((f) => f.endsWith(".jsonl")).length; } catch { /* none */ }

  if (argv.includes("--json")) {
    return JSON.stringify({
      sessionId: s.sessionId, cwd: s.cwd, endTime: s.endTime,
      endedOnLimit: s.endedOnLimit, endedInterrupted: s.endedInterrupted, stopReason: s.stopReason,
      ...h, scratchpad: scratch, subagents: { count: subagents, dir: subagents ? subagentsDir : null },
    }, null, 2);
  }

  const out = [];
  const W = 72;
  out.push("═".repeat(W));
  out.push("HANDOFF — what a continuation session needs to know");
  out.push("═".repeat(W));
  const endLabel = s.endedOnLimit ? `⛔ ${s.endedOnLimit}` : s.endedInterrupted ? "✋ user interrupt" : (s.stopReason || "ended");
  out.push(`Session ${String(s.sessionId).slice(0, 8)}…  ·  cwd ${s.cwd}  ·  ${endLabel} at ${s.endTime || "?"}  ·  ran ${fmtDuration(s.durationSec)}`);

  if (h.lastSubstantive.length) {
    out.push(`\n${"─".repeat(40)}\nLAST SUBSTANTIVE UPDATE (before any cut-off banners)\n${"─".repeat(40)}`);
    const last = h.lastSubstantive[h.lastSubstantive.length - 1];
    out.push(`  [${hhmm(last.ts)}] ${last.text.slice(0, 500)}${last.text.length > 500 ? "…" : ""}`);
  }

  if (h.background.length) {
    out.push(`\n${"─".repeat(40)}\nBACKGROUND / DETACHED PROCESSES (${h.background.length}) — may still run, or died with the machine; VERIFY\n${"─".repeat(40)}`);
    for (const b of h.background.slice(-8)) {
      out.push(`  ▶ [${hhmm(b.ts)}] ${b.tool} (${b.how}): ${oneLine(b.command)}`);
      for (const p of b.paths.slice(0, 3)) out.push(`      log: ${p}`);
    }
  }
  if (h.monitors.length) {
    out.push(`\n${"─".repeat(40)}\nMONITORS ARMED (${h.monitors.length}) — the watched paths hold the outcome\n${"─".repeat(40)}`);
    for (const m of h.monitors.slice(-6)) {
      out.push(`  👁 [${hhmm(m.ts)}] ${m.description}${m.persistent ? " (persistent)" : ""}`);
      for (const p of m.paths.slice(0, 3)) out.push(`      watch: ${p}`);
    }
  }
  if (scratch) {
    out.push(`\n${"─".repeat(40)}\nSESSION SCRATCHPAD — temp storage the OS can clear; salvage what matters\n${"─".repeat(40)}`);
    out.push(`  dir:   ${scratch.dir}`);
    out.push(`  holds: ${scratch.files} file(s), ${(scratch.bytes / 1048576).toFixed(1)} MB, newest ${scratch.newest || "?"}`);
  }
  if (h.scratchpadWrites.length) {
    const cap = 10;
    out.push(`  written by the session (${h.scratchpadWrites.length}):`);
    for (const w of h.scratchpadWrites.slice(-cap)) out.push(`    - ${w.path}`);
    if (h.scratchpadWrites.length > cap) out.push(`    … ${h.scratchpadWrites.length - cap} more (see --json)`);
  }
  const ports = Object.entries(h.services).sort((a, b) => b[1] - a[1]);
  if (ports.length) {
    out.push(`\n${"─".repeat(40)}\nLOCAL SERVICES TOUCHED — the session assumed these were running\n${"─".repeat(40)}`);
    out.push(`  ${ports.map(([p, n]) => `127.0.0.1:${p} (${n}×)`).join("  ·  ")}`);
  }
  if (h.todos?.todos?.length) {
    out.push(`\n${"─".repeat(40)}\nTODO SNAPSHOT (last TodoWrite)\n${"─".repeat(40)}`);
    for (const t of h.todos.todos) out.push(`  [${t.status}] ${oneLine(t.content, 90)}`);
  }
  if (h.tasksCreated.length) {
    out.push(`\n${"─".repeat(40)}\nTASKS CREATED (${h.tasksCreated.length})\n${"─".repeat(40)}`);
    for (const t of h.tasksCreated.slice(-6)) out.push(`  • ${oneLine(t.subject, 90)}`);
  }
  if (h.notifications.length) {
    out.push(`\n${"─".repeat(40)}\nTASK NOTIFICATIONS (${h.notifications.length}, last 3) — arrived results; check the tail ones were acted on\n${"─".repeat(40)}`);
    for (const n of h.notifications.slice(-3)) out.push(`  [${hhmm(n.ts)}] ${n.status || "event"}: ${oneLine(n.summary, 100)}`);
  }
  if (subagents) {
    out.push(`\n${"─".repeat(40)}\nSUBAGENTS\n${"─".repeat(40)}`);
    out.push(`  ${subagents} transcript(s) on disk — recover stranded results with:`);
    out.push(`  node scripts/subagent-results.mjs ${s.sessionId} --unresolved`);
  }
  out.push("═".repeat(W));
  return out.join("\n");
}
