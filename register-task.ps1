# 注册「每日自动签到」计划任务
# 以当前用户运行即可（无需管理员：注册的是"仅在用户登录时运行"的任务）。
#
# 无感运行说明：
#   计划任务若直接执行 node.exe（控制台程序），在"仅登录时运行"模式下会弹出命令提示符窗口。
#   因此这里改为执行 run-hidden.vbs —— 它由 wscript.exe（GUI 子系统）承载，
#   内部用 WshShell.Run(cmd, 0, False) 以"隐藏窗口 + 不等待"启动 node，全程无可见窗口。
$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$TaskName = 'DailyCheckin'

$WshHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$Launcher = Join-Path $ProjectDir 'run-hidden.vbs'
$UseHidden = (Test-Path $WshHost) -and (Test-Path $Launcher)

if ($UseHidden) {
    $action = New-ScheduledTaskAction -Execute $WshHost `
        -Argument ('//B //Nologo "{0}"' -f $Launcher) `
        -WorkingDirectory $ProjectDir
    $ActionDesc = "$WshHost //B //Nologo $Launcher（隐藏窗口，不弹命令提示符）"
} else {
    # 退化路径：没有 wscript 或启动器时直接跑 node（会短暂弹出控制台窗口）
    # 托管 Node 的版本目录在运行时发现，避免硬编码版本号（升级后主路径会失效）
    $ManagedNode = $null
    $NodeVersions = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
    if (Test-Path $NodeVersions) {
        $ManagedNode = Get-ChildItem $NodeVersions -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'node.exe' } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
    }
    if (-not $ManagedNode) {
        $SystemNode = Join-Path $env:ProgramFiles 'node\node.exe'
        if (Test-Path $SystemNode) { $ManagedNode = $SystemNode }
    }
    if ($ManagedNode) { $NodeExe = $ManagedNode } else { $NodeExe = 'node' }
    $action = New-ScheduledTaskAction -Execute $NodeExe `
        -Argument ('"{0}"' -f (Join-Path $ProjectDir 'checkin.js')) `
        -WorkingDirectory $ProjectDir
    $ActionDesc = "$NodeExe checkin.js（⚠️ 未找到 run-hidden.vbs，会弹出命令提示符窗口）"
}

# 每天触发 4 次，覆盖可能开机的时段；错过某次由 StartWhenAvailable 在下次开机时补跑。
# 注：当天任一端签到成功后即写入 state/daily-status.json，后续时段自动跳过该端，
#     两端都完成则整轮直接退出 —— 所以 4 次触发不会重复走一遍签到流程。
$TriggerTimes = @('09:00', '13:00', '17:00', '21:00')

# 若已存在则先注销再重建，保证为最新配置
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$triggers = @()
foreach ($tm in $TriggerTimes) { $triggers += New-ScheduledTaskTrigger -Daily -At $tm }

$settings = New-ScheduledTaskSettingsSet `
    -Hidden `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

# 当前用户、登录后才运行（便于读取本机客户端登录态）
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal | Out-Null

Write-Host "已注册计划任务 '$TaskName'：每天 $($TriggerTimes -join ' / ') 共 $($TriggerTimes.Count) 次"
Write-Host "执行命令：$ActionDesc"
Write-Host "查看：Get-ScheduledTask -TaskName $TaskName ｜ 手动试跑：Start-ScheduledTask -TaskName $TaskName"
Write-Host "日志：$ProjectDir\checkin.log（后台无窗口运行，日志是唯一痕迹）"
