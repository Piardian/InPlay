$ErrorActionPreference = 'Stop'
$masaRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$masaRuntime = Join-Path $masaRoot 'runtime'
[IO.Directory]::CreateDirectory($masaRuntime) | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script = Join-Path $PSScriptRoot 'supervisor.ps1'
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"'
$encoding = New-Object Text.UTF8Encoding($false)
$config = Get-Content -LiteralPath (Join-Path $masaRoot 'config.example.json') -Raw | ConvertFrom-Json
$config.mode = 'paper'
$config | Add-Member -NotePropertyName headless -NotePropertyValue $true -Force
$config | Add-Member -NotePropertyName logDir -NotePropertyValue (Join-Path $masaRoot 'logs') -Force
$config | Add-Member -NotePropertyName runtimeDir -NotePropertyValue $masaRuntime -Force
[IO.File]::WriteAllText((Join-Path $masaRoot 'config.247.json'), ($config | ConvertTo-Json -Depth 8), $encoding)
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Masa2 InPlay Paper 247.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($startup)
$shortcut.TargetPath = $ps
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $masaRoot
$shortcut.Description = 'Masa 2 in-play paper watchdog; no real orders'
$shortcut.WindowStyle = 7
$shortcut.Save()
$taskName = 'Masa2-InPlay-Paper-247'
$taskInstalled = $false
$taskError = $null
try {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing -and -not (($existing.Actions.Arguments | Out-String).Contains($script))) { throw 'Task name already belongs to a different script' }
    $action = New-ScheduledTaskAction -Execute $ps -Argument $arguments -WorkingDirectory $masaRoot
    $login = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($login, $repeat) -Principal $principal -Settings $settings -Description 'Masa2 paper-only supervisor; mutex and worker singleton; 5min recovery while logged in' -Force | Out-Null
    $taskInstalled = $true
} catch { $taskError = [string]$_ }
$deployment = @{ node = $node; installedUtc = [DateTime]::UtcNow.ToString('o'); taskName = $taskName; taskInstalled = $taskInstalled; taskError = $taskError; startupShortcut = $startup; startupScope = 'Current user logon, not pre-logon boot'; mode = 'paper' }
[IO.File]::WriteAllText((Join-Path $masaRoot 'deployment.json'), ($deployment | ConvertTo-Json -Depth 5), $encoding)
if ($taskInstalled) { Start-ScheduledTask -TaskName $taskName } else { & (Join-Path $PSScriptRoot 'start.ps1') }
$deployment | ConvertTo-Json
