# 自动签到脚本（Trae + WorkBuddy）

每天 **自动运行 4 次**：`09:00 / 13:00 / 17:00 / 21:00`，分别完成 **Trae** 与 **WorkBuddy** 的每日积分签到。

- 4 次均匀覆盖可能开机的时段，几点开电脑都能签上；错过某次由 `StartWhenAvailable` 在下次开机时补跑。
- 任一次成功即签到完成，其余次数会自动识别"今日已签到"幂等跳过，不会重复领取。
- 原先夜间 `23:00–23:50` 共 6 次的密集触发，是为 Trae `9074` 限流留重试窗口。2026-09-28 修掉 9074 根因
  （`x-device-id` 用错设备 ID）后已无必要，且 `lib/trae.js` 自身已有 10 次 / 8 分钟退避重试，故精简为 4 次。
核心签到纯 Node.js 实现、零 npm 依赖（只用内置 `crypto` / `fetch`）。

**两端的 token 现在都能自动获取，无需你手动抓取：**
- **Trae**：自动从本机 **Trae CN 客户端**的 `storage.json` 解密提取 token（约 14 天有效，客户端会自动刷新）。
- **WorkBuddy**：自动从本机桌面端**日志**采集最新 token，并有多层兜底。

> 项目目录：`<安装目录>/`（可整体移动到任意位置，移动后重跑注册计划任务的命令即可）

---

## 目录结构
```
auto-checkin/
├── checkin.js                # 主程序：依次跑 WorkBuddy、Trae，必要时自动刷新 token，写日志
├── capture-trae-token.js     # Playwright 抓取 Trae 网页会话 token
├── capture-workbuddy-token.js# Playwright 抓取/刷新 WorkBuddy token（仅在无有效 token 时使用）
├── config.json               # 你的配置（含 token，勿分享）
├── config.example.json       # 配置模板
├── lib/
│   ├── trae.js               # Trae：读取客户端登录态 + 解密 + 调签到接口
│   ├── workbuddy.js          # WorkBuddy：多来源取 token + 调官方签到接口（免抓包）
│   └── token-sources.js      # token 多来源采集器：扫描本机客户端日志取最新 JWT
├── register-task.ps1         # 注册 Windows 计划任务（每天 4 次：09:00 / 13:00 / 17:00 / 21:00）
├── DailyCheckin.backup.xml   # 计划任务定义备份（改配置前导出的旧版）
├── package.json              # npm 脚本（仅 Playwright 相关）
├── .gitignore                # 排除敏感文件
├── trae-token.json           # （自动生成）Trae token 缓存文件
└── checkin.log               # 运行日志
```

---

## 前置条件
- Windows 10/11。
- Node.js（本机已具备托管版本：`%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`）。
  `register-task.ps1`（或下方内联命令）会自动选用该 Node；手动运行时也可直接用系统 `node`。
- 依赖安装（仅用 Playwright 自动抓 Trae token 才需要）：
  ```bash
  cd <安装目录>
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
  npm run install-browser
  ```

---

## 一、Trae 签到（token 自动获取，免手动）

**token 从哪来（关键）**：Trae 签到接口需要 `Authorization: Cloud-IDE-JWT <token>` + `x-device-id: <deviceId>`。
脚本会**自动**按"有效期最长"原则取 token：

1. **本机 Trae CN 客户端存储（主力，实现无人值守）**
   `%APPDATA%\Trae CN\User\globalStorage\storage.json` 中的键 `iCubeAuthInfo://icube.cloudide`
   是加密的登录态，解密后得到 token（**约 14 天有效**，且**客户端会自动刷新**）。
   只要你的 **Trae CN 客户端处于登录状态**，脚本每次运行都能自动取到新 token——**你不需要做任何事**。
   > 已实测：该 token 通过签到接口（HTTP 200 / `code:0`），有效期约 13.8 天（远长于网页会话 token 的 ~8 小时）。
   > device-id 自动从 `storage.json` 的 `telemetry.devDeviceId` 提取。
2. **`config.trae.manualToken`**：手动配置的 token（若填了且有效期更长则优先）。
3. **`trae-token.json`**：历史抓取的 token 缓存（兜底）。

> 解密算法：AES-128-CBC + SHA-512 密钥派生（"tc" 格式），已在客户端 storage.json 上实测验证（见 `lib/trae.js`）。
> 若将来客户端版本变化导致解密失败，脚本会明确报错，此时用下面的兜底方式。

