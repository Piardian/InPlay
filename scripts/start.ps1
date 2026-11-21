$ErrorActionPreference = 'Stop'
$masaRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$disabled = Join-Path $masaRoot 'runtime\disabled.flag'
if (Test-Path -LiteralPath $disabled) { Remove-Item -LiteralPath $disabled }
$task = Get-ScheduledTask -TaskName 'Masa2-InPlay-Paper-247' -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Start-ScheduledTask -TaskName 'Masa2-InPlay-Paper-247'
} else {
    $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Start-Process -FilePath $exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + (Join-Path $PSScriptRoot 'supervisor.ps1') + '"')) -WorkingDirectory $masaRoot -WindowStyle Hidden
}
Write-Output 'Background paper supervisor launched; see runtime\heartbeat.json.'
