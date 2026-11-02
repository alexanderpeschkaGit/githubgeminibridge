@echo off
pushd "%~dp0packages\userscript-hud"
if "%~1"==``` ( node scripts/build-userscript.mjs --bump=patch ) else ( node scripts/build-userscript.mjs --bump=%~1 )
popd

pushd "%~dp0"
git add -A
git commit -m "chore: bump userscript" 2>nul
git push origin main
popd

echo Userscript bumped, committed and pushed.
pause
