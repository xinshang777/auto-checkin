# 注册「每日自动签到」计划任务
# 以管理员或当前用户运行本脚本即可（无需管理员权限也能注册“仅在用户登录时运行”的任务）。
$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
# 优先使用 WorkBuddy 自带的托管 Node，回退到 PATH 中的 node
$ManagedNode = "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if (Test-Path $ManagedNode) { $NodeExe = $ManagedNode } else { $NodeExe = 'node' }

$ScriptPath = Join-Path $ProjectDir 'checkin.js'
$TaskName = 'DailyCheckin'
# 每天触发 4 次，均匀覆盖可能开机的时段；错过某次由 StartWhenAvailable 在下次开机时补跑。
# 说明：原本夜间 23:00-23:50 共 6 次的密集触发，是为应对 Trae 9074 限流留重试窗口；
#       2026-09-28 修掉 9074 根因（x-device-id 用错）后已无必要，
#       且 trae.js 自身已有 10 次 / 8 分钟的退避重试。任一次成功后续自动幂等跳过。
$TriggerTimes = @('09:00', '13:00', '17:00', '21:00')

# 若已存在则先删除，保证为最新配置
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$ScriptPath`"" -WorkingDirectory $ProjectDir
$triggers = @()
foreach ($tm in $TriggerTimes) { $triggers += New-ScheduledTaskTrigger -Daily -At $tm }
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 2)

# 当前用户、登录后才运行（便于读取本机客户端登录态）
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal | Out-Null

Write-Host "已注册计划任务 '$TaskName'：每天 $($TriggerTimes -join ' / ') 共 $($TriggerTimes.Count) 次运行 $NodeExe $ScriptPath"
Write-Host "可用 `Get-ScheduledTask -TaskName $TaskName` 查看，用任务计划程序手动「运行」测试。"
