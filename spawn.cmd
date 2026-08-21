@echo off
rem Plain setlocal, NOT EnableDelayedExpansion: delayed expansion eats '!' in a
rem user-supplied -m prompt, which is a silent corruption of the seed text.
setlocal
rem ===========================================================================
rem spawn.cmd - open a NEW interactive Claude session in another repo, in a
rem Windows Terminal tab, without disturbing the session you are in.
rem
rem   spawn                        code-metrics-skill, seeded to continue its work
rem   spawn code-metrics           same, named explicitly
rem   spawn C:\projects\foo        any path
rem   spawn agentic-kanban -m "fix the flaky test"
rem   spawn code-metrics -W        brand-new WINDOW instead of a tab
rem   spawn code-metrics -b        bare session, no seed prompt
rem   spawn code-metrics -p 5x_4   a specific Claude profile (short names work)
rem   spawn code-metrics -safe     do not inherit this session's permission mode
rem   spawn code-metrics -dsp      forward --dangerously-skip-permissions
rem
rem Target resolution, in order: an existing path, then C:\projects\andrena\<name>,
rem then C:\projects\andrena\<name>-skill. That last hop is why `code-metrics`
rem finds `code-metrics-skill`.
rem
rem The launching and the launched work are deliberately split: this file only
rem opens the tab, spawn-session.ps1 runs inside it. Windows Terminal treats ';'
rem as its own command separator, so an inline PowerShell -Command string gets
rem torn apart - `powershell -File` with discrete args is the only spelling that
rem survives.
rem ===========================================================================

set "ROOT=%~dp0"
set "TARGET="
set "MSG="
set "PROF="
set "WINARG=-w 0 nt"
set "BARE="
set "FWD="
set "NEEDMSG="
set "NEEDPROF="
set "USERNOTE="
set "DRY="
set "SAFE="
set "DETECT="
set "HANDOFF="
set "NOTRUST="
set "WAIT="

:parse
if "%~1"=="" goto resolve
if defined NEEDMSG (
  set "MSG=%~1"
  rem Tracked separately from MSG: MSG acquires a DEFAULT seed prompt below, and feeding
  rem that default to the brief as "what the outgoing session was doing" would put words
  rem in its mouth. Only text the caller actually typed is a note.
  set "USERNOTE=%~1"
  set "NEEDMSG="
  shift
  goto parse
)
if defined NEEDPROF (
  set "PROF=%~1"
  set "NEEDPROF="
  shift
  goto parse
)
if /i "%~1"=="-m" (
  set "NEEDMSG=1"
) else if /i "%~1"=="-p" (
  set "NEEDPROF=1"
) else if /i "%~1"=="-W" (
  rem -w -1 : always a brand-new window. Default is a TAB in the current window,
  rem which is the quieter choice - a new window steals focus and, on this machine,
  rem window-flashing launches are what kill other agents' dev servers.
  set "WINARG=-w -1"
) else if /i "%~1"=="-b" (
  set "BARE=-NoPrompt"
) else if /i "%~1"=="-n" (
  set "DRY=1"
) else if /i "%~1"=="-safe" (
  set "SAFE=-SafeMode"
) else if /i "%~1"=="-handoff" (
  rem full handoff: write a brief, seed the new session with it, then WAIT and report
  rem which session picked the work up. The identity is the whole point - without it
  rem the launcher can only say "I opened a tab", never "your work is now with X".
  set "HANDOFF=1"
  set "WAIT=1"
) else if /i "%~1"=="-wait" (
  set "WAIT=1"
) else if /i "%~1"=="-notrust" (
  set "NOTRUST=-NoTrust"
) else if /i "%~1"=="-detect" (
  rem opens a tab that resolves everything and prints it WITHOUT starting claude
  set "DETECT=-DetectOnly"
) else if /i "%~1"=="-dsp" (
  set "FWD=%FWD% --dangerously-skip-permissions"
) else if /i "%~1"=="-h" (
  goto usage
) else if /i "%~1"=="--help" (
  goto usage
) else if not defined TARGET (
  set "TARGET=%~1"
) else (
  set "FWD=%FWD% %~1"
)
shift
goto parse

