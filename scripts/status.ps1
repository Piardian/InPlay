$ErrorActionPreference = 'Stop'
$masaRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
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
$beat = Read-MasaJson (Join-Path $masaRoot 'runtime\heartbeat.json')
$supervisor = Read-MasaJson (Join-Path $masaRoot 'runtime\supervisor.json')
if ($null -eq $beat) { throw 'Unable to read runtime\heartbeat.json' }
if ($null -eq $supervisor) { throw 'Unable to read runtime\supervisor.json' }
$age = ([DateTime]::UtcNow - ([DateTimeOffset]$beat.utc).UtcDateTime).TotalSeconds
$worker = Get-Process -Id $beat.pid -ErrorAction SilentlyContinue
$fresh = $null -ne $worker -and $beat.state -eq 'RUNNING' -and $age -ge 0 -and $age -lt 20
[pscustomobject]@{
    checkedUtc = [DateTime]::UtcNow.ToString('o'); workerAliveAndFresh = $fresh; workerPid = $beat.pid
    heartbeatAgeSeconds = [Math]::Round($age, 1); mode = $beat.mode; supervisorState = $supervisor.state
    dataStatus = $(if ($fresh) { $beat.operational } else { 'STALE_OR_STOPPED' })
    newsDelivery = $beat.newsDelivery; connectedCatalystFeeds = $beat.feeds.connected; expectedCatalystFeeds = $beat.feeds.expected
    treeTransport = $beat.feeds.feeds.tree; treeDecoder = $beat.feeds.tree
    open = $beat.open; closed = $beat.closed; realized = $beat.realized
    stderrLog = $supervisor.stderrLog; journal = $beat.journal
} | ConvertTo-Json -Depth 6
