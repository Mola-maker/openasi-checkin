#!/usr/bin/env bash
# OpenASI 每日签到 — 多平台安装器
# 支持: OpenCode (skill+plugin hook) / Claude Code (skill+SessionStart hook) / Codex (marketplace+plugin)
#       以及系统级定时器 (systemd user timer 或 cron) 作为兜底触发。
#
# 用法: bash installer/install.sh [选项]
#   --platforms auto|all|opencode,claude,codex   选择安装的平台 (默认 auto: 自动检测)
#   --schedule  auto|systemd|cron|none           系统定时器 (默认 auto: 有 systemd 用 systemd, 否则 cron)
#   --with-agents-md                             额外向 ~/.codex/AGENTS.md 写入提示 (可选)
#   --skip-deps                                  跳过 npm 依赖安装
#   --dry-run                                    只打印将执行的操作
#   -h, --help                                   帮助
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME}"
OPENCODE_DIR="${HOME_DIR}/.config/opencode"
CLAUDE_DIR="${HOME_DIR}/.claude"
CODEX_DIR="${HOME_DIR}/.codex"
STAMP="$(date +%Y%m%d%H%M%S)"

PLATFORMS="auto"
SCHEDULE="auto"
WITH_AGENTS_MD=0
SKIP_DEPS=0
DRY_RUN=0
SCHEDULE_METHOD="none"

log()  { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --platforms) PLATFORMS="${2:?}"; shift 2;;
    --schedule)  SCHEDULE="${2:?}"; shift 2;;
    --with-agents-md) WITH_AGENTS_MD=1; shift;;
    --skip-deps) SKIP_DEPS=1; shift;;
    --dry-run)   DRY_RUN=1; shift;;
    -h|--help)   usage; exit 0;;
    *) err "未知参数: $1"; usage; exit 1;;
  esac
done

has() { command -v "$1" >/dev/null 2>&1; }

# 规范安装位置守卫: 平台 hook/plugin 按规范路径引用脚本
CANONICAL="$HOME_DIR/.local/share/openasi-checkin"
if [ "$SRC" != "$CANONICAL" ]; then
  err "请从规范位置运行安装器: $CANONICAL"
  err "当前目录: $SRC"
  echo "  复制到规范位置后重试:"
  echo "    mkdir -p \"$HOME_DIR/.local/share\" && cp -a \"$SRC\" \"$CANONICAL\" && bash \"$CANONICAL/installer/install.sh\""
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then err "未找到 node, 请先安装 Node.js >= 18"; exit 1; fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then err "Node.js 版本过低 ($NODE_MAJOR), 需要 >= 18"; exit 1; fi

backup_and_copy_file() {
  local src="$1" dst="$2"
  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then
    run cp -a "$dst" "$dst.bak-$STAMP"
    warn "已备份旧文件: $dst.bak-$STAMP"
  fi
  run mkdir -p "$(dirname "$dst")"
  run cp -a "$src" "$dst"
}
backup_and_copy_dir() {
  local src="$1" dst="$2"
  if [ -d "$dst" ]; then
    if diff -rq "$src" "$dst" >/dev/null 2>&1; then return 0; fi
    run mv "$dst" "$dst.bak-$STAMP"
    warn "已备份旧目录: $dst.bak-$STAMP"
  fi
  run mkdir -p "$(dirname "$dst")"
  run cp -a "$src" "$dst"
}

# ---------- 0. 依赖 ----------
if [ "$SKIP_DEPS" = 0 ] && [ ! -d "$SRC/node_modules/playwright-core" ]; then
  log "安装依赖 (playwright-core, 完整版脚本需要)…"
  run npm install --prefix "$SRC" --no-audit --no-fund
fi

# ---------- 平台检测 ----------
detect_platforms() {
  case "$PLATFORMS" in
    all) echo "opencode claude codex";;
    auto)
      local r=""
      { [ -d "$OPENCODE_DIR" ] || has opencode; } && r="$r opencode"
      { [ -d "$CLAUDE_DIR" ] || has claude; } && r="$r claude"
      { [ -d "$CODEX_DIR" ] || has codex; } && r="$r codex"
      echo "$r"
      ;;
    *) echo "${PLATFORMS//,/ }";;
  esac
}

