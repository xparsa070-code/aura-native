@echo off
setlocal
title Building AURA (native)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node
goto have_node

:no_node
echo Node.js not found. Trying to install it via winget...
where winget >nul 2>nul
if errorlevel 1 goto no_winget
winget install --id OpenJS.NodeJS.LTS -e --source winget --silent --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto winget_failed
echo.
echo Node.js installed. Close this window and run BUILD.bat again
echo so the new PATH is picked up in a fresh session.
pause
exit /b 0

:winget_failed
echo.
echo [ERROR] Automatic install failed (probably no access to the winget source).
echo         Install Node.js LTS manually from https://nodejs.org and run this again.
pause
exit /b 1

:no_winget
echo [ERROR] winget not available on this system.
echo         Install Node.js LTS manually from https://nodejs.org and run this again.
pause
exit /b 1

:have_node
echo Node version:
call node -v
echo npm version:
call npm -v
echo.
echo [INFO] naudiodon is a native module. If npm install fails below, you likely
echo        need Python 3 and Visual Studio Build Tools (Desktop development
echo        with C++). See README.txt for details.
echo.

if exist node_modules goto deps_ok
echo Installing dependencies, please wait...
call npm install --no-audit --no-fund
if errorlevel 1 goto npm_failed
goto ask_mode

:deps_ok
echo Dependencies already installed, skipping...

:ask_mode
echo.
set "RUNMODE="
set /p RUNMODE=Run directly now instead of building an EXE? (y/N): 
if /i "%RUNMODE%"=="y" goto run_direct

echo Building EXE...
call npm run dist
if errorlevel 1 goto build_failed
echo.
echo Done! Opening the dist folder...
start "" "dist"
pause
exit /b 0

:run_direct
call npm start
pause
exit /b 0

:npm_failed
echo.
echo [ERROR] npm install failed. See README.txt for the native-module build requirements.
pause
exit /b 1

:build_failed
echo.
echo [ERROR] Build failed. Check the messages above.
pause
exit /b 1
