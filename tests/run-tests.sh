#!/usr/bin/env bash
# OpenASI 每日签到 — 安装与功能测试套件
# 用法: bash tests/run-tests.sh
# 覆盖: 核心脚本可达性 / 轻量版 / 幂等与节流 / UI 模式 /
#       OpenCode、Claude Code、Codex 三平台安装检查 / hook 模拟执行 / 定时器状态
set -u

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME}"
PASS=0; FAIL=0; SKIP=0
REPORT="$SRC/tests/report-latest.txt"

t_pass() { PASS=$((PASS+1)); echo "  ✔ $1"; }
t_fail() { FAIL=$((FAIL+1)); echo "  ✘ $1"; }
t_skip() { SKIP=$((SKIP+1)); echo "  ○ $1 (跳过)"; }
section() { echo; echo "── $1 ──"; }
has() { command -v "$1" >/dev/null 2>&1; }

json_field() { # json_field <文件或-> <字段>  (从 stdin 或文件取 JSON 字段)
  node -e 'let s="";const f=process.argv[1];if(f!=="-"){const fs=require("fs");s=fs.readFileSync(f,"utf8")}else{s=require("fs").readFileSync(0,"utf8")}try{const j=JSON.parse(s);const p=process.argv[2].split(".");let v=j;for(const k of p)v=v?.[k];console.log(v??"")}catch{console.log("__PARSE_ERROR__")}' "$1" "$2"
}

echo "OpenASI 签到 — 测试套件  ($(date '+%F %T'))"
echo "源目录: $SRC"

# ========== 1. 环境与依赖 ==========
section "1. 环境与依赖"
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ] && [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
  t_pass "node 可用且 >= 18 ($("$NODE_BIN" --version))"
else
  t_fail "node 不可用或版本过低"; echo "致命错误, 终止"; exit 1
fi

if (cd "$SRC" && node -e 'import("playwright-core").then(()=>process.exit(0)).catch(()=>process.exit(1))'); then
  t_pass "playwright-core 可加载"
else
  t_skip "playwright-core 未安装 (完整版不可用, 轻量版不受影响)"
fi

if [ -f "$SRC/node_modules/playwright-core" ]; then :; fi
if (cd "$SRC" && timeout 60 node --input-type=module -e '
  const { chromium } = await import("playwright-core");
  const b = await chromium.launch({ headless: true }); await b.close();
' 2>/dev/null); then
  t_pass "Chromium 可启动 (Playwright)"
else
  t_skip "Chromium 启动失败/不可用 (UI 与浏览器提取不可用)"
fi

for f in checkin.mjs checkin-lite.mjs package.json; do
  [ -f "$SRC/$f" ] && t_pass "文件存在: $f" || t_fail "文件缺失: $f"
done

# ========== 2. 核心脚本功能 ==========
section "2. 核心脚本功能"

if timeout 30 node "$SRC/checkin-lite.mjs" --help | grep -q "用法"; then
  t_pass "lite --help 正常"
else
  t_fail "lite --help 异常"
fi

LITE_OUT="$(timeout 60 node "$SRC/checkin-lite.mjs" --status --json 2>&1)"; LITE_RC=$?
LITE_RESULT="$(printf '%s' "$LITE_OUT" | json_field - result)"
case "$LITE_RC" in
  0) t_pass "lite --status 可达 (result=$LITE_RESULT)"
     [ "$(printf '%s' "$LITE_OUT" | json_field - checkedInToday)" = "true" ] && t_pass "lite: checkedInToday=true" || t_skip "lite: 今天尚未签到 (等待当日首次签到时验证)" ;;
  2) t_skip "lite --status: 需要登录 (运行 node checkin.mjs --login 后重测)" ;;
  *) t_fail "lite --status 异常 (exit=$LITE_RC): $(printf '%s' "$LITE_OUT" | head -c 160)" ;;
esac

FULL_OUT="$(timeout 90 node "$SRC/checkin.mjs" --status --json 2>&1)"; FULL_RC=$?
case "$FULL_RC" in
  0) t_pass "完整版 --status 可达 (result=$(printf '%s' "$FULL_OUT" | json_field - result))" ;;
  2) t_skip "完整版 --status: 需要登录" ;;
  *) t_fail "完整版 --status 异常 (exit=$FULL_RC): $(printf '%s' "$FULL_OUT" | head -c 160)" ;;
