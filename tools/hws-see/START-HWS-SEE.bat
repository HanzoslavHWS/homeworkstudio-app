@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem This file belongs inside EXISTING HWS repository: <repo>\tools\hws-see\
for %%I in ("%~dp0..\..") do set "REPO_ROOT=%%~fI"
cd /d "%REPO_ROOT%"
if errorlevel 1 (
  echo ERROR: Cannot open project directory: %REPO_ROOT%
  pause
  exit /b 1
)

if not exist "package.json" if not exist "pnpm-workspace.yaml" (
  echo ERROR: Repository root must contain package.json or pnpm-workspace.yaml.
  echo Move/extract this folder into the ORIGINAL HWS repo, NOT the ABF DEV repo.
  echo Current folder: %CD%
  pause
  exit /b 1
)
if not exist "tools\hws-see\SPEC.md" (
  echo ERROR: Missing tools\hws-see\SPEC.md
  pause
  exit /b 1
)
where claude >nul 2>nul
if errorlevel 1 (
  echo ERROR: Claude Code CLI is not found in PATH.
  echo Verify with: claude --version
  pause
  exit /b 1
)

echo ============================================================
echo HWS SEE - Claude Code implementation starter
echo Working repository: %CD%
echo Specification: tools\hws-see\SPEC.md
echo IMPORTANT: ORIGINAL HWS; NOT ABF DEV
 echo ============================================================
echo Claude must inspect architecture and work in separate feature branch.
echo NO auto deploy, push, destructive migration, or secret exposure.
echo.
where git >nul 2>nul
if not errorlevel 1 (
  git status --short
  echo.
  echo Existing changes shown above must NOT be discarded.
)

echo Enter START to launch Claude. Press Enter to cancel.
set /p "CONFIRM=Choice: "
if /I not "%CONFIRM%"=="START" exit /b 0

call claude --permission-mode acceptEdits "Read tools/hws-see/SPEC.md completely. First inspect the actual repository structure, home screen, current light portal login and any admin registry. Implement HWS SEE as a new module beside HWS EASY IN THE EXISTING ORIGINAL HWS APP, not ABF DEV and not a separate application. Public sharing has EXACTLY TWO modes: open to anyone with link or protected by server-verified numeric PIN; no third password mode. Implement actual code starting from P0, then P1/P2 when feasible. Preserve existing features, auth, secrets and unrelated edits. Do not push, deploy, modify production DB or DNS. Write tools/hws-see/IMPLEMENTATION.md and tools/hws-see/STATUS.md with tested progress and blockers."
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Claude exited with code %EXIT_CODE%.
echo Inspect tools\hws-see\STATUS.md and git diff before deploying.
pause
exit /b %EXIT_CODE%
