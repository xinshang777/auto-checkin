# 架构说明

本文说明 `auto-checkin` 的运行链路、模块职责与关键设计取舍。README 里已有的安装步骤不再重复。

## 运行链路

```text
Windows 计划任务 DailyCheckin（每天 09:00 / 13:00 / 17:00 / 21:00）
  └─ wscript.exe //B //Nologo run-hidden.vbs      ← GUI 子系统宿主：自身不创建控制台
       └─ node checkin.js                          ← WshShell.Run(cmd, 0, False)：隐藏窗口、不等待
            ├─ acquireLock()          state/run.lock.json      单实例互斥
            ├─ dailyState.loadState() state/daily-status.json  当日签到状态
            ├─ runWorkbuddy(cfg)      lib/workbuddy.js
            │    └─（token 缺失/将过期时）capture-workbuddy-token.js（无头 Playwright）
            ├─ runTrae(cfg)           lib/trae.js
            └─ 收尾：写状态 + checkin.log（超过 1 MiB 自动轮转）
```

任务动作之所以不是直接 `node.exe`，是因为 node 是控制台程序，用 `InteractiveToken` 身份运行必然弹黑窗。`wscript.exe` 是 GUI 子系统宿主，自身不创建控制台，再由它用隐藏窗口拉起 node，屏幕全程无反应。

## 模块职责

| 文件 | 职责 | 备注 |
| --- | --- | --- |
| `checkin.js` | 主程序：单实例锁 → 读当日状态 → 逐端跳过/执行 → 写状态与日志 | 唯一入口 |
| `run-hidden.vbs` | 隐藏窗口启动器；启动前校验 `checkin.js` 与 node 是否存在，失败写 `[launcher]` 日志 | **必须保持纯 ASCII**，否则 VBS 按 ANSI 解析会出错；node 路径在运行时自动发现托管版本目录 |
| `lib/trae.js` | 读 Trae 客户端登录态 → 解密 token → 调 claim 接口；内置 `9074` 限流退避重试 | 需要 aha 设备 ID |
| `lib/workbuddy.js` | 多来源取 token → 调官方签到接口；按响应体 `code` 判幂等 | `10001` 被网关包成 HTTP 400 |
| `lib/token-sources.js` | 扫描本机日志采集最新 JWT，并挑出有效期最长的一个 | 不写明文 token |
| `lib/daily-state.js` | 当日签到状态的读写与判定（按本机本地日期，跨天自动重置） | 判定失败不落盘 |
| `capture-workbuddy-token.js` | Playwright 兜底抓取/刷新 WorkBuddy token | 默认无头；`--login` 才可见 |
| `capture-trae-token.js` | Playwright 抓取 Trae 网页会话 token（兜底） | 主力仍是客户端 `storage.json` |
| `register-task.ps1` | 注册/重建计划任务，把动作挂到 `run-hidden.vbs` | 必须保存为 **UTF-8 with BOM** |

## 关键设计决策

### 1. 隐藏运行：任务 → wscript → node

任务层用 `wscript.exe` 包装带来一个副作用：启动器瞬间返回，任务在 0.1 秒内就被标记为「已完成」。于是任务层的两个防护**双双失效**：

- `MultipleInstances=IgnoreNew` 不再阻止叠跑；
- `ExecutionTimeLimit=PT15M` 不再能砍掉卡死的运行。

因此这两件事改由脚本自己兜住：

| 原任务层能力 | 脚本层替代实现 |
| --- | --- |
| `IgnoreNew` | `state/run.lock.json` 单实例锁。持有者进程仍存活且年龄 < `CHECKIN_WATCHDOG_MS` → 本轮直接退出；持有者已死或锁过期 → 自动接管；只释放自己的锁 |
| `ExecutionTimeLimit` | 看门狗定时器：超过 `CHECKIN_WATCHDOG_MS`（默认 20 分钟）→ 写 `[看门狗]` 日志 → 释放锁 → `exit(2)` |

锁文件读取时会剥掉 UTF-8 BOM —— 若被记事本等工具改存带 BOM，`JSON.parse` 会失败、锁会被误判为「不存在」而静默失效。

另一个更隐蔽的窗口：`openSync(path, 'wx')` 与写入内容之间，锁文件已存在但内容为空，此时别的进程读锁会解析失败。若不处理就会被当成「损坏锁」删掉对方刚建的锁 → 两个进程同时跑。因此解析不出内容时会先同步等 150 ms 再重读一次，仍为空才判定为损坏锁并接管。

### 2. 当日幂等：签到成功即跳过后续时段

任务每天触发 4 次，但签到只需要成功一次。`state/daily-status.json` 记录当天每一端的状态：

