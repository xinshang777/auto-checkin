'use strict';
/*
 * 自动签到主程序：依次执行 WorkBuddy 与 Trae 签到，结果写入日志。
 *
 * 用法：
 *   node checkin.js            # 正常跑；当天两端都已完成 → 整轮直接跳过
 *   node checkin.js --force    # 忽略「当日已完成」标记，强制重跑（排障用）
 *
 * 计划任务每天调用本文件 4 次（09:00 / 13:00 / 17:00 / 21:00），
 * 实际由 run-hidden.vbs 以隐藏窗口拉起，不会弹出命令提示符。
 *
 * 设计要点：
 *   - 无感运行：wscript 隐藏窗口启动 node，全程无可见窗口、无交互
 *   - 当日幂等：任一端签到成功即写入 state/daily-status.json 的当天记录，
 *     后续时段的触发会跳过该端；两端都完成则整轮直接退出（只留一行日志），
 *     不再每个时段重复走一遍签到流程；跨天自动重置
 *   - WorkBuddy：签到前若 token 无效/临近过期，自动调用 capture-workbuddy-token.js 刷新
 *     （无头浏览器，不弹窗口）
 *   - Trae：自动从客户端 storage.json 提取 token（约 14 天有效、客户端自动刷新），
 *     内置 9074 限流重试 + 8 分钟总时限；已签到则直接跳过
 *   - 两端独立容错，互不影响：一端失败只重试该端，不会让另一端重复签到
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { traeCheckin } = require('./lib/trae.js');
const { workbuddyCheckin } = require('./lib/workbuddy.js');
const { pickBestToken } = require('./lib/token-sources.js');
const dailyState = require('./lib/daily-state.js');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'checkin.log');
const CAPTURE_SCRIPT = path.join(ROOT, 'capture-workbuddy-token.js');

const FORCE = process.argv.slice(2).includes('--force');

// ── 运行防护 ─────────────────────────────────────────────────────────────
// 计划任务现在通过 wscript 立即返回（隐藏窗口启动），于是任务层面的
//   · MultipleInstances=IgnoreNew（互斥）
//   · ExecutionTimeLimit=PT15M（运行上限）
// 都不再生效。这两件事改由脚本自己兜住，否则会静默退化：
//   1) 单实例锁：上一次还没跑完（例如 Trae 正在退避重试）时，下一次触发直接退出
//   2) 看门狗：任何异常挂起都会在 WATCHDOG_MS 后强制结束并留一行日志
const LOCK_PATH = path.join(ROOT, 'state', 'run.lock.json');
const WATCHDOG_MS = Number(process.env.CHECKIN_WATCHDOG_MS) > 0
  ? Number(process.env.CHECKIN_WATCHDOG_MS)
  : 20 * 60 * 1000;

function readLock() {
  try {
    // 去掉可能的 UTF-8 BOM：被记事本等工具改存后会带 BOM，JSON.parse 会失败，
    // 那样锁会被当成"没有锁"而静默失效
    const raw = fs.readFileSync(LOCK_PATH, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

/** 同步小睡：仅用于抢锁时跨过极短的"文件已建、内容未写"窗口（Node 主线程允许 Atomics.wait） */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
}

/**
 * 原子创建锁文件：用 'wx' 打开（文件已存在则直接失败）。
 * 这样抢锁是"单步原子操作"，不会再出现两个进程同时读到"无锁"、然后双双写入的竞态。
 */
function tryCreateLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        startedAtLocal: new Date().toISOString(),
      }));
    } finally { fs.closeSync(fd); }
    return true;
  } catch (_) { return false; }
}

/** 尝试抢占单实例锁；锁持有者进程已死或锁过期时自动接管 */
function acquireLock() {
  try { fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true }); } catch (_) {}
  if (tryCreateLock()) return { ok: true };

  // 已存在锁文件：判断持有者是否还活着、锁是否已过期。
  // 注意 openSync('wx') 与 writeSync 之间有一个极短窗口 —— 此刻文件已存在但内容为空，
  // readLock() 会解析失败；若立刻当成"损坏锁"删掉，就会误删别人刚创建的锁、两个进程同时跑。
  // 因此内容解析不出来时先短暂等待再重读一次，跨过这个窗口。
  let cur = readLock();
  if (!cur) {
    sleepSync(150);
    cur = readLock();
  }
  if (cur && cur.pid) {
    const age = Date.now() - (cur.startedAt || 0);
    let alive = false;
    try { process.kill(cur.pid, 0); alive = true; } catch (_) { alive = false; }
    if (alive && cur.pid !== process.pid && age < WATCHDOG_MS) {
      return { ok: false, holder: cur };
    }
  }
  // 持有者已死 / 锁过期 / 锁文件损坏（半截 JSON → readLock 返回 null）→ 清掉后重试一次
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  if (tryCreateLock()) return { ok: true };
  if (!fs.existsSync(LOCK_PATH)) {
    // 锁文件根本建不出来（目录不可写等）→ 不能因此阻塞签到，降级放行
    return { ok: true, degraded: true };
  }
  const again = readLock();
  return { ok: false, holder: again || { pid: '未知', startedAtLocal: '未知' } };
}

