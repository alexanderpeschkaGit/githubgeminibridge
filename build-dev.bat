@echo off
cd /d "%~dp0"
echo [Build Dev] Compiling Userscript without version bump...
node packages\userscript-hud\scripts\build-userscript.mjs
if %errorlevel% neq 0 (
    echo [ERROR] Build failed!
    pause
    exit /b %errorlevel%
)
echo [DONE] gemini-bridge.user.js updated! Reload Gemini in browser (F5).