# ---------- 平台安装 ----------
install_opencode() {
  log "安装 OpenCode 集成 (skill + plugin hook)"
  backup_and_copy_dir "$SRC/platforms/opencode/skill/openasi-checkin" "$OPENCODE_DIR/skills/openasi-checkin"
  backup_and_copy_file "$SRC/platforms/opencode/plugin/openasi-checkin.js" "$OPENCODE_DIR/plugins/openasi-checkin.js"
}

install_claude() {
  log "安装 Claude Code 集成 (skill + SessionStart hook)"
  backup_and_copy_dir "$SRC/platforms/claude/skill/openasi-checkin" "$CLAUDE_DIR/skills/openasi-checkin"
  local hook="$CLAUDE_DIR/hooks/openasi-checkin-session-start.sh"
  backup_and_copy_file "$SRC/platforms/claude/hooks/openasi-checkin-session-start.sh" "$hook"
  run chmod +x "$hook"
  if [ "$DRY_RUN" = 0 ]; then
    "$NODE_BIN" "$SRC/installer/merge-claude-settings.mjs" "$hook"
  fi
}

install_codex() {
  log "安装 Codex 集成 (本地 marketplace + plugin)"
  local mkt="$SRC/platforms/codex/marketplace"
  if ! has codex; then
    warn "codex 命令不可用, 跳过注册 (插件文件已就绪: $mkt)"
    return 0
  fi
  if codex plugin marketplace list 2>/dev/null | grep -q "openasi-local"; then
    log "marketplace 'openasi-local' 已注册, 跳过"
  else
    run codex plugin marketplace add "$mkt" || warn "marketplace 注册失败, 请手动执行: codex plugin marketplace add $mkt"
  fi
  if codex plugin list 2>/dev/null | grep "openasi-checkin@openasi-local" | grep -qv "not installed"; then
    log "Codex 插件 'openasi-checkin' 已安装, 跳过"
  else
    run codex plugin add openasi-checkin@openasi-local || warn "插件安装失败, 请手动执行: codex plugin add openasi-checkin@openasi-local"
  fi
}

