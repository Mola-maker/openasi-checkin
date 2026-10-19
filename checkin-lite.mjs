#!/usr/bin/env node
/**
 * openasi-checkin-lite — 零依赖轻量版 OpenASI 签到脚本
 *
 * 不用浏览器, 直接以真实客户端同款请求头调用 API:
 *   POST https://api.openasi.bitmiracle.cn/api/getCheckinStatus  {"data":{}}
 *   POST https://api.openasi.bitmiracle.cn/api/checkin           {"data":{}}
 *
 * token 来源: --token <值> || OPENASI_TOKEN 环境变量 || state.json (由完整版 --login 写入)
 * token 失效时: 默认自动回退到同目录的完整版 checkin.mjs (Playwright 刷新/提取 token),
 *               可用 --no-fallback 关闭。
 *
 * 用法: node checkin-lite.mjs [--status] [--json] [--quiet] [--if-not-today] [--force] [--no-fallback] [--token <t>]
 * 退出码: 0=成功(签到/已签到/跳过) 2=需要人工登录 1=错误
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const API_URL = "https://api.openasi.bitmiracle.cn";
const APP_URL = "https://app.openasi.bitmiracle.cn";
const VERSION = "1.0.0";

// 与真实浏览器客户端一致的请求头 (捕获自 app.openasi.bitmiracle.cn 的实际请求)
const REAL_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

const DATA_DIR = process.env.OPENASI_CHECKIN_HOME || path.join(os.homedir(), ".local", "share", "openasi-checkin");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "checkin.log");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FULL_SCRIPT = path.join(__dirname, "checkin.mjs");

// ---------- 参数 ----------
function parseArgs(argv) {
  const o = { mode: "run", json: false, quiet: false, ifNotToday: false, force: false, fallback: true, token: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--status") o.mode = "status";
    else if (a === "--json") o.json = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--if-not-today") o.ifNotToday = true;
    else if (a === "--force") o.force = true;
    else if (a === "--no-fallback") o.fallback = false;
    else if (a === "--token") o.token = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`openasi-checkin-lite v${VERSION} — 零依赖签到（模拟真实客户端请求, 无浏览器）
用法: node checkin-lite.mjs [--status] [--json] [--quiet] [--if-not-today] [--force] [--no-fallback] [--token <t>]`);
      process.exit(0);
    } else if (a === "--version" || a === "-v") {
      console.log(VERSION);
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(1);
    }
  }
  return o;
}

// ---------- 状态与日志 ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(s) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  } catch { /* 忽略 */ }
}
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function logLine(msg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] result=${msg}\n`);
  } catch { /* 忽略 */ }
}

// ---------- API (模拟真实客户端) ----------
function realHeaders(token) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    origin: APP_URL,
    referer: `${APP_URL}/`,
    "user-agent": REAL_UA,
    accept: "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Chromium";v="155", "Not(A:Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
  };
}

async function apiPost(endpoint, token, { timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}/api/${endpoint}`, {
      method: "POST",
      headers: realHeaders(token),
      body: JSON.stringify({ data: {} }),
      signal: ctl.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* 空响应 */ }
    const rotated = res.headers.get("set-auth-token");
    if (body?.error) {
      const e = new Error(body.error.message || body.error.code);
      e.code = body.error.code; e.status = res.status;
      throw e;
    }
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.code = `HTTP_${res.status}`; e.status = res.status; throw e; }
    return { data: body?.data ?? null, rotated };
  } finally {
    clearTimeout(timer);
  }
}
const isAuthError = (e) =>
  [401, 403].includes(e.status) || ["AUTH_ERROR", "UNAUTHORIZED", "INVALID_TOKEN", "AUTH_INVALID", "TOKEN_EXPIRED"].includes(e.code);
const isConflict = (e) => e.code === "CONFLICT" || /已签到/.test(e.message || "");

// ---------- 主流程 ----------
const ARGS = parseArgs(process.argv.slice(2));
const started = Date.now();

function report(result) {
  if (ARGS.json) console.log(JSON.stringify({ ...result, via: "lite" }));
  else console.log(result.message);
  logLine(`${result.result} (lite) "${result.message}"`);
}

function delegateToFull() {
  if (!ARGS.fallback || !fs.existsSync(FULL_SCRIPT)) return null;
  const args = [
    FULL_SCRIPT,
    ...(ARGS.mode === "status" ? ["--status"] : []),
    ...(ARGS.json ? ["--json"] : []),
    ...(ARGS.quiet ? ["--quiet"] : []),
  ];
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  return r.status ?? 1;
}

async function main() {
  const state = loadState();
  const token = ARGS.token || process.env.OPENASI_TOKEN || state.token || null;

  if (ARGS.ifNotToday && !ARGS.force && state.lastSuccessLocalDate === localDate()) {
    return report({ ok: true, result: "skipped", checkedInToday: true, message: `今天 (${localDate()}) 已签到过, 跳过` }) ?? 0;
  }
  if (!token) {
    const rc = delegateToFull();
    if (rc !== null) return rc;
    report({ ok: false, result: "needs-login", message: "没有可用 token。请先运行: node checkin.mjs --login" });
    return 2;
  }

  // 1) 状态查询
  let status;
  try {
    const r = await apiPost("getCheckinStatus", token);
    if (r.rotated && r.rotated !== token) {
      state.token = r.rotated; state.tokenSavedAt = new Date().toISOString(); saveState(state);
    }
    status = r.data || {};
  } catch (e) {
    if (isAuthError(e)) {
      const rc = delegateToFull();
      if (rc !== null) return rc;
      report({ ok: false, result: "needs-login", message: "token 已失效。请运行: node checkin.mjs --login" });
      return 2;
    }
    report({ ok: false, result: "error", message: `签到失败: ${e.message}`, error: { code: e.code } });
    return 1;
  }

  state.lastAttempt = new Date().toISOString();
  const base = { ok: true, checkedInToday: !!status.checkedInToday, todayDate: status.todayDate, reward: status.reward, durationMs: Date.now() - started };

  if (status.checkedInToday) {
    state.lastSuccessLocalDate = localDate(); state.lastResult = "already"; saveState(state);
    return report({ ...base, result: "already", message: "今天已经签到过了 (无需重复签到)" }) ?? 0;
  }
  if (ARGS.mode === "status") {
    report({ ...base, result: "not-checked-in", message: "今天还未签到" });
    return 0;
  }

  // 2) 签到
  try {
    const r = await apiPost("checkin", token);
    state.lastSuccessLocalDate = localDate(); state.lastResult = "checked-in"; saveState(state);
    return report({ ...base, checkedInToday: true, result: "checked-in", message: "签到成功 🎉 (lite)", reward: r.data?.reward ?? base.reward }) ?? 0;
  } catch (e) {
    if (isConflict(e)) {
      state.lastSuccessLocalDate = localDate(); state.lastResult = "already"; saveState(state);
      return report({ ...base, checkedInToday: true, result: "already", message: "今天已经签到过了" }) ?? 0;
    }
    if (isAuthError(e)) {
      const rc = delegateToFull();
      if (rc !== null) return rc;
      report({ ok: false, result: "needs-login", message: "token 已失效。请运行: node checkin.mjs --login" });
      return 2;
    }
    report({ ok: false, result: "error", message: `签到失败: ${e.message}`, error: { code: e.code } });
    return 1;
  }
}

process.exit(await main());
