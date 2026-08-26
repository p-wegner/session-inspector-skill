<#
.SYNOPSIS
    Runs INSIDE the new Windows Terminal tab: resolves the profile, cd's to the
    target repo, and starts an interactive Claude session there.
.DESCRIPTION
    All of this lives in one .ps1 rather than an inline `-Command` string for one
    specific reason: Windows Terminal treats the ';' between PowerShell statements
    as its OWN command separator and tears the command apart. `powershell -File`
    with discrete arguments is the only spelling that survives. (Same trap, same
    fix, as claude-pick's cfork-profile.ps1 and session-inspector's launcher.)

    Never call this directly — `spawn.cmd` is the entry point; it is what opens the
    tab. Running this in the current shell would replace the session you are in.
#>
param(
    # The normal spelling since 2026-08-27: spawn.cmd stages EVERY parameter into one
    # JSON file (stage-launch.mjs) and passes only this path, because individual
    # arguments crossing cmd -> wt.exe -> PowerShell get re-split on ';' and lose
    # their quotes when empty (both bit real launches; on 2026-08-25 seeded handoff
    # sessions never took their first turn). The named parameters below stay for
    # direct callers and win over the file when both are given.
    [string]$ArgsFile,
    [string]$Path,
    [string]$Prompt,
    [string]$PromptFile,
    [string]$ProfileDir,
    [string]$SessionId,
    [string]$LaunchConfigDir,
    # RESUME an existing session instead of starting a fresh one. Exists so there
    # is exactly ONE launcher on this machine: session-inspector's session-resume
    # used to write its own .cmd, which set CLAUDE_CONFIG_DIR and nothing else —
    # so every session it relaunched inherited CLAUDE_CODE_CHILD_SESSION=1 from
    # the launching agent and SILENTLY saved no transcript, defeating the point of
    # resuming it. The scrub below is the reason to route through here.
    [string]$ResumeId,
    [switch]$DetectOnly,
    [switch]$NoPrompt,
    [switch]$SafeMode,
    [switch]$NoTrust,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Forward
)

# 'Continue', deliberately, NOT 'Stop'. This script's whole job is shelling out to
# native tools (node, git, claude), and under 'Stop' PowerShell 5.1 turns any line a
# native command writes to stderr into a terminating ErrorRecord. That killed the
# launcher on first use: trust-folder.mjs printed a SUCCESS message, PowerShell raised
# NativeCommandError, and the tab dropped to a prompt with claude never started.
# Errors here are handled by exit code, explicitly, where they occur.
$ErrorActionPreference = 'Continue'

# --- Args file ----------------------------------------------------------------
# Read FIRST, so everything below sees the same values regardless of how they
# arrived. An unreadable file is a hard stop: launching with silently-empty
# parameters is exactly the failure this file exists to close.
if ($ArgsFile) {
    if (-not (Test-Path -LiteralPath $ArgsFile)) {
        Write-Host "  [spawn-session] args file not found: $ArgsFile" -ForegroundColor Red
        Write-Host "  Press any key to close." -ForegroundColor DarkGray
        $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
        exit 1
    }
    try {
        $cfg = Get-Content -LiteralPath $ArgsFile -Raw | ConvertFrom-Json
    } catch {
        Write-Host "  [spawn-session] cannot parse args file: $ArgsFile" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
        Write-Host "  Press any key to close." -ForegroundColor DarkGray
        $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
        exit 1
    }
    if (-not $Path -and $cfg.path) { $Path = $cfg.path }
    if (-not $PromptFile -and $cfg.promptFile) { $PromptFile = $cfg.promptFile }
    if (-not $ProfileDir -and $cfg.profileDir) { $ProfileDir = $cfg.profileDir }
    if (-not $SessionId -and $cfg.sessionId) { $SessionId = $cfg.sessionId }
    if (-not $LaunchConfigDir -and $cfg.launchConfigDir) { $LaunchConfigDir = $cfg.launchConfigDir }
    if (-not $ResumeId -and $cfg.resumeId) { $ResumeId = $cfg.resumeId }
    if ($cfg.noPrompt) { $NoPrompt = $true }
    if ($cfg.safeMode) { $SafeMode = $true }
    if ($cfg.detectOnly) { $DetectOnly = $true }
    if ($cfg.noTrust) { $NoTrust = $true }
    if (-not $Forward -and $cfg.forward) { $Forward = @($cfg.forward) }
}

