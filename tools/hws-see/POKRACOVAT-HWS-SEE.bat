@echo off
setlocal EnableExtensions
chcp 65001 >nul
for %%I in ("%~dp0..\..") do set "REPO_ROOT=%%~fI"
cd /d "%REPO_ROOT%"
if errorlevel 1 exit /b 1
if not exist "tools\hws-see\SPEC.md" (
  echo ERROR: Missing tools\hws-see\SPEC.md
  pause
  exit /b 1
)
where claude >nul 2>nul
if errorlevel 1 (
  echo ERROR: Claude Code CLI was not found.
  pause
  exit /b 1
)
echo Continue HWS SEE in ORIGINAL HWS repository: %CD%
call claude --permission-mode acceptEdits "Read tools/hws-see/SPEC.md and tools/hws-see/STATUS.md if present. Inspect actual code, git diff, tests and blockers. Continue the highest priority unfinished HWS SEE implementation. Respect EXACTLY TWO publication types: public link and server-verified PIN; no password mode. Preserve ABF, EASY, original login and unrelated changes. Run suitable tests/build and update STATUS.md. Never deploy, push, or migrate production DB."
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
