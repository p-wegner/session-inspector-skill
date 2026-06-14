#!/usr/bin/env node
/**
 * Session-sync hub lifecycle manager — run the sync-server as a persistent,
 * auto-starting background service so the hub survives logout/reboot.
 *
 * Node builtins only. Host-agnostic: resolves port/data-dir via lib/config.mjs
 * and picks the right autostart mechanism per OS (Scheduled Task on Windows,
 * launchd on macOS, systemd --user on Linux).
 *
 * Usage:
 *   node scripts/hub-service.mjs status        # running? indexed count? autostart installed?
 *   node scripts/hub-service.mjs start         # spawn the hub detached (hidden), write pid+log
 *   node scripts/hub-service.mjs stop          # stop the running hub
 *   node scripts/hub-service.mjs restart       # stop then start
 *   node scripts/hub-service.mjs logs [-n 40]  # tail the hub log
 *   node scripts/hub-service.mjs install       # register autostart at logon/boot
 *   node scripts/hub-service.mjs uninstall     # remove autostart
 *
 * Honors the same knobs as the server: SESSION_SYNC_PORT, SESSION_SYNC_DATA,
 * and --port / --host. Files live under the data dir (default ~/.session-sync):
 *   hub.pid   last-started server pid
 *   hub.log   stdout+stderr of the detached server
 *   hub-autostart.vbs   (Windows) hidden launcher used by the Scheduled Task
 */