# The prompt arrives as a FILE, not as an argument, whenever the caller can manage it.
# Windows Terminal splits its command line on ';' *after* cmd/PowerShell quoting is
# already satisfied, so a correctly-quoted prompt containing a semicolon is torn in
# half and wt tries to run the remainder as a program. A path contains nothing wt
# reinterprets. -Prompt is kept for direct callers and short text.
if ($PromptFile) {
    if (Test-Path -LiteralPath $PromptFile) {
        try { $Prompt = [System.IO.File]::ReadAllText($PromptFile) } catch {
            Write-Host "  [spawn-session] cannot read prompt file: $PromptFile" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  [spawn-session] prompt file not found: $PromptFile" -ForegroundColor Yellow
    }
}

# --- The target repo ---------------------------------------------------------
if (-not $Path) {
    Write-Host "  [spawn-session] no target path resolved." -ForegroundColor Red
    Write-Host "  Press any key to close." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}
if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    # Refuse rather than starting a session in the wrong place: a Claude session
    # rooted at an unintended directory is worse than no session, because it reads
    # and may edit whatever IS there.
    Write-Host "  [spawn-session] not a directory: $Path" -ForegroundColor Red
    Write-Host "  Press any key to close." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}
Set-Location -LiteralPath $Path

# --- The profile ------------------------------------------------------------
# Default is INHERITED from the launching session (spawn.cmd passes its own
# CLAUDE_CONFIG_DIR), so the new session runs on the same account and sees the same
# skills. That matters for quota: silently landing on a different profile is how you
# discover mid-task that its usage limit was already spent.
function Resolve-Profile([string]$Want) {
    # A profile can be named several ways and the short ones are what a human types:
    # `5x_4`, `team5x_4`, `team_5x_4` and `andrena_team_5x_4` all mean
    # `.claude-andrena_team_5x_4`. So match on a NORMALISED form (lowercase, '-' and
    # '_' removed) rather than requiring the exact directory name — an exact-name-only
    # resolver silently fell back to the inherited profile for every short spelling,
    # which looks like the flag being ignored.
    if (-not $Want) { return $null }
    if (Test-Path -LiteralPath $Want -PathType Container) {
        return (Resolve-Path -LiteralPath $Want).Path
    }
    $norm = { param($t) ($t -replace '^\.claude[-_]?', '') -replace '[-_]', '' }
    $key = (& $norm $Want).ToLowerInvariant()
    $dirs = @(Get-ChildItem -Path $env:USERPROFILE -Directory -Filter ".claude*" -ErrorAction SilentlyContinue)

    # Exact normalised name first, so `.claude` itself and a full name always win
    # outright and can never be shadowed by a longer sibling that contains them.
    foreach ($d in $dirs) {
        if ((& $norm $d.Name).ToLowerInvariant() -eq $key) { return $d.FullName }
    }
    $hits = @($dirs | Where-Object { (& $norm $_.Name).ToLowerInvariant() -like "*$key*" })
    if ($hits.Count -eq 1) { return $hits[0].FullName }
    if ($hits.Count -gt 1) {
        # Ambiguous: refuse rather than pick. Landing on the wrong account is the
        # failure this flag exists to prevent.
        Write-Host "  [spawn-session] profile '$Want' is ambiguous:" -ForegroundColor Yellow
        foreach ($h in $hits) { Write-Host "      $($h.Name)" -ForegroundColor DarkGray }
        return $null
    }
    return $null
}

if ($ProfileDir) {
    $resolved = Resolve-Profile $ProfileDir
    if ($resolved) {
        $env:CLAUDE_CONFIG_DIR = $resolved
    } else {
        # Say so and continue on whatever was inherited: the point of the run is the
        # session, and a wrong-profile guess is worse than an announced fallback.
        Write-Host "  [spawn-session] profile '$ProfileDir' not resolved - using $($env:CLAUDE_CONFIG_DIR)" -ForegroundColor Yellow
        Start-Sleep -Milliseconds 1500
    }
}

