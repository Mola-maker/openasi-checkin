# 配置清单 (Configuration Manifest)

> 本清单描述安装器在本机产生的**全部**配置、文件与副作用，以及对应的卸载映射。
> 示例路径以 `$HOME=/home/jlu` 为准。生成方式：`bash installer/install.sh`。
> ⚠️ 本文件不包含任何 token / 密钥明文。

## 0. 总览

| # | 层 | 类型 | 位置 | 触发时机 |
|---|----|------|------|----------|
| 1 | 运行时 | 脚本 + 数据 | `~/.local/share/openasi-checkin/` | — |
| 2 | OpenCode | skill | `~/.config/opencode/skills/openasi-checkin/` | 模型按需加载 / `@openasi-checkin` |
| 3 | OpenCode | plugin hook | `~/.config/opencode/plugins/openasi-checkin.js` | 插件加载时 + 每 6 小时 |
| 4 | Claude Code | skill | `~/.claude/skills/openasi-checkin/` | 模型按需加载 / `/openasi-checkin` |
| 5 | Claude Code | SessionStart hook | `~/.claude/hooks/openasi-checkin-session-start.sh` + `settings.json` | 每次会话启动（非阻塞） |
| 6 | Codex | marketplace + plugin | `~/.codex/config.toml` + 本地 marketplace | 插件注册后的 skill 调用 |
| 7 | 系统 | systemd user timer | `~/.config/systemd/user/openasi-checkin.{timer,service}` | 每日 09:30（错过补偿） |

## 1. 运行时 (`~/.local/share/openasi-checkin/`)

| 文件 | 权限 | 说明 |
|------|------|------|
| `checkin.mjs` | 755 | 完整版：API 优先 → Playwright 提取/刷新 → `--ui` 页面点击 → `--login` 人工登录 |
| `checkin-lite.mjs` | 755 | 轻量版（零依赖）：模拟真实客户端请求头直发 API；token 失效自动回退完整版 |
| `package.json` / `package-lock.json` | 644 | npm 元数据（依赖仅 `playwright-core`，不下载浏览器） |
| `state.json` | **600** | 登录 token + 最近签到结果（敏感，已 gitignore） |
| `browser-profile/` | **700** | Chromium 持久化配置（会话所在，敏感，已 gitignore） |
| `checkin.log` | 644 | 签到结果日志（token 已脱敏） |
| `hook.log` / `plugin.log` / `cron.log` | 644 | 各触发源的输出 |
| `install.json` | 644 | 本机安装记录（平台/定时器/路径） |

## 2. OpenCode

- **skill**：`~/.config/opencode/skills/openasi-checkin/SKILL.md`
  （ID = `openasi-checkin`，frontmatter `name` + `description`，支持自动发现与 `@openasi-checkin` 显式加载）
- **plugin hook**：`~/.config/opencode/plugins/openasi-checkin.js`
  - `Plugin.define({ id: "openasi-checkin" })`；`setup()` 时立即触发一次 + `setInterval` 每 6h
  - 触发命令：`node checkin-lite.mjs --if-not-today --quiet`（detached，不阻塞）
  - 日志：`plugin.log`（记录 loaded / triggered / unloaded）
  - 卸载：删除上述两个路径即完全移除，无需改任何配置文件
- **验证**：`plugin.log` 出现 `plugin loaded (opencode <版本>)` 即生效

## 3. Claude Code

