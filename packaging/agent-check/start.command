#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ARCH=$(uname -m)

case "$ARCH" in
  arm64)
    NODE="$ROOT/runtime/arm64/bin/node"
    ;;
  x86_64)
    NODE="$ROOT/runtime/x64/bin/node"
    ;;
  *)
    echo "[错误] 不支持的 Mac 架构：$ARCH"
    echo "当前安装包只支持 Apple Silicon 和 Intel Mac。"
    printf "按回车键关闭……"
    read answer
    exit 1
    ;;
esac

APP="$ROOT/app/diagnostics-server.js"
export ENV_FILE="$ROOT/config.env"
CHECK_URL="http://localhost:4173/api/health"
OPEN_URL="http://localhost:4173/agent-check"

if [ ! -x "$NODE" ]; then
  echo "[错误] 找不到可执行的内置 Node.js：$NODE"
  echo "请重新解压完整的 macOS 安装包，或按使用说明恢复执行权限。"
  printf "按回车键关闭……"
  read answer
  exit 1
fi

if [ ! -f "$APP" ]; then
  echo "[错误] 找不到自测台程序：$APP"
  echo "请重新解压完整的 macOS 安装包。"
  printf "按回车键关闭……"
  read answer
  exit 1
fi

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "正在启动 Agent Card 自测台……"
echo "页面地址：$OPEN_URL"
echo "停止服务：回到此窗口按 Ctrl+C。"

"$NODE" "$APP" &
SERVER_PID=$!

i=0
while [ "$i" -lt 40 ]; do
  if curl --fail --silent --max-time 1 "$CHECK_URL" >/dev/null 2>&1; then
    open "$OPEN_URL"
    wait "$SERVER_PID"
    exit $?
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID"
    exit $?
  fi
  i=$((i + 1))
  sleep 0.25
done

echo "[错误] 自测台未能在 10 秒内启动。"
echo "常见原因：4173 端口已被占用，或安装包文件不完整。"
exit 1
