@echo off
cd /d "%~dp0"
node scripts\deploy-all.mjs
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Pipeline failed with exit code %errorlevel%!
    pause
    exit /b %errorlevel%
)
echo.
pause
