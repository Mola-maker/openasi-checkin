---
name: openasi-checkin
description: "OpenASI 每日签到/自动签到/签到状态查询。Use when the user asks about OpenASI check-in, daily reward, 签到, or check-in status."
---

# OpenASI 每日签到

签到脚本: `~/.local/share/openasi-checkin/checkin.mjs`（Playwright 浏览器会话 + API 直连，幂等）。

## 常用命令

```bash
node ~/.local/share/openasi-checkin/checkin-lite.mjs           # 轻量版: 零依赖直发 API (推荐)
node ~/.local/share/openasi-checkin/checkin-lite.mjs --status  # 轻量版: 只查询状态
node ~/.local/share/openasi-checkin/checkin.mjs                # 完整版: 浏览器兜底/登录
```

追加 `--json` 可获得机器可读输出。

## 退出码

| 码 | 含义 | 处理 |
|----|------|------|
| 0 | 签到成功 / 今天已签到 / 节流跳过 | 无需操作 |
| 2 | 需要人工登录 | 让用户在桌面环境执行 `--login` |
| 1 | 网络/服务错误 | 查看 `~/.local/share/openasi-checkin/checkin.log` 后重试 |

## 说明

- 系统层面已配置定时器（systemd user timer 或 cron）自动签到；Codex 中用户可显式要求执行。
- 用户询问签到情况时：先跑 `--status --json`，再用中文简要汇报。
- 若返回 `needs-login`：提示用户在**有显示器的环境**运行 `--login`。
- 日志: `~/.local/share/openasi-checkin/checkin.log`。
