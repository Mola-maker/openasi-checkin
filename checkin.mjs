#!/usr/bin/env node
/**
 * openasi-checkin — OpenASI 每日自动签到核心脚本
 *
 * 站点: https://app.openasi.bitmiracle.cn/dashboard
 * API : https://api.openasi.bitmiracle.cn
 *   POST /api/getCheckinStatus  body {"data":{}}  -> {data:{checkedInToday,todayDate,reward,recentDates}}
 *   POST /api/checkin           body {"data":{}}  -> {data:{...}} | {error:{code:"CONFLICT"}} (已签到)
 * 认证: Authorization: Bearer <localStorage.openasi_token>
 *
 * 模式:
 *   默认          API 直连签到; token 失效时用 Playwright 持久化浏览器配置自动提取/刷新 token
 *   --status      仅查询签到状态, 不签到
 *   --login       打开有头浏览器, 人工登录一次, token 自动落盘
 *   --ui          通过页面按钮完成签到 (Playwright 点击, 用于校验页面结构流程)
 *   --if-not-today 若本地记录显示今天已成功, 直接跳过 (供 hook/定时器高频调用)
 *   --json        输出机器可读 JSON
 *   --headed      浏览器可见 (调试)
 *   --quiet       仅输出最终结果行
 *
 * 退出码: 0=成功(已签到/签到成功/跳过) 2=需要人工登录 1=其他错误
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// ---------- 常量 ----------
const APP_URL = "https://app.openasi.bitmiracle.cn";
const DASHBOARD_URL = `${APP_URL}/dashboard`;
const LOGIN_URL = `${APP_URL}/login`;
const API_URL = "https://api.openasi.bitmiracle.cn";
const TOKEN_KEY = "openasi_token";
const VERSION = "1.0.0";

const DATA_DIR = process.env.OPENASI_CHECKIN_HOME || path.join(os.homedir(), ".local", "share", "openasi-checkin");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "checkin.log");
const PROFILE_DIR = path.join(DATA_DIR, "browser-profile");

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const o = {
    mode: "run", // run | status | login | ui
    json: false,
    headed: false,
    quiet: false,
    ifNotToday: false,
    force: false,
    browserTimeout: 30, // 秒: 无头提取 token 的等待时间
    loginTimeout: 300, // 秒: --login 等待人工登录的时间
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--status": o.mode = "status"; break;
      case "--login": o.mode = "login"; break;
      case "--ui": o.mode = "ui"; break;
      case "--json": o.json = true; break;
      case "--headed": o.headed = true; break;
      case "--quiet": o.quiet = true; break;
      case "--if-not-today": o.ifNotToday = true; break;
      case "--force": o.force = true; break;
      case "--browser-timeout": o.browserTimeout = Number(argv[++i]) || 30; break;
      case "--login-timeout": o.loginTimeout = Number(argv[++i]) || 300; break;
      case "--help": case "-h": printHelp(); process.exit(0);
      case "--version": case "-v": console.log(VERSION); process.exit(0);
      default:
        console.error(`未知参数: ${a} (使用 --help 查看用法)`);
        process.exit(1);
    }
  }
  return o;
}

function printHelp() {
  console.log(`openasi-checkin v${VERSION} — OpenASI 每日自动签到

用法: node checkin.mjs [选项]
  (无选项)          执行签到 (幂等, 已签到则直接报告)
  --status          仅查询签到状态
  --login           打开浏览器人工登录并保存会话 (只需一次)
  --ui              通过模拟点击页面签到按钮完成签到
  --if-not-today    本地记录今天已成功则跳过 (hook/定时器用)
  --json            机器可读输出
  --headed          显示浏览器窗口
  --quiet           安静模式
  --browser-timeout <秒>  无头浏览器等待上限 (默认 30)
  --login-timeout  <秒>   人工登录等待上限 (默认 300)
  --help / --version
`);
}

// ---------- 输出与日志 ----------
let ARGS;
const MASK = (t) => (!t ? "(无)" : `${t.slice(0, 6)}…${t.slice(-4)} (len=${t.length})`);

function logLine(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
    // 简单截断, 防止日志无限增长
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > 256 * 1024) {
        const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");
        fs.writeFileSync(LOG_FILE, lines.slice(-500).join("\n"));
      }
    } catch { /* 忽略 */ }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* 日志失败不影响主流程 */ }
}

function out(msg) { if (!ARGS?.quiet) console.log(msg); }
function err(msg) { if (!ARGS?.quiet) console.error(msg); }

