# Stops ptoy services: closes the windows opened by start-all.ps1 (process tree), then kills
# anything still listening on the service ports. Stops in reverse start order so llama-server
# releases VRAM before IndexTTS.
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig

$order = @('caddy', 'web', 'agent', 'token', 'livekit', 'asr', 'llama', 'indextts')
$ports = @{
    caddy    = @($cfg.HttpsWebPort, $cfg.HttpsLiveKitPort)
    web      = @($cfg.WebPreviewPort, $cfg.WebDevPort)
    agent    = @($cfg.AgentHealthPort)
    token    = @($cfg.TokenPort)
    livekit  = @(7880, 7881)
    asr      = @($cfg.AsrPort)
    llama    = @($cfg.LlamaPort)
    indextts = @($cfg.IndexTtsPort)
}

foreach ($name in $order) {
    $pidFile = Join-Path $script:RunDir "$name.pid"
    if (Test-Path $pidFile) {
        $windowPid = (Get-Content $pidFile -Raw).Trim()
        if (Get-Process -Id $windowPid -ErrorAction SilentlyContinue) {
            Write-Host "[stop] $name window (pid $windowPid, with children)" -ForegroundColor Cyan
            & taskkill.exe /PID $windowPid /T /F | Out-Null
        }
        Remove-Item $pidFile -ErrorAction SilentlyContinue
    }
    foreach ($port in $ports[$name]) {
        $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($owner in $owners) {
            if ($owner -gt 4) {
                $pname = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
                Write-Host "[stop] $name : $pname (pid $owner) on :$port" -ForegroundColor Cyan
                & taskkill.exe /PID $owner /T /F | Out-Null
            }
        }
    }
}
Write-Host 'Done. Run check.ps1 to confirm everything is DOWN.' -ForegroundColor Green
