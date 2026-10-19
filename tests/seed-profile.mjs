// 测试辅助: 把有效 token 注入持久化浏览器配置文件 (模拟 --login 完成后的状态)
// 用法: node tests/seed-profile.mjs <token>
import { chromium } from "playwright-core";
import path from "node:path";
import os from "node:os";

const APP = "https://app.openasi.bitmiracle.cn";
const PROFILE = path.join(os.homedir(), ".local", "share", "openasi-checkin", "browser-profile");
const token = process.argv[2];
if (!token) { console.error("用法: node tests/seed-profile.mjs <token>"); process.exit(1); }

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(APP + "/login", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(([k, t]) => localStorage.setItem(k, t), ["openasi_token", token]);
  await page.goto(APP + "/dashboard", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  const back = await page.evaluate(() => localStorage.getItem("openasi_token"));
  console.log(back ? `OK: profile seeded, token len=${back.length}` : "FAIL: token not found after navigation");
  process.exit(back ? 0 : 1);
} finally {
  await ctx.close();
}