### 兜底：手动提供 token

**方式 A：浏览器 F12 复制**
1. 用 Edge / Chrome 打开 `https://www.trae.cn` 并登录。
2. `F12` → `Application` → 左侧 `Local Storage` → 找到键 **`Cloud-IDE-Token`**。
3. 复制其值（`eyJhbGci...` 长串），粘贴到 `config.json` 的 `trae.manualToken`。

**方式 B：Playwright 自动抓取**
```bash
cd <安装目录>
npm run capture        # 打开浏览器登录一次，自动写入 trae-token.json
```

### Trae 配置项（`config.trae`）
| 字段 | 说明 |
|---|---|
| `host` | 签到接口域名，默认 `https://api.trae.cn`（不行可试 `https://api.trae.com.cn`） |
| `storageJson` | 可选：手动指定 `storage.json` 路径（一般自动探测，无需填） |
| `cloudideStorage` | 可选：手动指定含 cloudide token 的 `storage.json` 路径（一般自动探测 Trae CN） |
| `manualToken` | 可选：手动 token（一般留空，自动获取即可） |
| `tokenFile` | 可选：token 缓存文件路径（默认 `trae-token.json`） |
| `maxRetry` / `minWait` / `maxWait` | 9074 高峰重试次数与退避（毫秒） |
| `deadlineMs` | 单次运行总时限（默认 8 分钟），到点停止重试 |
| `region` | 可选：`X-User-Region` 请求头，默认 `CN` |

### ⚠️ 关键坑：`x-device-id` 必须用「aha 设备 ID」（2026-09-28 实测）

这是**最容易踩、最难查**的一个坑，务必了解：

Trae 桌面端（Electron）实际发请求时，用的是 **aha 设备服务注册的设备 ID**，而不是
`storage.json` 里的 `telemetry.devDeviceId`。两者是完全不同的值，例如：

| 字段 | 示例值 | 能否用于签到 |
|---|---|---|
| `telemetry.devDeviceId`（旧脚本误用） | `<你的-telemetry-设备ID>` | ❌ 返回 9074 |
| **aha 设备 ID（客户端实际使用）** | `<你的-aha-设备ID>` | ✅ 正常领取 |

aha 设备 ID 就藏在 `storage.json` 的**键名**里：`iCubeAuthInfo://icube-dc:<数字ID>`。
脚本已自动从键名提取（`lib/trae.js` 的 `findAhaDeviceId()`），无需手工配置。

**为什么难查**：设备 ID 错误时，服务端返回的是 `9074 当前参与用户太多，请稍后再试`，
看起来完全像高峰限流，会让人误以为"就是抢不到"。而 `status` 接口不校验设备 ID，
只有 `claim`（领取）接口校验——所以表现为"查询正常、领取永远失败"。

除设备 ID 外，客户端请求还固定带了以下头/体，脚本已全部对齐：

- 请求头：`Authorization: Cloud-IDE-JWT <token>`、`x-device-id`、`X-User-Region`、
  `x-app-version`（取自 `iCubeLastVersion`，如 `<你的客户端版本>`）、`x-device-type`、`x-device-brand`、`x-os-version`
- 请求体：`{"req_source": 1}`（IDE 客户端为 1，Lite 为 2），**不能发空 body**

> 结论：若日后再次出现"一直 9074"，第一件事是确认 `x-device-id` 是否等于
> `storage.json` 中 `iCubeAuthInfo://icube-dc:<id>` 的数字 ID。
> 自 2026-09-29 起 `lib/trae.js` 在 aha ID 缺失时会直接打印警告并说明该 ID 会导致 9074，
> 这一步无需再手工排查。

---

## 二、配置 WorkBuddy 签到（粘贴 token，免抓包）

WorkBuddy 的签到是客户端内的官方 API 调用，逆向自桌面端 `app.asar` 后已可直接调用，**不需要再抓包**：
- 状态查询：`POST https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status`
- 执行签到：`POST https://www.workbuddy.cn/v2/billing/meter/daily-checkin`
- 鉴权头：`Authorization: Bearer <token>` + `X-User-Id: <uid>`（`X-Domain` 可选，已验证带不带都能成功）
- 幂等：`daily-checkin` 返回 `code=0` 视为成功；返回 `code=10001`（今日已签到）一律视为成功（网关会把它包成 HTTP 400，脚本按响应体 `code` 判断，不会误判）

