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
| **Windows** | Scheduled Task `SessionSyncHub`, trigger `ONLOGON`, runs `wscript.exe hub-autostart.vbs` (style 0 → no console window) | `install`/`uninstall` call `schtasks` with `/RL HIGHEST`, which **needs an elevated shell**. Validate with `schtasks /Run /TN SessionSyncHub`. |
| **macOS** | launchd agent `~/Library/LaunchAgents/com.session-inspector.hub.plist`, `RunAtLoad` + `KeepAlive` | loaded via `launchctl load`. |
| **Linux** | systemd `--user` unit `~/.config/systemd/user/session-sync-hub.service`, `Restart=always` | enabled with `systemctl --user enable --now`. Run `loginctl enable-linger $USER` to start it before you log in. |

### Windows: run install elevated

`schtasks /Create /RL HIGHEST` and the firewall rule both need admin. Self-elevating
one-liner (one UAC click) for install:

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

End-to-end check of the autostart path (Windows): `node hub-service.mjs stop`, then
`schtasks /Run /TN SessionSyncHub`, then `status` again — the hub should come back
with no console window and no error dialog.