/** 只释放自己持有的锁，避免误删后来者的锁 */
function releaseLock() {
  try {
    const cur = readLock();
    if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch (_) { /* ignore */ }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('未找到 config.json，请先复制 config.example.json 并填写');
  }
  // 剥掉可能的 UTF-8 BOM：用记事本等工具编辑保存过的话会带上 BOM，
  // 否则 JSON.parse 直接抛错，表现为「配上 token 反而跑不起来」
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

// ── 日志轮转 ─────────────────────────────────────────────────────────────
// 后台无人值守运行，日志只增不减会一直长下去。超过 CHECKIN_LOG_MAX_BYTES 时
// 把当前日志改名存档为 checkin.log.1 / .2 / …（取第一个未占用的序号，
// 不覆盖、不删除任何已有文件），然后从空文件继续写。
const MAX_LOG_BYTES = Number(process.env.CHECKIN_LOG_MAX_BYTES) > 0
  ? Number(process.env.CHECKIN_LOG_MAX_BYTES)
  : 1024 * 1024; // 默认 1 MiB

/** 把字节数写成可读单位，避免小阈值下出现「超过 0 KiB」这种文案 */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} 字节`;
}

function rollLogIfNeeded() {
  let size;
  try {
    size = fs.statSync(LOG_PATH).size;
  } catch (_) {
    return; // 文件还不存在，无需轮转
  }
  if (size < MAX_LOG_BYTES) return;
  for (let i = 1; i <= 999; i += 1) {
    const archived = `${LOG_PATH}.${i}`;
    if (fs.existsSync(archived)) continue;
    try {
      fs.renameSync(LOG_PATH, archived);
      return archived;
    } catch (_) {
      return; // 改名失败不阻塞主流程，继续往原文件追加
    }
  }
}

function log(line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}`;
  // 隐藏窗口运行时控制台不可见/可能已被回收，写控制台失败不能影响落盘
  try { console.log(msg); } catch (_) {}
  try {
    const archived = rollLogIfNeeded();
    if (archived) {
      fs.appendFileSync(LOG_PATH, `[${ts}] [日志轮转] 上一份日志超过 ${formatBytes(MAX_LOG_BYTES)}，已存档为 ${path.basename(archived)}\n`);
    }
    fs.appendFileSync(LOG_PATH, msg + '\n');
  } catch (_) {}
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

/**
 * 调 capture 刷新 token。
 * ⚠️ force=true 时必须带上 --force：capture 在不带 --force 时，只要「当前 token 还没过期」
 * 就直接 exit 0 说"无需刷新"。于是「剩余不足 3 天」「401 已失效」这两种本该刷新的场景
 * 都会被它挡掉，整条预刷新链路变成一次空转（2026-09-29 审查发现）。
 */