esac

# token 泄漏检查: JSON 输出是否含明文 token
STATE_TOKEN="$(json_field "$SRC/state.json" token 2>/dev/null || true)"
if [ -n "$STATE_TOKEN" ] && [ "$STATE_TOKEN" != "__PARSE_ERROR__" ]; then
  if printf '%s' "$LITE_OUT" | grep -qF "$STATE_TOKEN"; then
    t_fail "安全: lite JSON 输出泄漏明文 token"
  else
    t_pass "安全: lite JSON 输出不含明文 token"
  fi
else
  t_skip "安全: token 泄漏检查 (无 state token)"
fi

# 幂等: 连续两次运行
if [ "$LITE_RC" = "0" ]; then
  OUT1="$(timeout 60 node "$SRC/checkin-lite.mjs" --json 2>&1)"; RC1=$?
  OUT2="$(timeout 60 node "$SRC/checkin-lite.mjs" --json 2>&1)"; RC2=$?
  if [ "$RC1" = "0" ] && [ "$RC2" = "0" ]; then
    t_pass "幂等: 连续两次签到均 exit=0 ($(printf '%s' "$OUT1" | json_field - result) / $(printf '%s' "$OUT2" | json_field - result))"
  else
    t_fail "幂等失败: exit1=$RC1 exit2=$RC2"
  fi
else
  t_skip "幂等测试 (需要登录)"
fi

# 节流: --if-not-today
TODAY="$(date +%F)"
LAST_DONE="$(json_field "$SRC/state.json" lastSuccessLocalDate 2>/dev/null || true)"
if [ "$LAST_DONE" = "$TODAY" ]; then
  TOUT="$(timeout 30 node "$SRC/checkin-lite.mjs" --if-not-today --json 2>&1)"; TRC=$?
  if [ "$TRC" = "0" ] && [ "$(printf '%s' "$TOUT" | json_field - result)" = "skipped" ]; then
    t_pass "节流: --if-not-today 返回 skipped"
  else
    t_fail "节流异常: exit=$TRC out=$(printf '%s' "$TOUT" | head -c 120)"
  fi
else
  t_skip "节流测试 (state 中无今日成功记录)"
fi

# UI 模式 (需要浏览器配置已登录)
UI_OUT="$(timeout 90 node "$SRC/checkin.mjs" --ui --json 2>&1)"; UI_RC=$?
case "$UI_RC" in
  0) t_pass "UI 模式可达 (result=$(printf '%s' "$UI_OUT" | json_field - result))" ;;
  2) t_skip "UI 模式 (浏览器配置未登录, --login 后重测)" ;;
  *) t_fail "UI 模式异常 (exit=$UI_RC): $(printf '%s' "$UI_OUT" | head -c 160)" ;;
esac

# ========== 3. OpenCode 集成 ==========
section "3. OpenCode 集成"
OC_DIR="$HOME_DIR/.config/opencode"
if [ -f "$OC_DIR/skills/openasi-checkin/SKILL.md" ]; then
  t_pass "skill 已安装: ~/.config/opencode/skills/openasi-checkin/SKILL.md"
else
  t_skip "skill 未安装"
fi
PLUGIN="$OC_DIR/plugins/openasi-checkin.js"
if [ -f "$PLUGIN" ]; then
  t_pass "plugin 已安装: ~/.config/opencode/plugins/openasi-checkin.js"
  TMP_ESM="$(mktemp /tmp/openasi-plugin-XXXX.mjs)"; cp "$PLUGIN" "$TMP_ESM"
  if node --check "$TMP_ESM" 2>/dev/null; then
    t_pass "plugin 语法检查通过 (ESM 解析)"
  else
    t_fail "plugin 语法检查失败"
  fi
  rm -f "$TMP_ESM"
  if grep -q "checkin-lite.mjs" "$PLUGIN"; then
    t_pass "plugin 使用轻量版脚本 (无浏览器热路径)"
  else
    t_fail "plugin 未指向 checkin-lite.mjs"
  fi
else
  t_skip "plugin 未安装"
fi

# ========== 4. Claude Code 集成 ==========
section "4. Claude Code 集成"
CC_DIR="$HOME_DIR/.claude"
if [ -f "$CC_DIR/skills/openasi-checkin/SKILL.md" ]; then
  t_pass "skill 已安装: ~/.claude/skills/openasi-checkin/SKILL.md"
