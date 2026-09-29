'use strict';
/*
 * 自动签到主程序：依次执行 WorkBuddy 与 Trae 签到，结果写入日志。
 * 用法：node checkin.js
 * 计划任务每天调用本文件 4 次（09:00 / 13:00 / 17:00 / 21:00）。
 *
 * 特性：
 *   - WorkBuddy：签到前若 token 无效/临近过期，自动调用 capture-workbuddy-token.js 刷新
 *   - Trae：自动从客户端 storage.json 提取 token（约 14 天有效、客户端自动刷新），
 *           内置 9074 限流重试 + 8 分钟总时限；已签到则直接跳过
 *   - 两端独立容错，互不影响
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { traeCheckin } = require('./lib/trae.js');
const { workbuddyCheckin } = require('./lib/workbuddy.js');
const { pickBestToken } = require('./lib/token-sources.js');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'checkin.log');
const CAPTURE_SCRIPT = path.join(ROOT, 'capture-workbuddy-token.js');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('未找到 config.json，请先复制 config.example.json 并填写');
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function log(line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}`;
  console.log(msg);
  try { fs.appendFileSync(LOG_PATH, msg + '\n'); } catch (_) {}
}

// 判断是否需要"抓取刷新"：
// 汇总 config + 本机日志采集后，若仍无 3 天内不会过期的有效 token，则需要刷新。
function needRefreshWorkbuddyToken(cfg) {
  try {
    const cfgToken = cfg && cfg.workbuddy && cfg.workbuddy.accessToken;
    const best = pickBestToken(cfgToken);
    if (!best) return true;
    // pickBestToken 已过滤出未过期者；再要求剩余有效期 > 3 天
    return best.exp * 1000 - Date.now() < 3 * 86400 * 1000;
  } catch (_) {
    return true;
  }
}

function tryRefreshWorkbuddyToken() {
  if (!fs.existsSync(CAPTURE_SCRIPT)) {
    log('[WorkBuddy] 未找到 capture-workbuddy-token.js，跳过自动刷新');
    return false;
  }
  log('[WorkBuddy] token 缺失或即将过期，尝试自动刷新...');
  try {
    const r = spawnSync(process.execPath, [CAPTURE_SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 6 * 60 * 1000,
      windowsHide: true,
    });
    const tail = (s) => (s || '').trim().split('\n').slice(-3).join(' | ');
    if (r.stdout) log('[WorkBuddy][capture] ' + tail(r.stdout));
    if (r.stderr) log('[WorkBuddy][capture-err] ' + tail(r.stderr));
    return r.status === 0;
  } catch (e) {
    log('[WorkBuddy] 自动刷新异常：' + e.message);
    return false;
  }
}

async function run() {
  const cfg = loadConfig();
  log('===== 自动签到开始 =====');

  // WorkBuddy（优先：更稳定，先确保核心积分落袋）
  try {
    if (needRefreshWorkbuddyToken(cfg)) {
      tryRefreshWorkbuddyToken();
      // 刷新后重新读取 config（token 可能已更新）
      try { Object.assign(cfg, loadConfig()); } catch (_) {}
    }
    const r = await workbuddyCheckin(cfg);
    if (r.ok) {
      log(`[WorkBuddy] 成功：${r.message}${r.preview ? ' ' + r.preview : ''}`);
    } else {
      log(`[WorkBuddy] 失败：${r.message}`);
      // 失败且疑似 token 问题 → 再刷新一次并重试
      if (/token|401|403|失效|过期/i.test(r.message)) {
        if (tryRefreshWorkbuddyToken()) {
          try { Object.assign(cfg, loadConfig()); } catch (_) {}
          const r2 = await workbuddyCheckin(cfg);
          log(r2.ok
            ? `[WorkBuddy] 刷新 token 后成功：${r2.message}`
            : `[WorkBuddy] 刷新 token 后仍失败：${r2.message}`);
        }
      }
    }
  } catch (e) {
    log(`[WorkBuddy] 异常：${e.message}`);
  }

  // Trae
  try {
    const r = await traeCheckin(cfg.trae || {});
    const src = r.tokenSource ? `（token来源:${r.tokenSource}${r.tokenExpDays != null ? `,剩余${r.tokenExpDays.toFixed(1)}天` : ''}）` : '';
    if (r.ok) {
      log(`[Trae] 成功：${r.message}${r.credits != null ? ' 获得积分=' + r.credits : ''}${src}`);
    } else {
      log(`[Trae] 失败：${r.message}${src}`);
    }
  } catch (e) {
    log(`[Trae] 异常：${e.message}`);
  }

  log('===== 自动签到结束 =====');
}

run().then(() => process.exit(0)).catch((e) => {
  log('致命错误：' + e.message);
  process.exit(1);
});