**token 来源（三层自动兜底，尽量免人工）**：

WorkBuddy 的 accessToken 是 55 天有效的 JWT。脚本按下面优先级**自动挑选最新可用的 token**，无需你频繁操作：

1. **本机日志自动采集（主力，实现自动续期）**
   WorkBuddy / CodeBuddy 桌面端在运行时会把它**当前有效的 token 写入本地日志**，且客户端自身续期后新 token 也会落到日志里。
   脚本每次运行都会扫描以下目录，取出**有效期最长**的那个 JWT 使用（已实测：把 config 里的 token 清空后，仅凭日志仍可成功签到）：
   - `%USERPROFILE%\.workbuddy\logs`（iss=`www.workbuddy.cn`）
   - `%LOCALAPPDATA%\CodeBuddyExtension\Logs`（iss=`www.codebuddy.cn`，同一账号可用）
   > 也就是说：只要你平时在用 WorkBuddy 桌面端，脚本就能自动"捡"到它续期后的新 token，基本无需手动重抓。
2. **`config.json` 里的 `accessToken`（基线）**
   本机已写入一个明文 JWT（约 55 天有效）。当上面采集不到更新 token 时，用它兜底。
3. **浏览器会话抓取（最后手段）**
   若 `config` 与日志都拿不到有效 token（例如很久没用桌面端、或日志被清空），可运行 `capture-workbuddy-token.js` 从浏览器会话获取：
   ```bash
   node capture-workbuddy-token.js --login   # 首次：打开可见浏览器，登录一次（登录态会保存在 .wb-browser-profile/）
   node capture-workbuddy-token.js           # 之后：无头模式自动刷新，无需你再登录
   ```
   `checkin.js` 在检测到无有效 token 时也会**自动调用**该脚本尝试刷新。

**手动重抓（最简，任何时候都可用）**：

> 脚本会自动从 token（JWT 的 `sub` 字段）解析出 `uid`，所以你**只需粘贴新 token** 即可，`uid` 可留空。

- **方法 A（推荐，最简单）：浏览器 F12 复制**
  1. 用 Edge / Chrome 打开 `https://www.workbuddy.cn` 并登录你的 WorkBuddy 账号。
  2. 按 `F12` → `Network`（网络）→ 刷新页面。
  3. 在请求列表里点任意一条发往 `www.workbuddy.cn` 的请求，查看其请求头，找到 `Authorization: Bearer eyJhbGci...` 这一行。
  4. 复制 `Bearer ` 后面那整串 JWT（不带 `Bearer ` 本身）。
  5. 粘贴到 `config.json` 的 `workbuddy.accessToken`。

- **方法 B（备用）：从本机登录态文件取 uid（仅当方法 A 的 token 接口不接受时）**
  `workbuddy-desktop.info` 的 `account.uid` 字段是明文可读的（路径：
  `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`）。
  若方法 A 拿到的网页 token 不被签到接口接受，再把该 `uid` 填到 `config.workbuddy.uid`。

> ⚠️ 当 token 临近过期（≤3 天）或已过期时，脚本会打印 **警告 / “token 已过期”** 并跳过 WorkBuddy，此时用上面方法重抓一次即可。

### WorkBuddy 配置项（`config.workbuddy`）
| 字段 | 说明 |
|---|---|
| `accessToken` | **必填**：上面复制的 Bearer token（JWT） |
| `uid` | 可选：账号 uid（脚本能自动从 token 解析，留空即可） |
| `domain` | 可选：一般留空（已验证不带 X-Domain 也能成功） |
| `atRestSecretKey` | 高级：若你拿到离线解密主密钥可填（实验性，当前版本密钥在原生层，无法纯 Node 获取） |

---

## 三、运行与测试
```bash
# 手动跑一次，验证两端配置是否正确
cd <安装目录>
npm run checkin          # 等价于：node checkin.js
# 或直接用托管 Node：
%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe checkin.js
```
查看 `checkin.log` 确认结果。