import { spawn, execFileSync, execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { dataDir, DEFAULT_PORT, flag } from "./lib/config.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "sync-server.mjs");
const NODE = process.execPath;

const PORT = Number(flag(argv, "--port") || process.env.SESSION_SYNC_PORT || DEFAULT_PORT);
const HOST = flag(argv, "--host") || "0.0.0.0";
const DATA = dataDir();
const PID_FILE = join(DATA, "hub.pid");
const LOG_FILE = join(DATA, "hub.log");
const VBS_FILE = join(DATA, "hub-autostart.vbs");
const TASK_NAME = "SessionSyncHub";
const SVC_LABEL = "com.session-inspector.hub";
const LOCAL_URL = `http://127.0.0.1:${PORT}`;

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

// ── small helpers ────────────────────────────────────────────────────────────

async function health() {
  try {
    const r = await fetch(`${LOCAL_URL}/api/health`, { signal: AbortSignal.timeout(4000) });
    return await r.json();
  } catch { return null; }
}

function readPid() {
  try { const p = Number(readFileSync(PID_FILE, "utf-8").trim()); return p > 0 ? p : null; }
  catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Find pid(s) listening on PORT, OS-specific. Returns array of numbers. */
function pidsOnPort() {
  try {
    if (isWin) {
      const out = execSync(`netstat -ano -p tcp`, { encoding: "utf-8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        // Listening sockets have foreign address "*:0" regardless of the
        // localized state word ("LISTENING" / "ABHÖREN" / ...). Match on that
        // instead of the state so it works on non-English Windows.
        const m = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S*:0\s+\S+\s+(\d+)\s*$/);
        if (m && Number(m[1]) === PORT && Number(m[2]) > 0) pids.add(Number(m[2]));
      }
      return [...pids];
    }
    const out = execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`, { encoding: "utf-8" });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch { return []; }
}

function killPid(pid) {
  try {
    if (isWin) execFileSync("taskkill", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
    return true;
  } catch { return false; }
}

// ── start / stop ─────────────────────────────────────────────────────────────

async function start() {
  const h = await health();
  if (h?.ok) { console.log(`already running on ${LOCAL_URL} (${h.count} sessions)`); return; }
  mkdirSync(DATA, { recursive: true });
  const log = openSync(LOG_FILE, "a");
  const child = spawn(NODE, [SERVER, "--host", HOST, "--port", String(PORT)], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  // give it a moment, then confirm
  await new Promise((r) => setTimeout(r, 1200));
  const after = await health();
  if (after?.ok) console.log(`started hub pid ${child.pid} on http://${HOST}:${PORT}/  (${after.count} sessions) — log: ${LOG_FILE}`);
  else console.log(`spawned pid ${child.pid} but health not yet ready — check ${LOG_FILE}`);
}

async function stop() {
  let stopped = 0;
  const pid = readPid();
  const targets = new Set();
  if (pidAlive(pid)) targets.add(pid);
  for (const p of pidsOnPort()) targets.add(p);
  for (const p of targets) if (killPid(p)) { stopped++; console.log(`stopped pid ${p}`); }
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
  if (!stopped) console.log("no running hub found");
}

// ── status ───────────────────────────────────────────────────────────────────

function autostartInstalled() {
  try {
    if (isWin) { execSync(`schtasks /Query /TN ${TASK_NAME}`, { stdio: "ignore" }); return true; }
    if (isMac) return existsSync(join(process.env.HOME || "", "Library", "LaunchAgents", `${SVC_LABEL}.plist`));
    return existsSync(join(process.env.HOME || "", ".config", "systemd", "user", "session-sync-hub.service"));
  } catch { return false; }
}

async function status() {
  const h = await health();
  const pid = readPid();
  console.log(`hub url      : http://${HOST}:${PORT}/  (local probe ${LOCAL_URL})`);
  console.log(`running      : ${h?.ok ? `yes — ${h.count} sessions indexed` : "no"}`);
  console.log(`pid file     : ${pid ? `${pid} (${pidAlive(pid) ? "alive" : "stale"})` : "none"}`);
  console.log(`port ${String(PORT).padEnd(5)}   : ${pidsOnPort().join(", ") || "nothing listening"}`);
  console.log(`autostart    : ${autostartInstalled() ? "installed" : "not installed"} (${process.platform})`);
  console.log(`data dir     : ${DATA}`);
  console.log(`log          : ${LOG_FILE}`);
}

function logs() {
  const n = Number(flag(argv, "-n") || flag(argv, "--lines") || 40);
  if (!existsSync(LOG_FILE)) { console.log(`(no log yet at ${LOG_FILE})`); return; }
  const lines = readFileSync(LOG_FILE, "utf-8").split(/\r?\n/);
  console.log(lines.slice(-n).join("\n"));
}

// ── install / uninstall autostart ────────────────────────────────────────────

function installWin() {
  mkdirSync(DATA, { recursive: true });
  // Hidden launcher: wscript runs the server with no console window (style 0)
  // and WAITS on it (3rd arg True), then exits with node's exit code. Waiting is
  // what lets Task Scheduler see the task as "running" while the hub is alive and
  // "failed" when the hub crashes — which is what RestartOnFailure (below) needs.
  // In a VBS string literal backslashes are literal and an embedded double quote
  // is written by doubling it (""), so wrap each path in "" .. "" .
  const cmd = `""${NODE}"" ""${SERVER}"" --host ${HOST} --port ${PORT}`;
  const vbs =
    `Set sh = CreateObject("WScript.Shell")\r\n` +
    `WScript.Quit sh.Run("${cmd}", 0, True)\r\n`;
  writeFileSync(VBS_FILE, vbs);

  // Register via task XML so we can express keep-alive properly. Self-healing
  // design: a LogonTrigger that ALSO repeats every minute, plus
  // MultipleInstancesPolicy=IgnoreNew. While the hub is alive the waiting wscript
  // keeps one instance running, so each minute's re-launch is ignored; when the
  // hub dies the launcher exits and the next tick (≤1 min) relaunches it. This is
  // deliberately NOT RestartOnFailure — that triggers on the engine failing to
  // LAUNCH the action, not on the action exiting non-zero, so a crashed hub
  // (exit 1) leaves the task "Ready" and never restarts. RestartOnFailure is kept
  // too as a belt-and-suspenders, but the repetition is what actually heals.
  // RunLevel is LeastPrivilege on purpose: the hub only serves HTTP + reads home
  // dirs, needs no admin, and an elevated long-running node can't be stopped by
  // normal tools.
  const user = `${process.env.USERDOMAIN || ""}\\${process.env.USERNAME || ""}`.replace(/^\\/, "");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>session-sync hub (auto-start + restart on failure)</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
    <TimeTrigger><StartBoundary>2024-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${esc(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"${esc(VBS_FILE)}"</Arguments></Exec></Actions>
</Task>`;
  const XML_FILE = join(DATA, "hub-task.xml");
  writeFileSync(XML_FILE, "﻿" + xml, "utf16le"); // schtasks /XML wants UTF-16
  // /Create + RunLevel HIGHEST needs admin; schtasks reports it if not elevated.
  execFileSync("schtasks", ["/Create", "/TN", TASK_NAME, "/XML", XML_FILE, "/F"], { stdio: "inherit" });
  console.log(`installed Scheduled Task "${TASK_NAME}" (ONLOGON + 1-min keep-alive, self-healing) -> wscript.exe "${VBS_FILE}"`);
}

function uninstallWin() {
  execFileSync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], { stdio: "inherit" });
  try { if (existsSync(VBS_FILE)) unlinkSync(VBS_FILE); } catch {}
  console.log(`removed Scheduled Task "${TASK_NAME}"`);
}

function installMac() {
  const dir = join(process.env.HOME, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const plist = join(dir, `${SVC_LABEL}.plist`);
  writeFileSync(plist,
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SVC_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE}</string><string>${SERVER}</string>
    <string>--host</string><string>${HOST}</string><string>--port</string><string>${PORT}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict></plist>\n`);
  try { execSync(`launchctl unload "${plist}" 2>/dev/null`); } catch {}
  execSync(`launchctl load "${plist}"`);
  console.log(`installed launchd agent ${plist}`);
}

function uninstallMac() {
  const plist = join(process.env.HOME, "Library", "LaunchAgents", `${SVC_LABEL}.plist`);
  try { execSync(`launchctl unload "${plist}"`); } catch {}
  try { if (existsSync(plist)) unlinkSync(plist); } catch {}
  console.log(`removed launchd agent ${plist}`);
}

function installLinux() {
  const dir = join(process.env.HOME, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  const unit = join(dir, "session-sync-hub.service");
  writeFileSync(unit,
`[Unit]
Description=session-sync hub
After=network-online.target

[Service]
ExecStart=${NODE} ${SERVER} --host ${HOST} --port ${PORT}
Restart=always
Environment=SESSION_SYNC_DATA=${DATA}

[Install]
WantedBy=default.target
`);
  execSync("systemctl --user daemon-reload");
  execSync("systemctl --user enable --now session-sync-hub.service");
  console.log(`installed systemd --user unit ${unit} (run 'loginctl enable-linger $USER' to start before login)`);
}

function uninstallLinux() {
  try { execSync("systemctl --user disable --now session-sync-hub.service"); } catch {}
  const unit = join(process.env.HOME, ".config", "systemd", "user", "session-sync-hub.service");
  try { if (existsSync(unit)) unlinkSync(unit); } catch {}
  execSync("systemctl --user daemon-reload");
  console.log(`removed systemd --user unit ${unit}`);
}

function install() { isWin ? installWin() : isMac ? installMac() : installLinux(); }
function uninstall() { isWin ? uninstallWin() : isMac ? uninstallMac() : uninstallLinux(); }

// ── dispatch ─────────────────────────────────────────────────────────────────

const run = {
  status, start, stop, logs, install, uninstall,
  restart: async () => { await stop(); await new Promise((r) => setTimeout(r, 800)); await start(); },
};

(async () => {
  const fn = run[cmd];
  if (!fn) { console.error(`unknown command: ${cmd}\nuse: status | start | stop | restart | logs | install | uninstall`); process.exit(1); }
  try { await fn(); }
  catch (e) {
    console.error(`${cmd} failed: ${e.message}`);
    if ((cmd === "install" || cmd === "uninstall") && isWin)
      console.error(`(registering a Scheduled Task needs an elevated shell — re-run from an Administrator terminal)`);
    process.exit(1);
  }
})();
