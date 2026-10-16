@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Vault for SSNS

echo ============================================================
echo   Vault - Partner Payout, Expense ^& Profit Distribution
echo ============================================================
echo.

REM --- Node check -------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js was not found on PATH.
  echo     Install Node.js 22.5 or newer from https://nodejs.org
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo [1/4] Node.js !NODE_VER!

REM --- .env -------------------------------------------------------------
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo [2/4] Created .env from .env.example
  ) else (
    echo [2/4] No .env and no .env.example - using built-in defaults
  )
) else (
  echo [2/4] .env found
)

REM --- Dependencies -----------------------------------------------------
if not exist "node_modules" (
  echo [3/4] Installing dependencies - this runs once and may take a minute...
  call npm install
  if !errorlevel! neq 0 (
    echo.
    echo [X] npm install failed. Fix the errors above and run start.bat again.
    echo.
    pause
    exit /b 1
  )
) else (
  echo [3/4] Dependencies present
)

REM --- Read PORT / HOST from .env so the browser opens the right URL ----
set "PORT=4000"
set "HOST=127.0.0.1"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    set "KEY=%%a"
    set "VAL=%%b"
    if /i "!KEY!"=="PORT" if not "!VAL!"=="" set "PORT=!VAL!"
    if /i "!KEY!"=="HOST" if not "!VAL!"=="" set "HOST=!VAL!"
  )
)
set "URL=http://!HOST!:!PORT!"

echo [4/4] Starting server on !URL!
echo.
echo       The backend serves the frontend - no second process needed.
echo       Press Ctrl+C in this window to stop.
echo.

REM --- Open the browser once the port is accepting connections --------
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "$h='!HOST!';$p=!PORT!;foreach($i in 1..60){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect($h,$p);$c.Close();Start-Process '!URL!';break}catch{Start-Sleep -Milliseconds 500}}"

REM --- Run in the foreground so logs stay visible and Ctrl+C stops it ---
node server/index.js

echo.
echo Server stopped.
pause
