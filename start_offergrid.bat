@echo off
setlocal
cd /d "%~dp0"
title OfferGrid Local Server

if not exist "package.json" (
  echo ERROR: package.json not found.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not in PATH.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting OfferGrid locally...
echo http://localhost:3000
echo.
call npm start

echo.
echo OfferGrid stopped.
pause
endlocal