:usage
echo spawn [target] [-m "prompt"] [-p profile] [-W] [-b] [-dsp] [extra claude args]
echo.
echo   target   path, or a name under C:\projects\andrena (with or without -skill).
echo            Default: code-metrics-skill.
echo   -m       seed the first turn with this prompt.
echo   -p       Claude profile (name, .claude-NAME, or a full path). Default: inherit.
echo   -W       new WINDOW instead of a new tab.
echo   -b       bare - no seed prompt.
echo   -dsp     forward --dangerously-skip-permissions.
echo   -n       dry run - print what would be launched, spawn nothing.
echo   -safe    do NOT inherit this session's permission mode; start in default mode.
echo   -detect  open a tab that resolves profile+mode and prints them, without claude.
echo   -handoff write a handoff brief, seed the new session with it, then wait and
echo            report WHICH session took over (implies -wait). For quota handoffs.
echo   -wait    wait for the new session to register on the ACP bus and name it.
echo   -notrust do not pre-accept the folder-trust dialog.
exit /b 0

:resolve
if not defined TARGET set "TARGET=code-metrics"

set "DEST="
if exist "%TARGET%\" set "DEST=%TARGET%"
if not defined DEST if exist "C:\projects\andrena\%TARGET%\" set "DEST=C:\projects\andrena\%TARGET%"
if not defined DEST if exist "C:\projects\andrena\%TARGET%-skill\" set "DEST=C:\projects\andrena\%TARGET%-skill"

if not defined DEST (
  echo [spawn] cannot resolve target: %TARGET%
  echo         tried the path itself, C:\projects\andrena\%TARGET%, and -skill.
  exit /b 1
)

rem Absolute, canonical form - the .ps1 refuses a path it cannot Test-Path, and a
rem relative one would resolve against the NEW tab's working directory, not this one.
for %%I in ("%DEST%") do set "DEST=%%~fI"
for %%I in ("%DEST%") do set "LEAF=%%~nxI"

if not defined MSG set "MSG=Read CONTINUE.md and BACKLOG.md at the repo root, plus CLAUDE.md if present, then continue the work they describe. Begin by telling me the current state, what is verified vs merely claimed, and what you propose to do next - do not start editing until I confirm."

rem --- handoff brief -------------------------------------------------------------
rem Written before the tab opens so the seed prompt can point at a file that exists.
rem NOT wrapped in `if defined HANDOFF ( ... )`: cmd parses a parenthesized block as ONE
rem command and expands %HOFILE% inside it BEFORE the block runs, so the seed prompt
rem would name an empty path. A label keeps the code straight-line and the expansion
rem correct. (Delayed expansion would also fix it, and would then eat '!' in the note.)
if not defined HANDOFF goto :nohandoff

set "HOFILE="
for /f "usebackq delims=" %%H in (`node "%ROOT%make-handoff.mjs" --session "%CLAUDE_CODE_SESSION_ID%" --config-dir "%CLAUDE_CONFIG_DIR%" --target "%DEST%" --note "%USERNOTE%"`) do set "HOFILE=%%H"
if not defined HOFILE (
  echo [spawn] could not write the handoff brief - aborting rather than spawning a
  echo         session that believes it received one.
  exit /b 1
)
set "MSG=You are TAKING OVER work from another Claude session. Read the handoff brief at %HOFILE% first, then CONTINUE.md / BACKLOG.md / CLAUDE.md in this repo. Report the state you actually find - separating what you verified from what the brief merely claims - and what you propose to do next. Do not edit until I confirm. The outgoing session may still be reachable over ACP; the brief says how."

:nohandoff

rem Which profile the new session runs on. An explicit -p wins; otherwise inherit
rem THIS shell's CLAUDE_CONFIG_DIR so the new session lands on the same account and
rem sees the same skills. Passing it as an ARGUMENT is load-bearing: wt.exe does not
rem hand this shell's environment to the new tab, so an inherited env var would be
rem silently lost and the session would come up on the default profile.
set "INHERIT=%CLAUDE_CONFIG_DIR%"
if defined PROF set "INHERIT=%PROF%"