- 任一端成功（含「今日已签到（幂等）」「跳过领取」这类等价成功）→ 立即标记该端完成，**后续时段跳过该端**；
- 两端都完成 → 后续时段**整轮直接退出，零网络请求**，日志只多一行 `今日签到已完成（…），本轮跳过`；
- 只完成一端 → 下一时段**只补跑失败的那一端**；
- **失败不落盘** → 失败端在下一时段自动重试，不会漏签；
- 跨天自动重置（按本机本地日期比较）；
- 排障时需要强制重跑：`node checkin.js --force`。

### 3. token 来源优先级

WorkBuddy：

1. `config.json` 里的 `accessToken`（基线，约 55 天）；
2. 本机日志自动采集（主力，扫描到最新 JWT）；
3. `capture-workbuddy-token.js` 兜底刷新（无头浏览器）。

若剩余有效期不足 3 天，签到前会主动刷新一次（调用 `capture-workbuddy-token.js` 时**必须带 `--force`**：该脚本不带 `--force` 时只要"当前 token 还没过期"就直接退出说无需刷新，会让预刷新变成空转）；若签到失败且错误信息疑似 token 问题（`token` / `401` / `403` / `失效` / `过期`），会再刷新并重试一次。

Trae 的 token 选取同样按 **`exp` 最大者**（客户端 `Trae CN/User/globalStorage/storage.json` 中 `iCubeAuthInfo://icube.cloudide`，解密后约 14 天有效、客户端自动刷新）优先于 `config.trae.manualToken` 与 `trae-token.json` 缓存 —— 但只在 `exp` 相同时才有这个顺序；一般无需人工干预。

### 4. 失败语义

`ok: true` 才计入当日完成，包括以下等价成功：

- WorkBuddy：接口返回 `code: 10001`（今日已签到）；
- Trae：返回「跳过领取」（今日已签）。

其余一律视为失败：只记日志、不写状态，等下一个时段重试。

## 运行时产物

以下文件由脚本运行时产生，均已加入 `.gitignore`，不参与版本控制：

| 路径 | 说明 |
| --- | --- |
| `state/daily-status.json` | 当日签到状态 |
| `state/run.lock.json` | 单实例锁（正常结束时自动删除） |
| `checkin.log` | 运行日志（写控制台失败不影响落盘） |
| `checkin.log.N` | 轮转存档（超过 `CHECKIN_LOG_MAX_BYTES`，默认 1 MiB 时生成） |
| `config.json.tmp` | 抓取脚本原子写 config 的中间文件（写完即改名，正常不残留；**含明文 token**，已 gitignore） |
| `capture.log` | 兜底抓取脚本的日志 |
| `_wb_capture_state.json` | 抓取状态缓存 |
| `.wb-browser-profile/` | Playwright 持久化 profile（含登录态，**不要分享**） |
| `config.json` / `trae-token.json` | 含 token，**不要分享** |

## 可调环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CHECKIN_WATCHDOG_MS` | `1200000`（20 分钟） | 单轮运行上限，超时强制退出 |
| `CHECKIN_LOG_MAX_BYTES` | `1048576`（1 MiB） | 日志轮转阈值 |
| `WB_ENDPOINT` | `https://www.workbuddy.cn` | WorkBuddy 签到端点覆盖（默认端点变更或需指向 `copilot.tencent.com` 时用） |

## 自查判据

无人值守场景下，判断「任务是否真的跑过」不能只看任务结果码 —— `wscript.exe` 的退出码**恒为 0**，脚本没起来时任务照样显示成功。可靠判据是：

> `LastTaskResult = 0` **并且** `checkin.log` 出现了新行，才算真跑过。

若日志停留在 `===== 自动签到开始 =====` 而没有结束行，说明该次进程被外部终止（例如注销/关机），任务结果码会是 `3221225786`（`0xC000013A`）。这种情况不会污染当日状态，下一时段会自动补跑。

## 已知限制

- 计划任务使用「仅在用户登录时运行」，因此电脑关机或注销期间不会触发；休眠也不会自动唤醒（未开启 `WakeToRun`）。错过的时间点由 `StartWhenAvailable` 在恢复后补跑。
- 签到接口为客户端私有接口，若官方调整字段或校验，需要同步修改 `lib/trae.js` / `lib/workbuddy.js`。
- `run-hidden.vbs` 按「托管 Node 版本目录（名字最大者）→ `C:\Program Files\node` → PATH」顺序解析 node，托管 runtime 升级后无需改脚本。
- `checkin.log` 采用简单的大小轮转（保留全部历史档案），没有按时间清理策略；按每天 1~3 行的实际量级，无需更复杂的方案。
- `capture.log`（抓取脚本日志）不做轮转：只有在 token 需要刷新时才会写，量级可忽略。