- WorkBuddy 输出 `WorkBuddy 签到成功` 或 `WorkBuddy 今日已签到（幂等）` 都算成功。
- Trae 输出 `Trae 签到成功` 为成功。若出现 `9074`：**先查设备 ID**（见「一、⚠️ 关键坑」——脚本在 aha ID 缺失时会打印警告，说明 storage.json 结构变了）；排除设备问题后，才是真·高峰限流，脚本已自动退避重试。

---

## 四、计划任务（每天共 4 次）

计划任务已通过内联 PowerShell 注册为 **DailyCheckin**，共 **4 个每日触发器**：
`09:00 / 13:00 / 17:00 / 21:00`。

用户登录后才运行（便于读取本机客户端登录态），动作使用托管 Node 运行 `checkin.js`。
电源与网络设置：允许电池下启动（不禁止、也不会因切电池而中止）、错过触发后开机补跑、仅在有网络时运行。

> 直接重跑 `register-task.ps1` 即可按当前脚本重建任务（会先注销旧任务）。
> 注意该脚本含中文，**必须是 UTF-8 with BOM**，否则 Windows PowerShell 5.1 会按 GBK 解析而报语法错误。

- 查看：`Get-ScheduledTask -TaskName DailyCheckin`
- 手动测试：任务计划程序里右键「运行」，或 `Start-ScheduledTask -TaskName DailyCheckin`
- 改时间：用下面的命令重跑注册逻辑：
  ```powershell
  $ProjectDir="<安装目录>"
  $NodeExe="$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
  $ScriptPath=Join-Path $ProjectDir 'checkin.js'
  if (Get-ScheduledTask -TaskName 'DailyCheckin' -ErrorAction SilentlyContinue){Unregister-ScheduledTask -TaskName 'DailyCheckin' -Confirm:$false}
  $a=New-ScheduledTaskAction -Execute $NodeExe -Argument """$ScriptPath""" -WorkingDirectory $ProjectDir
  $triggers=@('09:00','13:00','17:00','21:00') | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
  $s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 2)
  $p=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'DailyCheckin' -Action $a -Trigger $triggers -Settings $s -Principal $p
  ```

---

## 五、排障
| 现象 | 处理 |
|---|---|
| Trae：`9074` | **两种成因**：① 真实高峰限流（服务端行为，脚本已自动重试）；② **`x-device-id` 与 token 不匹配**——用错了 `telemetry.devDeviceId` 而非 aha 设备 ID。脚本已按客户端实现自动取 aha ID；若仍持续 9074，按「一、⚠️ 关键坑」排查。 |
| Trae：`9004` | token / device-id 不正确 → 确认 **Trae CN 客户端处于登录状态**（脚本会自动取它维护的 token）；或按「一」兜底手动填 `manualToken`。 |
| Trae：`未找到 Trae token` | 客户端未登录且无缓存 → 打开 Trae CN 客户端登录一次，或按「一」兜底提供 token。 |
| WorkBuddy：`未找到 WorkBuddy token` | config 与日志都采集不到有效 token → 确保桌面端近期登录过；或运行 `node capture-workbuddy-token.js --login` 登录一次；或按「二」手动粘贴 |
| WorkBuddy：`token 已过期` | 通常是长期未用桌面端导致日志里也是旧 token → 运行 `node capture-workbuddy-token.js --login`，或按「二」方法 A 手动复制 Bearer token |
| 计划任务不触发 | 确认「仅在用户登录时运行」且电脑未关机/注销（休眠不会唤醒，`WakeToRun` 未开启）；用「运行」手动验证。4 个触发点（09:00/13:00/17:00/21:00）已覆盖主要开机时段，错过还会补跑 |
| `capture-workbuddy-token.js` 无头抓取失败 | 实测（2026-09-29）：`.wb-browser-profile` 无有效登录态，无头跑 90 秒仍 `no-usable-token`。需执行一次 `node capture-workbuddy-token.js --login` 在可见浏览器里手动登录，登录态落盘后自动刷新才可用。**只要平时开着桌面端，日志采集就能持续续期，这条兜底不必依赖** |

---

## 六、安全
- `config.json`（含 token）与 `trae-token.json` **不要提交到公开仓库、不要分享给他人**。
- 脚本只**读取** Trae 登录态文件，绝不修改它；日志不记录明文 token（仅记脱敏片段与积分结果）。
- WorkBuddy 的 token 仅发往 `www.workbuddy.cn` 官方签到接口，不上传任何第三方。
- 仅用于本机本人账号的合规个人自动化。