if defined DRY (
  echo [spawn] DRY RUN - nothing spawned
  echo   target  : %DEST%
  echo   title   : claude %LEAF%
  echo   window  : %WINARG%
  echo   profile : %INHERIT%
  echo   bare    : %BARE%
  echo   session : %CLAUDE_CODE_SESSION_ID%  - permission mode read from its transcript
  echo   safe    : %SAFE%
  echo   handoff : %HANDOFF%   wait: %WAIT%   notrust: %NOTRUST%
  echo   forward : %FWD%
  echo   prompt  : %MSG%
  echo   via-file: staged at spawn time to keep wt away from any semicolon
  exit /b 0
)

rem Move the prompt OFF the wt command line. wt splits on ';' after cmd quoting is
rem already satisfied, so a prompt containing a semicolon gets torn in half and wt tries
rem to execute the tail. Measured: the default handoff prompt said "over ACP; the brief
rem says how" and wt failed with 0x80070002 trying to start `" the brief says how." ...`.
rem A file path contains nothing wt reinterprets, so this closes the whole class.
set "PROMPTFILE="
if defined BARE goto :noprompt
for /f "usebackq delims=" %%P in (`node "%ROOT%write-text.mjs" --out "%TEMP%\spawn-prompt-%RANDOM%%RANDOM%.txt" --text "%MSG%"`) do set "PROMPTFILE=%%P"
if not defined PROMPTFILE (
  echo [spawn] could not stage the prompt file - aborting rather than spawning a
  echo         session with a silently truncated prompt.
  exit /b 1
)
:noprompt

rem Snapshot the ACP roster BEFORE spawning: the new session's id does not exist yet,
rem so "which name is new" is the only way to learn who took the work.
set "BASE=%TEMP%\spawn-acp-baseline-%RANDOM%.txt"
if defined WAIT node "%ROOT%wait-for-agent.mjs" --snapshot "%BASE%" --cwd "%DEST%"

wt.exe %WINARG% -d "%DEST%" --title "claude %LEAF%" ^
  powershell -NoLogo -NoExit -ExecutionPolicy Bypass -File "%ROOT%spawn-session.ps1" ^
  -Path "%DEST%" -PromptFile "%PROMPTFILE%" -ProfileDir "%INHERIT%" ^
  -SessionId "%CLAUDE_CODE_SESSION_ID%" -LaunchConfigDir "%CLAUDE_CONFIG_DIR%" ^
  %BARE% %SAFE% %DETECT% %NOTRUST% %FWD%

if errorlevel 1 (
  echo [spawn] wt.exe failed. Is Windows Terminal installed and on PATH?
  exit /b 1
)
echo [spawn] opened: %DEST%

if not defined WAIT exit /b 0

echo [spawn] waiting for the new session to register on the ACP bus...
set "NEWAGENT="
for /f "usebackq delims=" %%A in (`node "%ROOT%wait-for-agent.mjs" --wait "%BASE%" --cwd "%DEST%" --timeout 120`) do set "NEWAGENT=%%A"
if exist "%BASE%" del "%BASE%" >nul 2>&1

if not defined NEWAGENT (
  echo [spawn] the new session could not be identified. It may still be starting.
  echo         Do NOT treat this as a completed handoff - check the tab, then run
  echo         `node "C:/projects/andrena/acp/acp.js" list` yourself.
  exit /b 2
)

echo.
echo [spawn] HANDOFF RECEIPT
echo   continued by : %NEWAGENT%
echo   repo         : %DEST%
if defined HOFILE echo   brief        : %HOFILE%
echo   reach it     : node "C:/projects/andrena/acp/acp.js" send --to %NEWAGENT% --msg "..."
echo.
echo [spawn] The new session is live and addressable. This session's work is handed
echo         over; it is safe to close once you have nothing else in flight.
exit /b 0
