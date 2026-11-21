param([switch]$Once)
$ErrorActionPreference = 'Stop'
$masaRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$masaRuntime = Join-Path $masaRoot 'runtime'
[IO.Directory]::CreateDirectory($masaRuntime) | Out-Null
$masaMutex = New-Object Threading.Mutex($false, 'Local\Masa2InPlayV2Supervisor')
$masaOwned = $false
try { $masaOwned = $masaMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $masaOwned = $true }
if (-not $masaOwned) { $masaMutex.Dispose(); exit 0 }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Masa2Power { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'
$masaChild = $null
$masaRestarts = 0
$masaNextStart = [DateTime]::UtcNow
$masaStderrPath = Join-Path $masaRuntime 'worker.stderr.log'
$masaStdoutPath = Join-Path $masaRuntime 'worker.stdout.log'
$masaDataStatus = 'STARTING'
$masaNewsDelivery = 'UNVERIFIED'
$masaLastState = ''
$masaLastFreshUtc = [DateTime]::UtcNow
function Read-MasaJson($path) {
    for ($i = 0; $i -lt 4; $i++) {
        try {
            if (-not (Test-Path -LiteralPath $path)) { return $null }
            $fs = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            try {
                $sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8, $true)
                try { $raw = $sr.ReadToEnd() } finally { $sr.Dispose() }
            } finally { $fs.Dispose() }
            if ([string]::IsNullOrWhiteSpace($raw)) { throw 'Empty JSON' }
            return ($raw | ConvertFrom-Json)
        } catch {
            if ($i -lt 3) { Start-Sleep -Milliseconds 100 }
        }
    }
    return $null
}
function Write-MasaEvent($type, $details) {
    $event = @{ utc = [DateTime]::UtcNow.ToString('o'); supervisorPid = $PID; type = $type; details = $details }
    [IO.File]::AppendAllText((Join-Path $masaRuntime 'supervisor-history.jsonl'), (($event | ConvertTo-Json -Depth 8 -Compress) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
}
function Write-MasaState($state, $reason) {
    $childId = $null
    if ($null -ne $masaChild -and -not $masaChild.HasExited) { $childId = $masaChild.Id }
    $value = @{ utc = [DateTime]::UtcNow.ToString('o'); supervisorPid = $PID; workerPid = $childId; state = $state; reason = $reason; restarts = $masaRestarts; nextStartUtc = $masaNextStart.ToString('o'); mode = 'paper'; automaticSleepPreventionRequested = $true; dataStatus = $masaDataStatus; newsDelivery = $masaNewsDelivery; stderrLog = $masaStderrPath; stdoutLog = $masaStdoutPath }
    if ($script:masaLastState -ne $state) { Write-MasaEvent 'STATE_CHANGED' $value; $script:masaLastState = $state }
    $value | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $masaRuntime 'supervisor.json') -Encoding UTF8
}
function Stop-MasaChild($reason) {
    if ($null -eq $masaChild -or $masaChild.HasExited) { return }
    @{ pid = $masaChild.Id; reason = $reason } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $masaRuntime 'stop-request.json') -Encoding UTF8
    if (-not $masaChild.WaitForExit(15000)) {
        # Only our own Process object is terminated; no broad node.exe kill.
        Write-MasaState 'FORCED_STOP' $reason
        $masaChild.Kill()
        $masaChild.WaitForExit()
    }
}
try {
    $deployment = Get-Content -LiteralPath (Join-Path $masaRoot 'deployment.json') -Raw | ConvertFrom-Json
    $configFile = Join-Path $masaRoot 'config.247.json'
    $entryFile = Join-Path $masaRoot 'dist\src\index.js'
    if (-not (Test-Path -LiteralPath $deployment.node)) { throw 'Configured node runtime missing' }
    # Recover monitoring of an existing worker if only its supervisor was lost.
    $masaExisting = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.ExecutablePath -eq $deployment.node -and $_.CommandLine -and $_.CommandLine.Contains($entryFile) -and $_.CommandLine.Contains($configFile)
    })
    if ($masaExisting.Count -gt 1) { throw 'Multiple matching workers; operator investigation required' }
    if ($masaExisting.Count -eq 1) {
        $masaChild = Get-Process -Id $masaExisting[0].ProcessId -ErrorAction Stop
        $null = $masaChild.Handle
        $masaLastFreshUtc = [DateTime]::UtcNow
        $oldStatus = Join-Path $masaRuntime 'supervisor.json'
        $old = Read-MasaJson $oldStatus
        if ($null -ne $old -and $old.workerPid -eq $masaChild.Id -and $old.stderrLog) { $masaStderrPath = $old.stderrLog; $masaStdoutPath = $old.stdoutLog }
        Write-MasaState 'ADOPTED' 'Recovered monitoring of existing paper worker'
    }
    do {
        if ([Masa2Power]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Windows sleep prevention request failed' }
        if (Test-Path -LiteralPath (Join-Path $masaRuntime 'disabled.flag')) {
            Stop-MasaChild 'DISABLED_BY_OPERATOR'; Write-MasaState 'DISABLED' 'Operator disabled'; break
        }
        $disk = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($masaRoot))
        if ($disk.AvailableFreeSpace -lt 2GB) {
            Stop-MasaChild 'LOW_DISK'; Write-MasaState 'HOLD' 'Less than 2GB free; no logs deleted'
            Start-Sleep -Seconds 30; continue
        }
        if ($null -ne $masaChild -and $masaChild.HasExited) {
            $masaChild.WaitForExit()
            $exitCode = $masaChild.ExitCode
            $masaRestarts++
            $wait = [Math]::Min(300, 30 * [Math]::Pow(2, [Math]::Min($masaRestarts - 1, 4)))
            $stderr = $masaStderrPath
            if ((Test-Path -LiteralPath $stderr) -and ((Get-Content -LiteralPath $stderr -Tail 10 | Out-String) -match 'RATE_LIMIT|\b418\b|\b429\b')) { $wait = 3600 }
            $masaNextStart = [DateTime]::UtcNow.AddSeconds($wait)
            Write-MasaEvent 'WORKER_EXITED' @{ workerPid = $masaChild.Id; exitCode = $exitCode; stderrLog = $stderr; restartWaitSeconds = $wait }
            $masaChild.Dispose(); $masaChild = $null
            Write-MasaState 'BACKOFF' "Worker exited: $exitCode"
        }
        if ($null -eq $masaChild -and [DateTime]::UtcNow -ge $masaNextStart) {
            $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
            if ($config.mode -ne 'paper' -or $config.headless -ne $true) { throw 'Background config must be headless paper mode' }
            $stopFile = Join-Path $masaRuntime 'stop-request.json'
            if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile }
            $runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + $PID + '-' + $masaRestarts
            $runDirectory = Join-Path $masaRuntime ('worker-runs\' + $runId)
            [IO.Directory]::CreateDirectory($runDirectory) | Out-Null
            $masaStdoutPath = Join-Path $runDirectory 'stdout.log'; $masaStderrPath = Join-Path $runDirectory 'stderr.log'
            $masaDataStatus = 'STARTING'; $masaNewsDelivery = 'UNVERIFIED'
            $masaChild = Start-Process -FilePath $deployment.node -ArgumentList @(('"' + $entryFile + '"'), '--config', ('"' + $configFile + '"')) -WorkingDirectory $masaRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $masaStdoutPath -RedirectStandardError $masaStderrPath
            $null = $masaChild.Handle
            $masaLastFreshUtc = [DateTime]::UtcNow
            Write-MasaEvent 'WORKER_STARTED' @{ workerPid = $masaChild.Id; stderrLog = $masaStderrPath; stdoutLog = $masaStdoutPath }
            Write-MasaState 'STARTING' 'Discovering public feeds'
        }
        if ($null -ne $masaChild -and -not $masaChild.HasExited) {
            $heartbeat = Join-Path $masaRuntime 'heartbeat.json'
            $age = ([DateTime]::UtcNow - $masaChild.StartTime.ToUniversalTime()).TotalSeconds
            $fresh = $false
            $beat = Read-MasaJson $heartbeat
            if ($null -ne $beat -and $beat.utc) {
                try {
                    $beatAge = ([DateTime]::UtcNow - ([DateTimeOffset]$beat.utc).UtcDateTime).TotalSeconds
                    $fresh = $beat.pid -eq $masaChild.Id -and $beatAge -ge 0 -and $beatAge -lt 90
                    if ($fresh) { $masaLastFreshUtc = [DateTime]::UtcNow; $masaDataStatus = $beat.operational; $masaNewsDelivery = $beat.newsDelivery }
                } catch { $fresh = $false }
            }
            $sinceFresh = ([DateTime]::UtcNow - $masaLastFreshUtc).TotalSeconds
            if ($age -gt 150 -and -not $fresh -and $sinceFresh -gt 150) { Stop-MasaChild 'HEARTBEAT_STALE' }
            else { Write-MasaState $(if (-not $fresh -and $sinceFresh -gt 30) { 'STARTING' } elseif ($masaDataStatus -eq 'DEGRADED') { 'DEGRADED' } else { 'RUNNING' }) 'Paper only; inspect dataStatus and newsDelivery' }
        }
        if (-not $Once) { Start-Sleep -Seconds 10 }
    } while (-not $Once)
} catch {
    Stop-MasaChild 'SUPERVISOR_ERROR'
    Write-MasaState 'ERROR' ([string]$_)
    throw
} finally {
    [Masa2Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null
    if ($masaOwned) { $masaMutex.ReleaseMutex() }
    $masaMutex.Dispose()
}
