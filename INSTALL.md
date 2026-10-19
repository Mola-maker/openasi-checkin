# OpenASI 每日签到 — 多平台安装指南（面向本地智能体）

> 给本地智能体（OpenCode / Claude Code / Codex）执行的操作手册。
> 所有命令已验证可跑；每步附预期结果，异常时按「故障排查」处理。

## 0. 前置条件

- Linux/macOS，Node.js >= 18（`node --version` 检查）
- 包已就位于规范路径：`~/.local/share/openasi-checkin/`（从其他位置先复制过去）

```bash
# 若从别的目录拿到本包，先放到规范位置:
mkdir -p ~/.local/share && cp -a /path/to/openasi-checkin ~/.local/share/openasi-checkin
cd ~/.local/share/openasi-checkin
```

## 1. 一键安装（推荐，幂等可重复执行）

```bash
bash ~/.local/share/openasi-checkin/installer/install.sh
```

行为：
1. 安装 npm 依赖（仅完整版需要 `playwright-core`，无浏览器下载）
2. 自动检测已安装的智能体平台并分别安装集成：
   - **OpenCode** → `~/.config/opencode/skills/openasi-checkin/SKILL.md` + `~/.config/opencode/plugins/openasi-checkin.js`（hook：加载时 + 每 6 小时触发）
   - **Claude Code** → `~/.claude/skills/openasi-checkin/SKILL.md` + `~/.claude/hooks/openasi-checkin-session-start.sh`（SessionStart hook，非阻塞后台执行）
   - **Codex** → 注册本地 marketplace `openasi-local` 并安装插件 `openasi-checkin`（`codex plugin add`）
3. 注册系统定时器兜底（有 systemd 用 systemd user timer，否则写 cron）
4. 立即执行一次签到检查，并写出 `install.json` 安装记录

可选参数：

```bash
bash installer/install.sh --platforms opencode,claude   # 只装指定平台
bash installer/install.sh --schedule cron               # 强制用 cron
bash installer/install.sh --schedule none               # 不装定时器
bash installer/install.sh --with-agents-md              # 额外写 ~/.codex/AGENTS.md 提示
bash installer/install.sh --dry-run                     # 只预览
```

**预期尾部输出**：`[install] 完成 ✅ (平台: opencode claude codex | 定时器: systemd)`
若提示 `尚未登录`，执行第 2 步。

## 2. 一次性登录（会话有效期 7 天，过期后重复本步）

```bash
node ~/.local/share/openasi-checkin/checkin.mjs --login
```

- 会打开有头浏览器窗口，在页面中完成登录即可；脚本自动检测会话并保存（**需要图形桌面**）。
- 无图形环境替代方案：从已有浏览器 DevTools → `localStorage.openasi_token` 复制值，然后：

```bash
node -e '
  const fs=require("fs"),os=require("os"),p=os.homedir()+"/.local/share/openasi-checkin/state.json";
  const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};
  s.token=process.argv[1]; s.tokenSavedAt=new Date().toISOString();
  fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n",{mode:0o600});
' "粘贴token"
```

**预期输出**：`登录成功, 会话已保存` → `签到成功 🎉` 或 `今天已经签到过了`

## 3. 验证测试

```bash
bash ~/.local/share/openasi-checkin/tests/run-tests.sh
```

覆盖 30 项检查：核心脚本可达性、轻量/完整/UI 三模式、幂等与节流、token 泄漏检查、
三平台安装完整性、Claude hook 模拟执行（注入标准输入 JSON）、Codex 插件状态、systemd/cron 定时器。

**预期输出**：`结果: 28 通过 / 0 失败 / 0 跳过`（未登录时相关项显示"跳过"，非故障）

## 4. 常用操作

```bash
# 查询状态（不动签到）
node ~/.local/share/openasi-checkin/checkin-lite.mjs --status --json

# 手动签到（幂等）
node ~/.local/share/openasi-checkin/checkin-lite.mjs

# 模拟真实用户点击页面签到按钮
node ~/.local/share/openasi-checkin/checkin.mjs --ui

# 卸载（保留登录状态）/ 彻底清除
bash ~/.local/share/openasi-checkin/installer/uninstall.sh
bash ~/.local/share/openasi-checkin/installer/uninstall.sh --purge
```

## 5. 故障排查

| 现象 | 处理 |
|------|------|
| 输出 `needs-login`，exit=2 | 执行 `checkin.mjs --login`（需要桌面） |
| Codex: `dashboard` 报 token 错误 | 同 `needs-login`；重登后 codex 无需额外操作 |
| systemd timer 未运行 | `systemctl --user status openasi-checkin.timer`；容器内无 systemd 请用 `--schedule cron` |
| 浏览器无法启动 | 确认 `~/.cache/ms-playwright` 存在；或 `cd ~/.local/share/openasi-checkin && npx playwright-core install chromium` |
| 查日志 | `checkin.log` / `hook.log` / `plugin.log` / `cron.log`（均在 `~/.local/share/openasi-checkin/`） |
| 测试报 NO_PLAYWRIGHT | 完整版不可用但不影响轻量版；`npm install --prefix ~/.local/share/openasi-checkin` |

## 6. 给智能体的行为约定

- 用户问“签到/每日奖励” → 先跑 `checkin-lite.mjs --status --json`，用中文汇报（是否已签到 / 奖励 / 连续天数见 `recentDates`）。
- 返回 exit=2 → 告知用户在桌面运行 `--login`，不要重试循环。
- 定时器与 hook 会自动触发，**正常情况下不需要主动签到**；仅在用户明确要求时执行。
