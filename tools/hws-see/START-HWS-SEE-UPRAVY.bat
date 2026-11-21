@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

REM HWS SEE - UI improvements. Run from within the HWS APP WEB repository.
REM This script starts Claude Code. It does not change files, branch or deploy by itself.
cd /d "%~dp0\..\.." || goto :wrong_folder

for %%I in ("%CD%") do set "REPO_NAME=%%~nxI"
if /I not "%REPO_NAME%"=="homeworkstudio-app-web" goto :wrong_folder
if not exist "tools\hws-see\HWS_SEE_UI_UPRAVY.md" goto :missing_spec
if not exist "tools\hws-see\reference-viewer-markup.png" goto :missing_reference

where git >nul 2>&1
if errorlevel 1 goto :missing_git
where claude >nul 2>&1
if errorlevel 1 goto :missing_claude

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto :wrong_folder

for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "ACTIVE_BRANCH=%%B"
if /I not "%ACTIVE_BRANCH%"=="feature/hws-see-mvp" goto :wrong_branch

git cat-file -e 2a533de >nul 2>&1
if errorlevel 1 goto :missing_commit

echo.
echo ===========================================================
echo   HWS SEE - NAVAZUJICI UPRAVY UI
echo ===========================================================
echo   Projekt: %CD%
echo   Vetev:  %ACTIVE_BRANCH%
echo   Zadani: tools\hws-see\HWS_SEE_UI_UPRAVY.md
echo.
echo   Claude bude mit za ukol:
echo   - dynamicke sceny 1 + dalsi, zadny limit tri
echo   - nove ikony, kamerove pohledy a volitelny panel
echo   - obrazky a odkazy v popiscich
echo   - lokalni testy a lokalni commit, bez deploymentu
echo ===========================================================
echo.
echo Aktuální zmeny (pokud nejake existuji):
git status --short
echo.

claude "Read tools/hws-see/HWS_SEE_UI_UPRAVY.md completely and inspect tools/hws-see/reference-viewer-markup.png. Implement all requested HWS SEE refinements in this repository on the current feature branch. Follow every safety restriction, preserve existing behavior and data, test thoroughly, and produce a concise final report. Do not push, deploy, or modify external services."
set "CODE=%ERRORLEVEL%"
echo.
echo Claude Code skoncil (navratovy kod: %CODE%).
if not "%CODE%"=="0" echo Zkontroluj vypis v terminalu.
pause
exit /b %CODE%

:wrong_folder
echo CHYBA: Spust tento BAT z tools\hws-see v puvodnim projektu homeworkstudio-app-web.
echo Pozadovany projekt: C:\Users\Hanz\Documents\Hanz_projekt\homeworkstudio-app-web
pause
exit /b 2
:wrong_branch
echo CHYBA: Aktivni vetev je "%ACTIVE_BRANCH%". Pozadovana: feature/hws-see-mvp.
echo Neprovadim automaticke prepinani vetev. Prejdi na spravnou vetev rucne.
pause
exit /b 3
:missing_spec
echo CHYBA: Chybi zadani tools\hws-see\HWS_SEE_UI_UPRAVY.md. Rozbal cely ZIP do korene projektu.
pause
exit /b 4
:missing_reference
echo CHYBA: Chybi referencni screenshot. Rozbal cely ZIP do korene projektu.
pause
exit /b 5
:missing_git
echo CHYBA: Git neni dostupny v PATH.
pause
exit /b 6
:missing_claude
echo CHYBA: Prikaz claude neni dostupny v PATH. Over instalaci Claude Code.
pause
exit /b 7
:missing_commit
echo CHYBA: V repozitari neni nalezen vychozi commit 2a533de.
echo Prover, zda jsi ve spravnem HWS APP WEB projektu.
pause
exit /b 8
