@echo off
echo ===============================================
echo   ZenTask - Building .exe
echo ===============================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed.
    echo Download it from https://nodejs.org and re-run this file.
    pause
    exit /b 1
)

echo Installing dependencies (first run only, this can take a minute
echo since uiohook-napi includes a native module that gets rebuilt
echo for Electron automatically via electron-builder)...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo ===============================================
    echo   npm install failed.
    echo   Most common cause: the native module ^(uiohook-napi^)
    echo   needs build tools. Try:
    echo     npm install --global windows-build-tools
    echo   or install "Desktop development with C++" via the
    echo   Visual Studio Build Tools installer, then re-run this file.
    echo ===============================================
    pause
    exit /b 1
)

echo.
echo Building portable .exe...
call npm run dist

echo.
echo ===============================================
echo   Done! dist\ZenTask.exe is your app.
echo.
echo   That ONE file is everything. To share ZenTask with
echo   someone else, just send them dist\ZenTask.exe -- they
echo   don't need Node.js, npm, or anything else. They just
echo   double-click it and it runs.
echo.
echo   Note: Windows Defender / your antivirus may flag it on
echo   first run since it's an unsigned auto-clicker/macro tool -
echo   that's a false positive from the behavior pattern, not a
echo   virus, but you may need to click "More info -^> Run anyway"
echo   or add an exclusion.
echo ===============================================
pause

