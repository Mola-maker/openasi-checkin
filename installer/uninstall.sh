#!/usr/bin/env bash
# OpenASI 每日签到 — 卸载器
# 用法: bash installer/uninstall.sh [--purge]
#   --purge  同时删除登录状态/浏览器配置/日志 (不可恢复)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME}"
OPENCODE_DIR="${HOME_DIR}/.config/opencode"
CLAUDE_DIR="${HOME_DIR}/.claude"
CODEX_DIR="${HOME_DIR}/.codex"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

log() { printf '\033[1;36m[uninstall]\033[0m %s\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }

# OpenCode
rm -f "$OPENCODE_DIR/plugins/openasi-checkin.js"
rm -rf "$OPENCODE_DIR/skills/openasi-checkin"
log "OpenCode 集成已移除"

# Claude Code
rm -rf "$CLAUDE_DIR/skills/openasi-checkin"
rm -f "$CLAUDE_DIR/hooks/openasi-checkin-session-start.sh"
SETTINGS="$CLAUDE_DIR/settings.json"
if [ -f "$SETTINGS" ]; then
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    if (s.hooks?.SessionStart) {
      s.hooks.SessionStart = s.hooks.SessionStart.filter(g => !JSON.stringify(g).includes("openasi-checkin"));
      if (s.hooks.SessionStart.length === 0) delete s.hooks.SessionStart;
      if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
    }
    fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  ' "$SETTINGS"
  log "Claude settings.json hook 已移除"
fi

# Codex
if has codex; then
  codex plugin remove openasi-checkin@openasi-local >/dev/null 2>&1 && log "Codex 插件已移除" || true
  codex plugin marketplace remove openasi-local >/dev/null 2>&1 && log "Codex marketplace 已移除" || true
fi

# systemd
if has systemctl && systemctl --user status >/dev/null 2>&1; then
  systemctl --user disable --now openasi-checkin.timer >/dev/null 2>&1 || true
fi
rm -f "$HOME_DIR/.config/systemd/user/openasi-checkin.timer" "$HOME_DIR/.config/systemd/user/openasi-checkin.service"
has systemctl && systemctl --user daemon-reload >/dev/null 2>&1 || true
log "systemd timer 已移除"

# cron
if has crontab && crontab -l 2>/dev/null | grep -q "openasi-checkin"; then
  crontab -l 2>/dev/null | grep -v "openasi-checkin" | crontab - || true
  log "cron 任务已移除"
fi

rm -f "$SRC/install.json"

if [ "$PURGE" = 1 ]; then
  rm -rf "$SRC/state.json" "$SRC/browser-profile" "$SRC/checkin.log" "$SRC/hook.log" "$SRC/plugin.log" "$SRC/cron.log"
  log "已清除登录状态/浏览器配置/日志 (--purge)"
else
  log "保留登录状态与日志 (如需彻底清除: --purge)"
fi
