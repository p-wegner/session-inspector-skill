# Hub service — run the session-sync hub persistently

`sync-server.mjs` run in a terminal dies when that terminal closes. To make the
hub a real always-on collector for your tailnet, `scripts/hub-service.mjs` wraps
it with a lifecycle CLI and an OS-native autostart entry. Node builtins only.

## What it manages

| Concern | How |
|---------|-----|
| Run detached | spawns `sync-server.mjs` with `detached:true` + `windowsHide:true`, `unref`'d, stdio → `hub.log` |
| Track it | writes `hub.pid` in the data dir; `status`/`stop` also locate the listener by port (language-agnostic `netstat`/`lsof`) |
| Survive reboot | registers an autostart entry per OS (below) |

All state lives under the data dir (`SESSION_SYNC_DATA`, default `~/.session-sync`):
`hub.pid`, `hub.log`, and on Windows `hub-autostart.vbs` (the hidden launcher the
Scheduled Task runs).

## Commands

```bash
node scripts/hub-service.mjs status      # running? indexed count? autostart installed? paths
node scripts/hub-service.mjs start       # spawn detached + hidden; no-op if already healthy
node scripts/hub-service.mjs stop        # kill the pid-file process and anything on the port
node scripts/hub-service.mjs restart     # stop then start
node scripts/hub-service.mjs logs -n 40  # tail hub.log
node scripts/hub-service.mjs install     # register OS autostart at logon/boot
node scripts/hub-service.mjs uninstall   # remove it
```

Honors the server's knobs: `SESSION_SYNC_PORT`, `SESSION_SYNC_DATA`, `--port`, `--host`.

## Autostart per OS

| OS | Mechanism | Notes |
|----|-----------|-------|
| **Windows** | Scheduled Task `SessionSyncHub` registered from task XML: a `LogonTrigger` **plus** a 1-minute repeating `TimeTrigger` heartbeat, `MultipleInstancesPolicy=IgnoreNew`, `RunLevel=LeastPrivilege`. Runs `wscript.exe hub-autostart.vbs` (window style 0 → no console) which **waits on** node and propagates its exit code. | `install`/`uninstall` call `schtasks` — task creation **needs an elevated shell** here. Validate via the crash test below. |
| **macOS** | launchd agent `~/Library/LaunchAgents/com.session-inspector.hub.plist`, `RunAtLoad` + `KeepAlive` | loaded via `launchctl load`. |
| **Linux** | systemd `--user` unit `~/.config/systemd/user/session-sync-hub.service`, `Restart=always` | enabled with `systemctl --user enable --now`. Run `loginctl enable-linger $USER` to start it before you log in. |

### Windows: why a heartbeat, not RestartOnFailure

Task Scheduler's `RestartOnFailure` triggers when the engine fails to **launch** the
action — **not** when the action exits non-zero. A crashed hub (node exits 1) leaves
the task `Ready` with `Last Result = 1` and never restarts. The reliable keep-alive
is instead a **repeating trigger + `IgnoreNew`**: while the hub is alive the waiting
`wscript` keeps one instance running so each minute's re-launch is ignored; when the
hub dies the launcher exits and the next tick (≤1 min) relaunches it.

A `LogonTrigger` alone is also insufficient: one created **after** you've logged in
won't fire (nor will its repetition) until the *next* logon, so a mid-session crash
wouldn't recover. The `TimeTrigger` (past `StartBoundary` + indefinite `PT1M`
repetition + `StartWhenAvailable`) is active continuously, independent of logon —
it even cold-starts the hub within ~1 min of `install`.

`RunLevel=LeastPrivilege` is deliberate: the hub needs no admin, and an elevated
long-running node can't be stopped by a normal-privilege `taskkill`/`hub-service stop`.

### Windows: run install elevated

Task creation and the firewall rule both need admin. Self-elevating one-liner (one
UAC click) for install:

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command',
  'node F:\path\to\session-inspector-skill\scripts\hub-service.mjs install'
```

## Tailnet firewall (Windows)

`--host 0.0.0.0` binds the hub to every interface, but Windows Defender Firewall
still blocks inbound on the Tailscale adapter (it sits on the **Private** profile).
Add one inbound-allow rule for the port, once, from an elevated shell:

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command',
  'New-NetFirewallRule -DisplayName "Session Sync Hub 8765" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 -Profile Any'
```

Then the hub is reachable at `http://<tailscale-ip>:8765/` from any tailnet device.
Keep it tailnet-only — the hub has no auth (see `session-sync.md` → Privacy / scope).

macOS/Linux personal firewalls are usually off by default; if yours is on, allow
the port on the tailscale interface the same way.

## Verifying

```bash
node scripts/hub-service.mjs status
# hub url   : http://0.0.0.0:8765/
# running   : yes — 271 sessions indexed
# port 8765 : 62380
# autostart : installed (win32)
```

Crash / self-heal test (Windows) — the real proof the keep-alive works: note the
listening pid (`status`), `taskkill /PID <pid> /F /T` to simulate a crash, then watch
`status` — within ≤1 min the heartbeat relaunches a **new** node pid with no console
window and no error dialog. Cold-start works the same way: right after `install`,
the hub appears on its own within ~1 min without any manual `/Run`.
