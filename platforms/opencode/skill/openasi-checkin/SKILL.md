---
name: openasi-checkin
description: "OpenASI 每日签到/自动签到/签到状态查询/会话过期处理。Use when the user asks about OpenASI check-in, daily reward, 签到, check-in status, or when OpenASI API requests fail with authentication/token errors."
---

# OpenASI 每日签到

签到脚本: `~/.local/share/openasi-checkin/checkin.mjs`（Playwright 浏览器会话 + API 直连，幂等）。

## 常用命令

```bash
node ~/.local/share/openasi-checkin/checkin-lite.mjs           # 轻量版: 零依赖直发 API (推荐/默认)
node ~/.local/share/openasi-checkin/checkin-lite.mjs --status  # 轻量版: 只查询状态
node ~/.local/share/openasi-checkin/checkin.mjs                # 完整版: API 优先, 浏览器兜底 (浏览器可用时)
node ~/.local/share/openasi-checkin/checkin.mjs --ui           # 走页面按钮（Playwright 模拟点击）
node ~/.local/share/openasi-checkin/checkin.mjs --login        # 会话过期时: 打开浏览器人工登录一次
```

在任何命令后追加 `--json` 可获得机器可读输出。轻量版 token 失效时自动回退完整版（可用 `--no-fallback` 关闭）。

## 退出码

| 码 | 含义 | 处理 |
|----|------|------|
| 0 | 签到成功 / 今天已签到 / 节流跳过 | 无需操作 |
| 2 | 需要人工登录 | 让用户在桌面环境执行 `--login` |
| 1 | 网络/服务错误 | 查看 `~/.local/share/openasi-checkin/checkin.log` 后重试 |

## 说明

- OpenCode 插件（`~/.config/opencode/plugins/openasi-checkin.js`）已配置为**自动触发**（加载时 + 每 6 小时检查一次，`--if-not-today` 节流），正常情况下无需手动执行本 skill。
- 用户主动询问签到情况时：先跑 `--status --json`，再用中文简要汇报（是否已签到、奖励、连续天数）。
- 若返回 `needs-login`：提示用户在**有显示器的环境**运行 `--login`，登录一次后长期有效（会话 7 天，浏览器配置会自动刷新 token）。
- 日志: `~/.local/share/openasi-checkin/checkin.log`；机器可读状态: `state.json`。
