# OpenASI Daily Check-in (多平台)

OpenASI（`app.openasi.bitmiracle.cn`）每日自动签到，参考 OpenCode / Claude Code / Codex 的扩展架构，
以「**skill + hook + 系统定时器**」三层方式安装到各平台。

## 架构总览

```
┌─ 触发层 ──────────────────────────────────────────────────────────┐
│ runtime/systemd  systemd user timer (09:30, Persistent 补偿错过)   │
│       或 cron     */30 每半小时尝试 (--if-not-today 秒级短路)      │
│ OpenCode          plugin hook: 加载时 + 每 6 小时                  │
│ Claude Code       SessionStart hook: 每次会话启动 (非阻塞, ~5ms)   │
│ Codex             plugin skill: 用户/模型按需调用                  │
└──────────────┬────────────────────────────────────────────────────┘
               ▼
      checkin-lite.mjs   零依赖 · 模拟真实客户端请求头 · ~200ms
               │ token 失效 (auth error)
               ▼
      checkin.mjs        Playwright: 持久化浏览器配置提取/刷新 token
               │ 会话完全过期
               ▼
      checkin.mjs --login  有头浏览器人工登录一次 (有效期 7 天)
```

## 平台映射

| 平台 | skill | hook / 自动触发 | 说明 |
|------|-------|----------------|------|
| OpenCode | `~/.config/opencode/skills/openasi-checkin/SKILL.md` | `~/.config/opencode/plugins/openasi-checkin.js`（ESM 插件，加载+6h 定时） | skills/hooks 原生目录，插件发现后自动加载 |
| Claude Code | `~/.claude/skills/openasi-checkin/SKILL.md` | `~/.claude/settings.json` → `hooks.SessionStart`（matcher: startup\|resume\|clear\|compact\|fork） | hook 包装脚本 setsid 后台执行，立即 exit 0 |
| Codex | 本地 marketplace `openasi-local` 插件内 `skills/openasi-checkin/SKILL.md` | 随插件注册（`codex plugin add openasi-checkin@openasi-local`） | plugin.json + marketplace.json 标准结构 |
| systemd/cron | — | user timer 或 crontab | 与是否使用智能体无关的兜底触发 |

## 项目结构

```
openasi-checkin/
├── README.md                       # 项目说明（本文）
├── INSTALL.md                      # 面向智能体的安装/验证操作手册 ← 从这里开始
├── MANIFEST.md                     # 配置清单：安装后本机产生的全部配置与卸载映射
├── .gitignore                      # 阻断敏感运行数据进 Git（token/会话/日志）
├── package.json / package-lock.json
├── checkin.mjs                     # 完整版: API 优先, Playwright 兜底/提取/登录/UI 点击
├── checkin-lite.mjs                # 轻量版: 零依赖, 真客户端请求头直发 API, 失效自动回退完整版
├── platforms/                      # 各平台集成源文件（安装器复制到目标位置）
│   ├── opencode/
│   │   ├── skill/openasi-checkin/SKILL.md            # OpenCode skill
│   │   └── plugin/openasi-checkin.js                 # OpenCode 插件 hook（加载时 + 每 6h）
│   ├── claude/
│   │   ├── skill/openasi-checkin/SKILL.md            # Claude Code skill
│   │   └── hooks/openasi-checkin-session-start.sh    # SessionStart hook（非阻塞, ~5ms）
│   └── codex/
│       └── marketplace/                              # Codex 本地 marketplace
│           ├── .agents/plugins/marketplace.json      # marketplace 定义
│           └── plugins/openasi-checkin/
│               ├── .codex-plugin/plugin.json         # Codex 插件清单
│               └── skills/openasi-checkin/SKILL.md   # Codex skill
├── installer/
│   ├── install.sh                  # 多平台幂等安装器（自动检测 + systemd/cron）
│   ├── merge-claude-settings.mjs   # settings.json 安全合并（幂等 + 首次备份）
│   └── uninstall.sh                # 卸载器（--purge 彻底清除）
└── tests/
    ├── run-tests.sh                # 30 项安装+功能测试套件
    └── seed-profile.mjs            # 测试辅助: 注入 token 到浏览器配置
```

运行时生成（已 `.gitignore`，不进入仓库）：`state.json`(600)、`browser-profile/`(700)、
`checkin.log` / `hook.log` / `plugin.log` / `cron.log`、`install.json`、`node_modules/`。

安装到本机的路径与配置文件见 [MANIFEST.md](./MANIFEST.md)。

## 请求机制（逆向自真实客户端）

- 认证: `Authorization: Bearer <localStorage.openasi_token>`（`~/.local/share/openasi-checkin/state.json` 持久化）
- 接口:
  - `POST https://api.openasi.bitmiracle.cn/api/getCheckinStatus` → `{data:{checkedInToday,todayDate,reward,recentDates}}`
  - `POST https://api.openasi.bitmiracle.cn/api/checkin` → 签到（重复则 `error.code=CONFLICT`）
- 请求体: `{"data":{}}`；轻量版完整模拟真实浏览器请求头（UA / Origin / Referer / sec-ch-ua\*）
- token 轮换: 响应头 `set-auth-token` 出现即自动保存新值

## 快速开始

```bash
bash installer/install.sh          # 安装全部检测到的平台 + 定时器
node checkin.mjs --login           # 首次登录 (桌面环境, 一次即可)
bash tests/run-tests.sh            # 验证 (预期 28 通过 / 0 失败)
```

## 测试

```bash
bash tests/run-tests.sh
```

30 项检查覆盖：核心脚本可达性（轻量 / 完整 / UI 三种模式）、幂等与节流、token 泄漏防护、
三平台安装完整性（OpenCode / Claude Code / Codex）、Claude hook 模拟执行（注入 SessionStart JSON）、
systemd / cron 定时器状态。最近一次本机运行：**28 通过 / 0 失败 / 0 跳过**。

安装与验证细节见 [INSTALL.md](./INSTALL.md)，本机安装的完整配置见 [MANIFEST.md](./MANIFEST.md)。

## 安全说明

- token 仅保存在本机 `state.json`（0600）与本地浏览器配置中，不外传；日志与 JSON 输出均已脱敏。
- 所有脚本仅访问 `*.openasi.bitmiracle.cn`。
- 卸载: `bash installer/uninstall.sh`（保留登录态）或 `--purge`（彻底清除）。
