@echo off
rem ASCII-only on purpose: cmd.exe reads this file as GBK, so any non-ASCII
rem character here would corrupt the path. Do not add Chinese text to this file.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE%" goto run
set "NODE=node"

:run
echo Starting bridge (mock backend). Press Ctrl+C to stop.
echo.
"%NODE%" scripts\wire-host.mjs
echo.
echo Bridge stopped.
pause