# --- Inherit the launching session's permission mode -------------------------
# There is no environment variable for it, but the launching session's transcript
# records `permissionMode` on its entries, and the LAST value is the mode in force.
# (Same technique session-inspector's session-resume.mjs uses to relaunch a session
# the way it was actually running.) Without this, a session spawned from a bypass-mode
# parent comes up prompting for every tool call — which in practice means it stalls
# waiting for a human who is looking at a different tab.
$inheritedMode = ""
if ($SessionId) {
    try {
        # Look in the LAUNCHING session's config dir, never in $env:CLAUDE_CONFIG_DIR:
        # by this point that may already have been repointed by -p, and the launching
        # session's transcript does not live under the profile we are switching TO.
        # (Measured: `-p 5x_4` from a 5x_2 session found no transcript and silently
        # lost the inherited mode.) Falls back to sweeping every profile, since a
        # session id is unique across them.
        $roots = @()
        if ($LaunchConfigDir) { $roots += $LaunchConfigDir }
        $roots += @(Get-ChildItem -Path $env:USERPROFILE -Directory -Filter ".claude*" -ErrorAction SilentlyContinue |
                    ForEach-Object { $_.FullName })
        $t = $null
        foreach ($r in ($roots | Select-Object -Unique)) {
            $t = Get-ChildItem -Path (Join-Path $r "projects\*\$SessionId.jsonl") -ErrorAction SilentlyContinue |
                 Select-Object -First 1
            if ($t) { break }
        }
        if ($t) {
            # Scan from the END for the first hit: last value wins, and this avoids
            # parsing a multi-megabyte transcript. The pattern requires the UNESCAPED
            # JSON spelling, so a prose mention of `permissionMode` inside a message
            # body (escaped as \") cannot be mistaken for the real field.
            $lines = [System.IO.File]::ReadAllLines($t.FullName)
            for ($i = $lines.Length - 1; $i -ge 0; $i--) {
                if ($lines[$i] -match '"permissionMode"\s*:\s*"([A-Za-z]+)"') {
                    $inheritedMode = $Matches[1]
                    break
                }
            }
        }
    } catch { }
}

$modeArgs = @()
$modeLabel = ""
if ($SafeMode) {
    $modeLabel = "default (-safe given)"
} elseif ($inheritedMode -eq "bypassPermissions") {
    $modeArgs = @("--dangerously-skip-permissions")
    $modeLabel = "bypassPermissions (inherited)"
} elseif ($inheritedMode -eq "acceptEdits" -or $inheritedMode -eq "plan") {
    $modeArgs = @("--permission-mode", $inheritedMode)
    $modeLabel = "$inheritedMode (inherited)"
} elseif ($inheritedMode) {
    $modeLabel = "$inheritedMode (inherited)"
} else {
    $modeLabel = "default (not determined)"
}

# --- Pre-accept the folder-trust dialog --------------------------------------
# "Do you trust the files in this folder?" is a BLOCKING first-run prompt, per
# (profile, folder). Spawning into a profile that has never opened this repo — the
# normal case when handing work to another subscription — parks the new session on a
# question nobody is watching, turning an unattended handoff into a silent hang.
# Observed on first real use.
# Delegated to node, NOT done here: PS 5.1's ConvertTo-Json defaults to -Depth 2, so a
# round-trip through it would truncate a 60-100 KB nested .claude.json into rubbish.
$trustNote = ""
if (-not $NoTrust) {
    $trustScript = Join-Path $PSScriptRoot "trust-folder.mjs"
    if (Test-Path -LiteralPath $trustScript) {
        # No 2>&1 here - see the $ErrorActionPreference note at the top. The helper puts
        # its status on stdout precisely so this call does not need to touch stderr.
        $out = (& node $trustScript --config-dir "$env:CLAUDE_CONFIG_DIR" --path "$Path" | Out-String).Trim()
        if ($LASTEXITCODE -eq 0) {
            $trustNote = if ($out -like 'already-trusted*') { "already trusted" } else { "accepted for this profile" }
        } else {
            # Say so rather than launching into a prompt that will look like a hang.
            $trustNote = "COULD NOT PRE-ACCEPT - expect a trust prompt ($out)"
        }
    } else {
        $trustNote = "helper missing - expect a trust prompt if this profile is new here"
    }
} else {
    $trustNote = "skipped (-NoTrust)"
}

# --- Scrub the launching session's identity ----------------------------------
# `wt.exe` DOES hand the launching process's environment to the new tab, so a session
# spawned from inside Claude Code inherits that session's markers. Two symptoms, both
# reported on first use:
#   * `CLAUDECODE=1` / `CLAUDE_CODE_ENTRYPOINT` make the child believe it is nested,
#     so it drops to plain uncoloured output;
#   * `CLAUDE_CODE_CHILD_SESSION=1` turns TRANSCRIPT SAVING OFF - the new session's
#     work would not be resumable, which defeats the point of spawning it to carry
#     work forward.
# `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` are worse than cosmetic: they are the
# launching session's IPC pipe and its token, and nothing good comes of a second
# session holding them.
# Scrubbed rather than overridden, so the child looks like a session started by hand.
$inheritedMarkers = @(
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_PID',
    'CLAUDE_EFFORT'          # a fresh session should pick up its own default
)
$scrubbed = @()
foreach ($name in $inheritedMarkers) {
    if (Test-Path "env:$name") {
        $scrubbed += $name
        Remove-Item "env:$name" -ErrorAction SilentlyContinue
    }
}
# CLAUDE_CONFIG_DIR is deliberately NOT scrubbed - it is how the profile is carried,
# and it was resolved above. CLAUDE_CODE_ENABLE_TELEMETRY is a machine setting, not
# session state, so it stays too.

