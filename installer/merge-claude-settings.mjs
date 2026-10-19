#!/usr/bin/env node
// 将 OpenASI SessionStart hook 幂等合并进 ~/.claude/settings.json
// 用法: node merge-claude-settings.mjs <hook 脚本绝对路径>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hookPath = process.argv[2];
if (!hookPath) {
  console.error("用法: node merge-claude-settings.mjs <hook脚本路径>");
  process.exit(1);
}

const dir = path.join(os.homedir(), ".claude");
const file = path.join(dir, "settings.json");

let settings = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw) settings = JSON.parse(raw);
}

settings.hooks ??= {};
settings.hooks.SessionStart ??= [];

if (JSON.stringify(settings.hooks.SessionStart).includes(hookPath)) {
  console.log("Claude SessionStart hook 已存在, 跳过");
  process.exit(0);
}

if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(file) && !fs.existsSync(file + ".bak-openasi")) {
  fs.copyFileSync(file, file + ".bak-openasi");
  console.log(`已备份原配置: ${file}.bak-openasi`);
}

settings.hooks.SessionStart.push({
  matcher: "startup|resume|clear|compact|fork",
  hooks: [
    {
      type: "command",
      command: hookPath,
      timeout: 10,
      statusMessage: "OpenASI 签到检查",
    },
  ],
});

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
console.log(`已写入 SessionStart hook → ${file}`);
