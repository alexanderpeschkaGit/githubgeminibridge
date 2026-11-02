@echo off
pushd "%~dp0"
git add -A
git commit -m "chore: release" 2>nul
git push origin main
popd

call "%~dp0release-userscript.bat" patch
call "%~dp0deploy-worker.bat"