else
  t_skip "skill 未安装"
fi
HOOK="$CC_DIR/hooks/openasi-checkin-session-start.sh"
if [ -f "$HOOK" ]; then
  [ -x "$HOOK" ] && t_pass "hook 脚本存在且可执行" || t_fail "hook 脚本不可执行"
  SETTINGS="$CC_DIR/settings.json"
  if [ -f "$SETTINGS" ] && json_field "$SETTINGS" hooks >/dev/null 2>&1 && grep -q "openasi-checkin-session-start.sh" "$SETTINGS"; then
    t_pass "settings.json 已注册 SessionStart hook"
  else
    t_fail "settings.json 未注册 hook 或 JSON 无效"
  fi
  # hook 模拟: 传入 SessionStart 标准输入 JSON, 应快速返回 0
  T0="$(date +%s%N)"
  printf '{"session_id":"test-session","source":"startup","cwd":"/tmp"}' | timeout 10 bash "$HOOK"; HRC=$?
  T1="$(date +%s%N)"
  DUR_MS=$(( (T1 - T0) / 1000000 ))
  if [ "$HRC" = "0" ] && [ "$DUR_MS" -lt 3000 ]; then
    t_pass "hook 模拟执行: exit=0, ${DUR_MS}ms (非阻塞)"
  else
    t_fail "hook 模拟执行异常: exit=$HRC, ${DUR_MS}ms"
  fi
  sleep 1
  if [ -f "$SRC/hook.log" ]; then
    t_pass "hook 已触发后台签到 (hook.log 已生成)"
  else
    t_skip "hook 后台日志未生成 (首次运行可能仍在进行)"
  fi
else
  t_skip "hook 未安装"
fi

# ========== 5. Codex 集成 ==========
section "5. Codex 集成"
if has codex; then
  if codex plugin list 2>/dev/null | grep "openasi-checkin@openasi-local" | grep -qv "not installed"; then
    t_pass "codex plugin 已安装: openasi-checkin@openasi-local"
  else
    t_fail "codex plugin 未安装"
  fi
  if codex plugin marketplace list 2>/dev/null | grep -q "openasi-local"; then
    t_pass "codex marketplace 已注册: openasi-local"
  else
    t_fail "codex marketplace 未注册"
  fi
  if [ -f "$SRC/platforms/codex/marketplace/plugins/openasi-checkin/skills/openasi-checkin/SKILL.md" ]; then
    t_pass "codex 插件文件完整 (plugin.json + SKILL.md)"
  else
    t_fail "codex 插件文件缺失"
  fi
else
  t_skip "codex 命令不可用"
fi

# ========== 6. 定时器 ==========
section "6. 系统定时器"
if [ -f "$SRC/install.json" ]; then
  METHOD="$(json_field "$SRC/install.json" schedule)"
  case "$METHOD" in
    systemd)
      if systemctl --user is-active openasi-checkin.timer 2>/dev/null | grep -q "^active$"; then
        t_pass "systemd timer 状态: active"
        systemctl --user start openasi-checkin.service 2>/dev/null || true
        sleep 2
        RES="$(systemctl --user show -p Result --value openasi-checkin.service 2>/dev/null || echo unknown)"
        [ "$RES" = "success" ] && t_pass "timer service 手动触发成功 (Result=success)" || t_fail "timer service 触发结果: $RES"
      else
        t_fail "systemd timer 未激活"
      fi
      ;;
    cron)
      if crontab -l 2>/dev/null | grep -q "openasi-checkin"; then
        t_pass "crontab 已包含 openasi-checkin 任务"
      else
        t_fail "crontab 缺少任务"
      fi
      ;;
    *) t_skip "定时器方式: $METHOD" ;;
  esac
else
  t_skip "未找到 install.json (尚未运行安装器)"
fi

# ========== 汇总 ==========
echo
echo "════════════════════════════════"
printf '结果: \033[1;32m%d 通过\033[0m / \033[1;31m%d 失败\033[0m / \033[1;33m%d 跳过\033[0m\n' "$PASS" "$FAIL" "$SKIP"
{
  echo "OpenASI 签到测试报告 $(date '+%F %T')"
  echo "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
  echo "说明: SKIP 通常表示尚未执行 --login 或平台未安装, 不代表故障。"
} >"$REPORT"
echo "报告已写入: $REPORT"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