- **skill**：`~/.claude/skills/openasi-checkin/SKILL.md`（`allowed-tools: Bash(node:*)`）
- **hook 脚本**：`~/.claude/hooks/openasi-checkin-session-start.sh`（755，setsid 后台执行后立即 `exit 0`，实测 ~5ms）
- **settings.json 变更**（幂等合并，首次自动备份为 `settings.json.bak-openasi`）：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact|fork",
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/openasi-checkin-session-start.sh",
            "timeout": 10,
            "statusMessage": "OpenASI 签到检查"
          }
        ]
      }
    ]
  }
}
```

- **验证**：`claude` 会话中用 `/hooks` 查看；或手动模拟：
  `printf '{"session_id":"t","source":"startup"}' | bash ~/.claude/hooks/openasi-checkin-session-start.sh; echo $?`

## 4. Codex

- **marketplace 注册**（`~/.codex/config.toml` 新增，由 `codex plugin marketplace add` 写入）：

```toml
[marketplaces.openasi-local]
source_type = "local"
source = "/home/jlu/.local/share/openasi-checkin/platforms/codex/marketplace"
```

- **插件启用**（同上文件）：

```toml
[plugins."openasi-checkin@openasi-local"]
enabled = true
```

- **插件源**：`platforms/codex/marketplace/`（`.agents/plugins/marketplace.json` + `plugins/openasi-checkin/{.codex-plugin/plugin.json, skills/}`）
- **安装缓存**：`~/.codex/plugins/cache/openasi-local/openasi-checkin/1.0.0/`
- **可选**：`install.sh --with-agents-md` 会向 `~/.codex/AGENTS.md` 追加提示段（本机未启用）
- **验证**：`codex plugin list | grep openasi`

## 5. systemd user timer（默认调度）

- `~/.config/systemd/user/openasi-checkin.service`

```ini
[Unit]
Description=OpenASI daily check-in
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/node $HOME/.local/share/openasi-checkin/checkin-lite.mjs --if-not-today --quiet
```

- `~/.config/systemd/user/openasi-checkin.timer`

```ini
[Unit]
Description=OpenASI daily check-in timer

[Timer]
OnCalendar=*-*-* 09:30:00
Persistent=true          # 关机错过的触发在下次启动后补跑
RandomizedDelaySec=300   # 随机抖动，避免整点并发
OnStartupSec=2min        # 启动 2 分钟后先查一次（幂等）

[Install]
WantedBy=timers.target
```

- 启用：`systemctl --user enable --now openasi-checkin.timer`（安装器已做）
- **cron 替代**（无 systemd 环境自动选用；行格式）：

```
# openasi-checkin (managed by install.sh)
*/30 * * * * /usr/local/bin/node $HOME/.local/share/openasi-checkin/checkin-lite.mjs --if-not-today --quiet >> $HOME/.local/share/openasi-checkin/cron.log 2>&1
```

- **验证**：`systemctl --user list-timers | grep openasi` / `systemctl --user status openasi-checkin.timer`

## 6. 可选环境变量

| 变量 | 作用 | 默认 |
|------|------|------|
| `OPENASI_TOKEN` | 直接用 token（优先级最高，CI/无桌面场景） | 读取 `state.json` |
| `OPENASI_CHECKIN_HOME` | 覆盖数据目录 | `~/.local/share/openasi-checkin` |
| `OPENASI_PLAYWRIGHT_CORE` | 指定 playwright-core 模块路径 | 本地 `node_modules` |
| `OPENASI_NODE` | 指定 node 可执行文件（plugin 用） | PATH 中的 `node` |

## 7. 卸载映射

`bash installer/uninstall.sh`（保留登录态） / `--purge`（彻底清除）：

| 安装项 | 卸载动作 |
|--------|----------|
| OpenCode skill / plugin | 删除对应文件 |
| Claude skill / hook / settings 条目 | 删除文件；从 `settings.json` 过滤 `openasi-checkin` 条目（保留其他配置） |
| Codex plugin / marketplace | `codex plugin remove` + `codex plugin marketplace remove` |
| systemd timer | `disable --now` + 删除 unit |
| cron | 移除含 `openasi-checkin` 标记的行 |
| `--purge` | 额外删除 `state.json`、`browser-profile/`、全部日志 |

## 8. 安全边界

- 仅访问 `app.openasi.bitmiracle.cn` 与 `api.openasi.bitmiracle.cn`；无第三方遥测。
- `state.json`(600) 与 `browser-profile/`(700) 仅本机用户可读；`.gitignore` 阻断二者及全部日志进入 Git。
- 所有日志/JSON 输出对 token 脱敏（仅显示 `前缀…后缀 (len=)`）。
- 响应头 `set-auth-token` 出现时自动持久化轮换后的新 token。