# Colour: with the nesting markers gone Claude Code detects a real terminal again.
# FORCE_COLOR is belt-and-braces for the layers underneath (the wt -> powershell
# hop can leave a child unsure it owns a TTY), and TERM only gets a value if the
# hop dropped it.
if (-not $env:FORCE_COLOR) { $env:FORCE_COLOR = '1' }
if (-not $env:TERM) { $env:TERM = 'xterm-256color' }
$env:CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'

# --- Banner -----------------------------------------------------------------
$profileLabel = if ($env:CLAUDE_CONFIG_DIR) { Split-Path $env:CLAUDE_CONFIG_DIR -Leaf } else { ".claude (default)" }
$branch = ""
try { $branch = (& git -C $Path rev-parse --abbrev-ref HEAD 2>$null) } catch { }
$dirty = ""
try {
    $st = (& git -C $Path status --porcelain 2>$null)
    if ($st) { $dirty = " (" + (($st -split "`n" | Where-Object { $_ }).Count) + " uncommitted)" }
} catch { }

Write-Host ""
Write-Host "  spawn-session" -ForegroundColor Cyan
Write-Host "  repo    : " -NoNewline -ForegroundColor DarkGray; Write-Host $Path
Write-Host "  branch  : " -NoNewline -ForegroundColor DarkGray; Write-Host "$branch$dirty"
Write-Host "  profile : " -NoNewline -ForegroundColor DarkGray; Write-Host $profileLabel
Write-Host "  trust   : " -NoNewline -ForegroundColor DarkGray
Write-Host $trustNote -ForegroundColor $(if ($trustNote -like "*COULD NOT*") { "Yellow" } else { "Gray" })
Write-Host "  perms   : " -NoNewline -ForegroundColor DarkGray
# Printed always, never only when permissive: an inherited bypass that nobody
# announced is the one outcome here worth being loud about.
Write-Host $modeLabel -ForegroundColor $(if ($modeArgs -contains "--dangerously-skip-permissions") { "Yellow" } else { "Gray" })
if ($scrubbed.Count -gt 0) {
    # Said out loud: a silent scrub is indistinguishable from a launcher that
    # forgot, and this is exactly the class of thing that goes unnoticed.
    Write-Host "  scrubbed: " -NoNewline -ForegroundColor DarkGray
    Write-Host "$($scrubbed.Count) inherited marker(s) - $($scrubbed -join ', ')" -ForegroundColor DarkGray
}
if ($ResumeId) {
    Write-Host "  resuming: " -NoNewline -ForegroundColor DarkGray
    Write-Host $ResumeId
} elseif (-not $NoPrompt -and $Prompt) {
    Write-Host "  seeded  : " -NoNewline -ForegroundColor DarkGray
    Write-Host $(if ($Prompt.Length -gt 90) { $Prompt.Substring(0, 90) + "..." } else { $Prompt })
}
Write-Host ""

if ($DetectOnly) {
    # Testability seam: everything resolved, nothing launched. Exists because the
    # profile lookup and the mode inheritance are the two things here that fail
    # SILENTLY - a wrong profile and a lost bypass both just look like a normal
    # session until you are deep into using it.
    Write-Host "  [spawn-session] detect-only; not launching." -ForegroundColor Cyan
    Write-Host "  resolved-profile=$($env:CLAUDE_CONFIG_DIR)"
    Write-Host "  detected-mode=$inheritedMode"
    Write-Host "  trust=$trustNote"
    Write-Host "  claude-args=$($modeArgs -join ' ')"
    exit 0
}

# --- Launch -----------------------------------------------------------------
# Interactive: no -p / --print. The prompt (when given) is a positional argument,
# which Claude Code treats as the first turn of an interactive session — so the
# session is seeded but still yours to steer.
$argv = @()
if ($ResumeId) {
    # A resume takes the session id and no seed: the conversation IS the context,
    # and a positional prompt alongside --resume would be a new first turn.
    $argv += @("--resume", $ResumeId)
} elseif (-not $NoPrompt -and $Prompt) {
    $argv += $Prompt
}
if ($modeArgs) { $argv += $modeArgs }
# Forwarded flags go LAST so an explicit one the caller typed wins over the inherited
# mode rather than being silently overridden by it.
if ($Forward) { $argv += $Forward }

try {
    if ($argv.Count -gt 0) { & claude @argv } else { & claude }
} catch {
    Write-Host ""
    Write-Host "  [spawn-session] claude failed to start: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Is 'claude' on PATH in this shell?" -ForegroundColor DarkGray
}

# -NoExit keeps the tab open after Claude exits, so a crash or a usage-limit
# banner is still readable instead of vanishing with the tab.
