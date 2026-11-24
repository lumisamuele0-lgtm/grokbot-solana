@echo off
chcp 65001 >nul
title GrokBot Solana
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js non e' installato. Si apre la pagina per scaricarlo:
  echo  installa la versione LTS, poi fai di nuovo doppio clic su questo file.
  start "" "https://nodejs.org/it/download"
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installazione dei componenti ^(solo la prima volta, 1-2 minuti^)...  
  call npm install --omit=dev
  if errorlevel 1 ( echo Installazione non riuscita. & pause & exit /b 1 )
)
set OPEN_BROWSER=1
node server.js
echo.
echo Il bot si e' fermato.
pause