function tryRefreshWorkbuddyToken(force) {
  if (!fs.existsSync(CAPTURE_SCRIPT)) {
    log('[WorkBuddy] 未找到 capture-workbuddy-token.js，跳过自动刷新');
    return false;
  }
  log(`[WorkBuddy] token 缺失/即将过期/已失效，尝试自动刷新${force ? '（--force 强制重抓）' : ''}...`);
  try {
    const captureArgs = [CAPTURE_SCRIPT];
    if (force) captureArgs.push('--force');
    const r = spawnSync(process.execPath, captureArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 6 * 60 * 1000,
      windowsHide: true, // 刷新过程中同样不弹控制台
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

/** WorkBuddy 单端签到；成功（含幂等「今日已签到」）则记入当日状态 */
async function runWorkbuddy(cfg, state) {
  try {
    if (needRefreshWorkbuddyToken(cfg)) {
      tryRefreshWorkbuddyToken(true);
      // 刷新后重新读取 config（token 可能已更新）
      try { Object.assign(cfg, loadConfig()); } catch (_) {}
    }
    const r = await workbuddyCheckin(cfg);
    if (r.ok) {
      log(`[WorkBuddy] 成功：${r.message}${r.preview ? ' ' + r.preview : ''}`);
      dailyState.markDone(state, 'workbuddy', r.message);
      return true;
    }
    log(`[WorkBuddy] 失败：${r.message}`);
    // 失败且疑似 token 问题 → 再刷新一次并重试
    if (/token|401|403|失效|过期/i.test(r.message)) {
      if (tryRefreshWorkbuddyToken(true)) {
        try { Object.assign(cfg, loadConfig()); } catch (_) {}
        const r2 = await workbuddyCheckin(cfg);
        if (r2.ok) {
          log(`[WorkBuddy] 刷新 token 后成功：${r2.message}`);
          dailyState.markDone(state, 'workbuddy', r2.message);
          return true;
        }
        log(`[WorkBuddy] 刷新 token 后仍失败：${r2.message}`);
      }
    }
  } catch (e) {
    log(`[WorkBuddy] 异常：${e.message}`);
  }
  return false;
}

/** Trae 单端签到；成功（含「今日已签到（跳过领取）」）则记入当日状态 */
async function runTrae(cfg, state) {
  try {
    const r = await traeCheckin(cfg.trae || {});
    const src = r.tokenSource
      ? `（token来源:${r.tokenSource}${r.tokenExpDays != null ? `,剩余${r.tokenExpDays.toFixed(1)}天` : ''}）`
      : '';
    if (r.ok) {
      log(`[Trae] 成功：${r.message}${r.credits != null ? ' 获得积分=' + r.credits : ''}${src}`);
      dailyState.markDone(state, 'trae', r.message);
      return true;
    }
    log(`[Trae] 失败：${r.message}${src}`);
  } catch (e) {
    log(`[Trae] 异常：${e.message}`);
  }
  return false;
}

async function run() {
  // ① 单实例：上一次未结束时本次直接退出（取代任务层面的 IgnoreNew）
  const lock = acquireLock();
  if (!lock.ok) {
    log(`[跳过] 已有另一个签到进程在运行（pid ${lock.holder.pid}，开始于 ${lock.holder.startedAtLocal}），本轮直接退出`);
    return;
  }
  if (lock.degraded) {
    log('[警告] 单实例锁无法创建（state 目录不可写？），本轮降级放行、不启用互斥保护');
  }

  const cfg = loadConfig();
  const state = dailyState.loadState();

  const wbDone = dailyState.isDone(state, 'workbuddy');
  const traeDone = dailyState.isDone(state, 'trae');

  // ② 当天两端都已签到 → 本轮不发任何请求，直接退出（只留一行日志）
  if (!FORCE && wbDone && traeDone) {
    log(`今日签到已完成（WorkBuddy ${state.workbuddy.at} / Trae ${state.trae.at}），本轮跳过，不重复签到`);
    return;
  }

  log(`===== 自动签到开始 =====${FORCE ? '（--force：忽略当日已完成标记）' : ''}`);

  // ③ WorkBuddy：当天已完成则跳过该端，只补做未完成的一端
  if (!FORCE && wbDone) {
    log(`[WorkBuddy] 今日已完成（${state.workbuddy.at}），跳过`);
  } else {
    await runWorkbuddy(cfg, state);
  }

  // ④ Trae：同上
  if (!FORCE && traeDone) {
    log(`[Trae] 今日已完成（${state.trae.at}），跳过`);
  } else {
    await runTrae(cfg, state);
  }

  // ⑤ 收尾：报告当日整体状态；两端都完成则明确提示后续时段会自动跳过
  const wbNow = dailyState.isDone(state, 'workbuddy');
  const traeNow = dailyState.isDone(state, 'trae');
  if (wbNow && traeNow) {
    log('今日两端签到均已完成，后续时段触发将自动跳过');
  } else {
    const pending = [wbNow ? null : 'WorkBuddy', traeNow ? null : 'Trae'].filter(Boolean).join(' + ');
    log(`本轮结束，未完成：${pending}（将在下一个时段重试）`);
  }

  log('===== 自动签到结束 =====');
}

/** 看门狗 + 锁释放的统一收尾（任务层面已无运行时长上限，这里必须自兜） */
function withWatchdog() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const wd = WATCHDOG_MS >= 60000 ? `${Math.round(WATCHDOG_MS / 60000)} 分钟` : `${WATCHDOG_MS} 毫秒`;
      log(`[看门狗] 运行超过 ${wd} 仍未结束，强制退出（pid ${process.pid}）`);
      releaseLock();
      process.exit(2);
    }, WATCHDOG_MS);
    run().then(
      () => { clearTimeout(timer); resolve(); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

withWatchdog()
  .then(() => { releaseLock(); process.exit(0); })
  .catch((e) => {
    releaseLock();
    log('致命错误：' + (e && e.message ? e.message : e));
    process.exit(1);
  });
