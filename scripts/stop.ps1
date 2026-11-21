$ErrorActionPreference = 'Stop'
$masaRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$masaRuntime = Join-Path $masaRoot 'runtime'
[IO.Directory]::CreateDirectory($masaRuntime) | Out-Null
'Stopped by operator' | Set-Content -LiteralPath (Join-Path $masaRuntime 'disabled.flag') -Encoding UTF8
$file = Join-Path $masaRuntime 'heartbeat.json'
if (Test-Path -LiteralPath $file) {
    $beat = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    @{ pid = $beat.pid; reason = 'OPERATOR_STOP' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $masaRuntime 'stop-request.json') -Encoding UTF8
}
Write-Output 'Stop requested. Watchdog stays disabled until start.ps1 is run. Allow up to 25 seconds for graceful shutdown.'
