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
set "DRY="
set "SAFE="
set "DETECT="

:parse
if "%~1"=="" goto resolve
if defined NEEDMSG (
  set "MSG=%~1"
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
  echo   forward : %FWD%
  echo   prompt  : %MSG%
  exit /b 0
)

wt.exe %WINARG% -d "%DEST%" --title "claude %LEAF%" ^
  powershell -NoLogo -NoExit -ExecutionPolicy Bypass -File "%ROOT%spawn-session.ps1" ^
  -Path "%DEST%" -Prompt "%MSG%" -ProfileDir "%INHERIT%" ^
  -SessionId "%CLAUDE_CODE_SESSION_ID%" -LaunchConfigDir "%CLAUDE_CONFIG_DIR%" ^
  %BARE% %SAFE% %DETECT% %FWD%

if errorlevel 1 (
  echo [spawn] wt.exe failed. Is Windows Terminal installed and on PATH?
  exit /b 1
)
echo [spawn] opened: %DEST%
exit /b 0
