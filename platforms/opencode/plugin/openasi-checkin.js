// OpenASI 每日签到 — OpenCode 插件 (hook)
// 安装位置: ~/.config/opencode/plugins/openasi-checkin.js
// 行为: 插件加载时立即检查一次 + 每 6 小时检查一次; 使用轻量版脚本 (零依赖、无浏览器,
//       token 失效时自动回退完整版走浏览器刷新), 不阻塞 OpenCode。
import { Plugin } from "@opencode/plugin"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const RUNNER = path.join(os.homedir(), ".local", "share", "openasi-checkin", "checkin-lite.mjs")
const PLUGIN_LOG = path.join(os.homedir(), ".local", "share", "openasi-checkin", "plugin.log")
const INTERVAL_MS = 6 * 60 * 60 * 1000

function log(msg) {
  try {
    fs.appendFileSync(PLUGIN_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 忽略日志失败 */
  }
}

function resolveNode() {
  for (const bin of [process.env.OPENASI_NODE, "node"].filter(Boolean)) {
    try {
      const r = spawnSync(bin, ["--version"], { timeout: 5000 })
      if (r.status === 0) return bin
    } catch {
      /* 尝试下一个 */
    }
  }
  return process.execPath
}

function runCheckin() {
  if (!fs.existsSync(RUNNER)) {
    log(`skip: runner not found at ${RUNNER}`)
    return
  }
  try {
    const child = spawn(resolveNode(), [RUNNER, "--if-not-today", "--quiet"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    })
    child.on("error", (e) => log(`spawn error: ${e.message}`))
    child.unref()
    log("checkin triggered (--if-not-today)")
  } catch (e) {
    log(`run error: ${e?.message ?? e}`)
  }
}

export default Plugin.define({
  id: "openasi-checkin",
  async setup(ctx) {
    log(`plugin loaded (opencode ${ctx.app.version})`)
    runCheckin()
    const timer = setInterval(runCheckin, INTERVAL_MS)
    return () => {
      clearInterval(timer)
      log("plugin unloaded")
    }
  },
})
