#!/usr/bin/env bash
# OpenASI 每日签到 — Claude Code SessionStart hook 包装脚本
# 非阻塞: 后台触发轻量版签到脚本后立即返回 0, 不拖慢会话启动。
# 轻量版 token 失效时会自动回退到完整版 (Playwright 浏览器刷新), 全程后台执行。
set -u

RUNNER="$HOME/.local/share/openasi-checkin/checkin-lite.mjs"
LOG="$HOME/.local/share/openasi-checkin/hook.log"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="/usr/local/bin/node"
fi

if [ -f "$RUNNER" ] && [ -x "$NODE_BIN" ]; then
  if command -v setsid >/dev/null 2>&1; then
    ( setsid "$NODE_BIN" "$RUNNER" --if-not-today --quiet >>"$LOG" 2>&1 & ) >/dev/null 2>&1
  else
    ( nohup "$NODE_BIN" "$RUNNER" --if-not-today --quiet >>"$LOG" 2>&1 & ) >/dev/null 2>&1
  fi
fi

exit 0