// ---------- 状态文件 ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- API ----------
class ApiError extends Error {
  constructor(code, message, status) { super(message || code); this.code = code; this.status = status; }
}
function isAuthError(e) {
  if (!(e instanceof ApiError)) return false;
  return [401, 403].includes(e.status) ||
    ["AUTH_ERROR", "UNAUTHORIZED", "INVALID_TOKEN", "AUTH_INVALID", "TOKEN_EXPIRED"].includes(e.code);
}
function isConflict(e) {
  return e instanceof ApiError && (e.code === "CONFLICT" || /已签到/.test(e.message || ""));
}

async function apiPost(endpoint, token, data = {}, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}/api/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ data }),
      signal: ctl.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* 空响应 */ }
    const rotated = res.headers.get("set-auth-token");
    if (body && body.error) throw new ApiError(body.error.code || "API_ERROR", body.error.message, res.status);
    if (!res.ok) throw new ApiError(`HTTP_${res.status}`, `HTTP ${res.status}`, res.status);
    return { data: body?.data ?? null, rotatedToken: rotated || null };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === "AbortError") throw new ApiError("TIMEOUT", `请求超时 (${endpoint})`);
    throw new ApiError("NETWORK_ERROR", `网络错误: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Playwright ----------
let _chromium = undefined;
async function loadPlaywright() {
  if (_chromium !== undefined) return _chromium;
  const candidates = [
    process.env.OPENASI_PLAYWRIGHT_CORE,
    "playwright-core",
    "playwright",
  ].filter(Boolean);
  for (const spec of candidates) {
    try {
      const mod = await import(spec.includes("/") || spec.startsWith("file:") ? pathToFileURL(path.resolve(spec)).href : spec);
      _chromium = (mod.chromium) || null;
      if (_chromium) return _chromium;
    } catch { /* 尝试下一个 */ }
  }
  _chromium = null;
  return null;
}

async function launchProfile(opts = {}) {
  const chromium = await loadPlaywright();
  if (!chromium) {
    const e = new Error("playwright-core 不可用");
    e.code = "NO_PLAYWRIGHT";
    throw e;
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !opts.headed,
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check"],
  });
}

async function readTokenFromPage(page, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const url = page.url();
    const token = await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY).catch(() => null);
    if (token) return token;
    if (/\/login/.test(url)) return null; // 未登录, 快速失败
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

/** 无头浏览器: 打开 dashboard, 提取(可能被刷新的) localStorage token */
async function tokenFromBrowser({ headed = false, timeoutSec = 30 } = {}) {
  let ctx;
  try {
    ctx = await launchProfile({ headed });
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: timeoutSec * 1000 }).catch(() => {});
    const token = await readTokenFromPage(page, timeoutSec * 1000);
    if (token) {
      // 等应用自身的请求跑完, 以吸收 set-auth-token 轮换后的新值
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      return (await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY).catch(() => null)) || token;
    }
    return null;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

/** 人工登录: 打开有头浏览器, 轮询等待 localStorage 出现 token */
async function interactiveLogin({ timeoutSec = 300 } = {}) {
  const ctx = await launchProfile({ headed: true });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    out("已打开浏览器窗口, 请在页面中完成登录 (最多等待 " + timeoutSec + " 秒)…");
    out("提示: 登录成功后无需手动关闭窗口, 脚本会自动检测并保存会话。");
    const token = await readTokenFromPage(page, timeoutSec * 1000);
    if (!token) return null;
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return (await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY).catch(() => null)) || token;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** UI 模式: 通过页面结构 (签到按钮) 完成签到 */
async function uiCheckin({ headed = false, timeoutSec = 30 } = {}) {
  const ctx = await launchProfile({ headed });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    // 先监听应用自身的 getCheckinStatus 响应 (按钮文案随其结果翻转: 签到 -> 已签到)
    const statusResp = page
      .waitForResponse((r) => r.url().includes("/api/getCheckinStatus"), { timeout: timeoutSec * 1000 })
      .catch(() => null);
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: timeoutSec * 1000 });
    const token = await readTokenFromPage(page, timeoutSec * 1000);
    if (!token) return { needsLogin: true, token: null };
    await statusResp;

    const readText = () =>
      page
        .evaluate(() => {
          const b = Array.from(document.querySelectorAll("button")).find((x) => /签到/.test(x.textContent || ""));
          return (b?.textContent || "").trim();
        })
        .catch(() => "");

    // 等按钮文字稳定 (连续两次一致且非空), 最多 5 秒
    let btnText = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      btnText = await readText();
      if (btnText) {
        await page.waitForTimeout(350);
        const again = await readText();
        if (again && again === btnText) break;
        btnText = again;
      } else {
        await page.waitForTimeout(250);
      }
    }
    if (!btnText) return { error: "checkin-button-not-found", token };
    if (/已签到/.test(btnText)) return { checkedInToday: true, token, clicked: false };

    // 真实用户式点击
    const checkinBtn = page.locator("button").filter({ hasText: /签到/ }).first();
    await checkinBtn.click({ timeout: 10000 });

    // 优先用 UI 变化确认, 再用 API 状态做权威确认
    const uiOk = await page
      .waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => /已签到/.test(b.textContent || "")), null, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    let confirmed = uiOk;
    try {
      const r = await apiPost("getCheckinStatus", token, {});
      confirmed = !!r.data?.checkedInToday;
    } catch { /* 用 UI 结果兜底 */ }
    return { checkedInToday: confirmed, token, clicked: true, uiOk };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ---------- 主流程 ----------
function report(result) {
  if (ARGS.json) {
    const safe = { ...result };
    delete safe.token; // 永不输出明文 token
    if (result.token) safe.tokenMasked = MASK(result.token);
    console.log(JSON.stringify(safe));
  } else {
    console.log(result.message);
    if (result.reward != null) console.log(`奖励: ${result.reward}`);
    if (result.todayDate) console.log(`日期: ${result.todayDate}`);
  }
  logLine(`result=${result.result} detail="${result.message}"`);
}

/** 用给定 token 完成一次 状态查询(+可选签到)。返回标准化结果 */
async function runWithToken(token, { doCheckin, forceStatusOnly = false, source }) {
  const st = loadState();
  let status;
  try {
    const r = await apiPost("getCheckinStatus", token, {});
    if (r.rotatedToken && r.rotatedToken !== token) {
      token = r.rotatedToken;
      st.token = token; st.tokenSavedAt = new Date().toISOString();
      saveState(st);
      logLine(`token 已轮换并保存 (${MASK(token)})`);
    }
    status = r.data || {};
  } catch (e) {
    if (isAuthError(e)) return { authFailed: true, error: e };
    throw e;
  }
  const base = {
    ok: true,
    token,
    tokenSource: source,
    checkedInToday: !!status.checkedInToday,
    todayDate: status.todayDate,
    reward: status.reward,
    recentDates: status.recentDates,
  };
  if (status.checkedInToday) return { ...base, result: "already", message: "今天已经签到过了 (无需重复签到)" };
  if (forceStatusOnly) return { ...base, result: "not-checked-in", message: "今天还未签到" };

  try {
    const r = await apiPost("checkin", token, {});
    return {
      ...base,
      checkedInToday: true,
      result: "checked-in",
      message: "签到成功 🎉",
      reward: r.data?.reward ?? base.reward,
    };
  } catch (e) {
    if (isConflict(e)) return { ...base, checkedInToday: true, result: "already", message: "今天已经签到过了 (并发/重复请求)" };
    if (isAuthError(e)) return { authFailed: true, error: e };
    throw e;
  }
}

async function main() {
  ARGS = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const state = loadState();

  try {
    // 模式 1: 人工登录
    if (ARGS.mode === "login") {
      const token = await interactiveLogin({ timeoutSec: ARGS.loginTimeout }).catch((e) => {
        if (e.code === "NO_PLAYWRIGHT") { err("错误: 未找到 playwright-core, 无法打开浏览器。请先 `npm install`。"); process.exit(1); }
        throw e;
      });
      if (!token) { report({ ok: false, result: "needs-login", message: "登录超时, 请重试 --login" }); process.exit(2); }
      const st = loadState();
      st.token = token; st.tokenSavedAt = new Date().toISOString();
      saveState(st);
      out(`登录成功, 会话已保存 (${MASK(token)})`);
      // 顺手完成签到
      const r = await runWithToken(token, { doCheckin: true, source: "login" });
      if (r.authFailed) { report({ ok: false, result: "error", message: "登录后 token 校验失败, 请重试" }); process.exit(2); }
      report({ ...r, durationMs: Date.now() - t0 });
      process.exit(0);
    }

    // 节流: --if-not-today
    if (ARGS.ifNotToday && !ARGS.force && state.lastSuccessLocalDate === localDate()) {
      report({ ok: true, result: "skipped", message: `今天 (${localDate()}) 已签到过, 跳过`, checkedInToday: true });
      process.exit(0);
    }

    // 解析 token: env -> state -> 浏览器
    let token = process.env.OPENASI_TOKEN || state.token || null;
    let source = process.env.OPENASI_TOKEN ? "env" : state.token ? "state" : null;

    if (ARGS.mode === "ui") {
      const r = await uiCheckin({ headed: ARGS.headed, timeoutSec: ARGS.browserTimeout }).catch((e) => {
        if (e.code === "NO_PLAYWRIGHT") { err("错误: playwright-core 不可用"); process.exit(1); }
        throw e;
      });
      if (r.needsLogin) { report({ ok: false, result: "needs-login", message: "浏览器会话失效, 请运行: node checkin.mjs --login" }); process.exit(2); }
      if (r.error) { report({ ok: false, result: "error", message: `UI 模式失败: ${r.error}` }); process.exit(1); }
      const st = loadState();
      if (r.token) { st.token = r.token; st.tokenSavedAt = new Date().toISOString(); }
      st.lastAttempt = new Date().toISOString();
      if (r.checkedInToday) { st.lastSuccessLocalDate = localDate(); st.lastResult = "checked-in-ui"; }
      saveState(st);
      report({
        ok: r.checkedInToday, checkedInToday: r.checkedInToday,
        result: r.checkedInToday ? (r.clicked ? "checked-in" : "already") : "error",
        message: r.checkedInToday ? (r.clicked ? "签到成功 🎉 (UI 模式)" : "今天已经签到过了 (UI 检查)") : "UI 签到未能确认, 请检查页面",
        durationMs: Date.now() - t0,
      });
      process.exit(r.checkedInToday ? 0 : 1);
    }

    let authFailed = false;
    if (token) {
      const r = await runWithToken(token, { doCheckin: ARGS.mode !== "status", forceStatusOnly: ARGS.mode === "status", source });
      if (!r.authFailed) {
        // 成功路径
        const st = loadState();
        st.token = r.token; st.lastAttempt = new Date().toISOString();
        if (r.result === "checked-in" || r.result === "already") {
          st.lastSuccessLocalDate = localDate();
          st.lastResult = r.result;
          st.consecutiveFailures = 0;
        }
        saveState(st);
        report({ ...r, durationMs: Date.now() - t0 });
        process.exit(0);
      }
      authFailed = true;
      logLine(`token 失效 (${MASK(token)}), 尝试浏览器提取`);
      // 清掉失效 token, 走浏览器路径
      const st = loadState();
      if (!process.env.OPENASI_TOKEN) { delete st.token; saveState(st); }
    }

    // 浏览器提取 token
    let browserToken = null;
    try {
      browserToken = await tokenFromBrowser({ headed: ARGS.headed, timeoutSec: ARGS.browserTimeout });
    } catch (e) {
      if (e.code === "NO_PLAYWRIGHT") {
        report({ ok: false, result: "needs-login", message: "playwright-core 不可用且无有效 token。请 npm install 后运行 --login" });
        process.exit(2);
      }
      throw e;
    }

    if (!browserToken) {
      report({ ok: false, result: "needs-login", message: "浏览器会话无效或已过期, 请运行: node checkin.mjs --login" });
      process.exit(2);
    }

    const r2 = await runWithToken(browserToken, { doCheckin: ARGS.mode !== "status", forceStatusOnly: ARGS.mode === "status", source: "browser" });
    if (r2.authFailed) {
      report({ ok: false, result: "needs-login", message: "浏览器会话 token 无法通过校验, 请运行: node checkin.mjs --login" });
      process.exit(2);
    }
    const st = loadState();
    st.token = r2.token; st.tokenSavedAt = new Date().toISOString(); st.lastAttempt = new Date().toISOString();
    if (r2.result === "checked-in" || r2.result === "already") {
      st.lastSuccessLocalDate = localDate();
      st.lastResult = r2.result;
      st.consecutiveFailures = 0;
    }
    saveState(st);
    report({ ...r2, durationMs: Date.now() - t0 });
    process.exit(0);
  } catch (e) {
    const st = loadState();
    st.consecutiveFailures = (st.consecutiveFailures || 0) + 1;
    st.lastAttempt = new Date().toISOString();
    st.lastError = `${e.code || "ERROR"}: ${e.message}`;
    saveState(st);
    report({ ok: false, result: "error", message: `签到失败: ${e.message}`, error: { code: e.code, message: e.message }, durationMs: Date.now() - t0 });
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("未捕获错误:", e);
  process.exit(1);
});
