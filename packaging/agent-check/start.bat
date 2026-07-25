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
  echo [错误] 找不到内置 Node.js：%NODE%
  echo 请重新解压完整的 Windows 安装包。
  pause
  exit /b 1
)

if not exist "%APP%" (
  echo [错误] 找不到自测台程序：%APP%
  echo 请重新解压完整的 Windows 安装包。
  pause
  exit /b 1
)

echo 正在启动 Agent Card 自测台……
echo 页面地址：%OPEN_URL%
echo 停止服务：回到此窗口按 Ctrl+C。

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command ^
  "$health='%CHECK_URL%'; $page='%OPEN_URL%';" ^
  "for($i=0;$i -lt 40;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 $health;if($r.StatusCode -eq 200){Start-Process $page;exit 0}}catch{};Start-Sleep -Milliseconds 250};exit 1"

"%NODE%" "%APP%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [错误] 自测台启动失败，退出码：%EXIT_CODE%
  echo 常见原因：4173 端口已被占用，或安装包文件不完整。
  pause
)

exit /b %EXIT_CODE%
