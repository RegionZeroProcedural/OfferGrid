@echo off
setlocal
cd /d "%~dp0"
title OfferGrid LIVE - offergrid.tech

if not exist "package.json" (
  echo ERROR: package.json not found.
  echo This BAT must stay in the OfferGrid project root.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not in PATH.
  pause
  exit /b 1
)

if not exist ".env" (
  echo.
  echo No .env file exists yet.
  echo Creating .env from .env.live.example...
  copy /Y ".env.live.example" ".env" >nul
  echo.
  echo IMPORTANT:
  echo 1. Open .env
  echo 2. Change ADMIN_PASSWORD
  echo 3. Run: npm run secrets
  echo 4. Copy the generated SESSION_SECRET and CONFIG_ENCRYPTION_KEY into .env
  echo 5. Run this BAT again
  echo.
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

rem Environment values here intentionally override a copied local .env.
set NODE_ENV=production
set HOST=127.0.0.1

echo.
echo Running production readiness check...
call npm run check:live
if errorlevel 1 (
  echo.
  echo LIVE START ABORTED.
  echo Fix the failed checks above before exposing OfferGrid publicly.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo OfferGrid LIVE
echo Public: https://www.offergrid.tech
echo Origin: http://127.0.0.1:3000
echo Cloudflare Tunnel should point to that origin.
echo ============================================
echo.
echo Press Ctrl+C to stop OfferGrid.
echo.

call npm start

echo.
echo OfferGrid live server stopped.
pause
endlocal
