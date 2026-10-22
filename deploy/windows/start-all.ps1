# Starts every ptoy service in its own window, in the required order, waiting for each to be ready:
#   IndexTTS -> llama-server -> ASR -> LiveKit -> token server -> agent -> web (-> caddy if EnableHttps)
# Services already listening on their port are skipped.
# Usage:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\start-all.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\start-all.ps1 -Skip indextts,llama
param(
    [ValidateSet('indextts', 'llama', 'asr', 'livekit', 'token', 'agent', 'web', 'caddy')]
    [string[]] $Skip = @()
)
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig

if ($cfg.WebMode -eq 'dev') { $webPort = $cfg.WebDevPort } else { $webPort = $cfg.WebPreviewPort }

# Name, script, port that proves "already running", readiness URL, timeout (s)
$steps = @(
    @{ Name = 'indextts'; Script = 'start-indextts.ps1'; Port = $cfg.IndexTtsPort; Url = "http://127.0.0.1:$($cfg.IndexTtsPort)/"; Timeout = $cfg.IndexTtsTimeoutSec },
    @{ Name = 'llama'; Script = 'start-llama.ps1'; Port = $cfg.LlamaPort; Url = "http://127.0.0.1:$($cfg.LlamaPort)/health"; Timeout = $cfg.LlamaTimeoutSec },
    @{ Name = 'asr'; Script = 'start-asr.ps1'; Port = $cfg.AsrPort; Url = "http://127.0.0.1:$($cfg.AsrPort)/health"; Timeout = $cfg.AsrTimeoutSec },
    @{ Name = 'livekit'; Script = 'start-livekit.ps1'; Port = 7880; Url = 'http://127.0.0.1:7880/'; Timeout = 60 },
    @{ Name = 'token'; Script = 'start-token.ps1'; Port = $cfg.TokenPort; Url = "http://127.0.0.1:$($cfg.TokenPort)/healthz"; Timeout = 60 },
    @{ Name = 'agent'; Script = 'start-agent.ps1'; Port = $cfg.AgentHealthPort; Url = "http://127.0.0.1:$($cfg.AgentHealthPort)/"; Timeout = 90 },
    @{ Name = 'web'; Script = 'start-web.ps1'; Port = $webPort; Url = "http://127.0.0.1:$webPort/"; Timeout = 300 }
)
if ($cfg.EnableHttps) {
    $steps += @{ Name = 'caddy'; Script = 'start-caddy.ps1'; Port = $cfg.HttpsWebPort; Url = $null; Timeout = 30 }
}

foreach ($s in $steps) {
    if ($Skip -contains $s.Name) {
        Write-Host "[skip] $($s.Name)" -ForegroundColor DarkGray
        continue
    }
    if (Test-TcpListening -Port $s.Port) {
        Write-Host "[up]   $($s.Name) already listening on :$($s.Port), not starting another" -ForegroundColor Green
        continue
    }
    Write-Host "[start] $($s.Name) ($($s.Script))" -ForegroundColor Cyan
    Start-ServiceWindow -Name $s.Name -Script $s.Script | Out-Null

    if ($s.Url) {
        $ok = Wait-HttpReady -Name $s.Name -Url $s.Url -TimeoutSec $s.Timeout
    } else {
        $deadline = (Get-Date).AddSeconds($s.Timeout)
        while (-not (Test-TcpListening -Port $s.Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
        $ok = Test-TcpListening -Port $s.Port
    }
    if (-not $ok) {
        Write-Host "$($s.Name) did not become ready. Check its window, fix, then re-run start-all.ps1 (running services are skipped)." -ForegroundColor Red
        exit 1
    }

    if ($s.Name -eq 'llama') {
        $off = Get-LlamaOffload
        if (-not $off) {
            Write-Host '  could not find "offloaded X/Y layers to GPU" in logs\llama-server.log' -ForegroundColor Yellow
        } elseif ($off.Offloaded -ne $off.Total -or $off.Total -ne $cfg.LlamaExpectedLayers) {
            Write-Host "  PARTIAL GPU OFFLOAD: $($off.Line)" -ForegroundColor Red
            Write-Host '  Stop llama-server, free VRAM (see runbook troubleshooting) and start again.' -ForegroundColor Red
            exit 1
        } else {
            Write-Host "  $($off.Line)" -ForegroundColor Green
        }
    }
}

Write-Host ''
& (Join-Path $PSScriptRoot 'check.ps1')
