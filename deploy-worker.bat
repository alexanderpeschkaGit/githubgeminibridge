@echo off
pushd "%~dp0packages\edge-worker"
npx wrangler deploy
popd
pause
