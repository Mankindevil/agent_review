@echo off
chcp 65001 >nul
setlocal

set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\node.exe"
set "APP=%ROOT%app\diagnostics-server.js"
set "ENV_FILE=%ROOT%config.env"
set "CHECK_URL=http://localhost:4173/api/health"
set "OPEN_URL=http://localhost:4173/agent-check"

if not exist "%NODE%" (
  echo [ERROR] Bundled Node.js was not found: %NODE%
  echo Please extract the complete Windows package and try again.
  pause
  exit /b 1
)

if not exist "%APP%" (
  echo [ERROR] Agent Check application was not found: %APP%
  echo Please extract the complete Windows package and try again.
  pause
  exit /b 1
)

echo Starting Agent Card Check...
echo Page: %OPEN_URL%
echo To stop: return to this window and press Ctrl+C.

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command ^
  "$health='%CHECK_URL%'; $page='%OPEN_URL%';" ^
  "for($i=0;$i -lt 40;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 $health;if($r.StatusCode -eq 200){Start-Process $page;exit 0}}catch{};Start-Sleep -Milliseconds 250};exit 1"

"%NODE%" "%APP%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Agent Card Check exited with code %EXIT_CODE%.
  echo Port 4173 may already be in use, or the package may be incomplete.
  pause
)

exit /b %EXIT_CODE%