install_agents_md() {
  log "写入 ~/.codex/AGENTS.md 提示 (可选)"
  local file="$CODEX_DIR/AGENTS.md"
  run mkdir -p "$CODEX_DIR"
  if [ -f "$file" ] && grep -q "openasi-checkin" "$file"; then
    log "AGENTS.md 已包含 openasi-checkin 提示, 跳过"
    return 0
  fi
  if [ "$DRY_RUN" = 0 ]; then
    cat >>"$file" <<EOF

<!-- openasi-checkin -->
- OpenASI 签到: 用户提到签到/每日奖励时运行 \`node ~/.local/share/openasi-checkin/checkin-lite.mjs\`（查询用 --status, 追加 --json）; 若提示 needs-login, 让用户运行 \`node ~/.local/share/openasi-checkin/checkin.mjs --login\`。
EOF
  fi
}

# ---------- 系统定时器 ----------
install_systemd_timer() {
  local unit_dir="$HOME_DIR/.config/systemd/user"
  local service="openasi-checkin.service" timer="openasi-checkin.timer"
  log "安装 systemd user timer ($timer)"
  run mkdir -p "$unit_dir"
  if [ "$DRY_RUN" = 0 ]; then
    cat >"$unit_dir/$service" <<EOF
[Unit]
Description=OpenASI daily check-in
After=network-online.target

[Service]
Type=oneshot
ExecStart=$NODE_BIN $SRC/checkin-lite.mjs --if-not-today --quiet
EOF
    cat >"$unit_dir/$timer" <<EOF
[Unit]
Description=OpenASI daily check-in timer

[Timer]
OnCalendar=*-*-* 09:30:00
Persistent=true
RandomizedDelaySec=300
OnStartupSec=2min

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$timer" && log "timer 已启用: $timer"
  else
    printf '[dry-run] write %s/%s and %s/%s\n' "$unit_dir" "$service" "$unit_dir" "$timer"
  fi
}

install_cron() {
  log "安装 cron 任务"
  local line="*/30 * * * * $NODE_BIN $SRC/checkin-lite.mjs --if-not-today --quiet >> $SRC/cron.log 2>&1"
  if crontab -l 2>/dev/null | grep -q "openasi-checkin"; then
    log "cron 任务已存在, 跳过"
  else
    if [ "$DRY_RUN" = 0 ]; then
      { crontab -l 2>/dev/null || true; echo "# openasi-checkin (managed by install.sh)"; echo "$line"; } | crontab -
    else
      printf '[dry-run] crontab += %s\n' "$line"
    fi
  fi
}

install_schedule() {
  case "$SCHEDULE" in
    none) log "跳过系统定时器"; SCHEDULE_METHOD="none"; return 0;;
  esac
  local method="$SCHEDULE"
  if [ "$method" = "auto" ]; then
    if systemctl --user status >/dev/null 2>&1; then method="systemd"; else method="cron"; fi
  fi
  case "$method" in
    systemd) install_systemd_timer; SCHEDULE_METHOD="systemd";;
    cron)    install_cron; SCHEDULE_METHOD="cron";;
    *) err "未知定时器类型: $method (可选 systemd|cron|none)"; exit 1;;
  esac
}

# ---------- 执行 ----------
log "源目录: $SRC"
log "Node:    $NODE_BIN ($("$NODE_BIN" --version))"

SELECTED="$(detect_platforms)"
if [ -z "$SELECTED" ]; then
  warn "未检测到任何已安装的智能体平台 (OpenCode/Claude Code/Codex), 仅安装定时器"
fi

for p in $SELECTED; do
  case "$p" in
    opencode) install_opencode;;
    claude)   install_claude;;
    codex)    install_codex;;
    *) warn "未知平台: $p (可选: opencode,claude,codex)";;
  esac
done

[ "$WITH_AGENTS_MD" = 1 ] && install_agents_md
install_schedule

# ---------- 首次运行 + 安装记录 ----------
if [ "$DRY_RUN" = 0 ]; then
  log "执行一次签到检查…"
  if "$NODE_BIN" "$SRC/checkin-lite.mjs" --if-not-today --quiet; then
    log "签到检查通过"
  else
    rc=$?
    if [ "$rc" = 2 ]; then
      warn "尚未登录。请运行一次: node $SRC/checkin.mjs --login"
    else
      warn "首次签到检查未通过 (exit=$rc), 查看 $SRC/checkin.log"
    fi
  fi
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [src, out, node, schedule] = process.argv.slice(1);
    const j = { installedAt: new Date().toISOString(), src, node, platforms: {}, schedule };
    for (const p of ["opencode","claude","codex"]) {
      const files = {
        opencode: ["skills/openasi-checkin/SKILL.md","plugins/openasi-checkin.js"],
        claude:   ["skills/openasi-checkin/SKILL.md","hooks/openasi-checkin-session-start.sh"],
        codex:    [],
      }[p];
      if (!files) continue;
      const dir = { opencode: process.env.HOME + "/.config/opencode", claude: process.env.HOME + "/.claude", codex: process.env.HOME + "/.codex" }[p];
      if (files.every(f => fs.existsSync(dir + "/" + f))) j.platforms[p] = dir;
    }
    if (fs.existsSync(process.env.HOME + "/.codex/config.toml") && fs.readFileSync(process.env.HOME + "/.codex/config.toml","utf8").includes("openasi-local")) j.platforms.codex = process.env.HOME + "/.codex";
    fs.writeFileSync(out, JSON.stringify(j, null, 2) + "\n");
  ' "$SRC" "$SRC/install.json" "$NODE_BIN" "$SCHEDULE_METHOD"
fi

echo
log "完成 ✅  (平台: ${SELECTED:-none} | 定时器: $SCHEDULE_METHOD)"
echo "  验证安装: bash $SRC/tests/run-tests.sh"
echo "  首次登录: node $SRC/checkin.mjs --login    (会话过期后同样用这条命令)"
echo "  日志:     $SRC/checkin.log  (hook: hook.log / plugin: plugin.log / 定时器: cron.log)"
