# Prints a status table for every ptoy service. Exit code 0 when all required services are up.
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig

if ($cfg.WebMode -eq 'dev') { $webPort = $cfg.WebDevPort } else { $webPort = $cfg.WebPreviewPort }

$rows = @()
function Add-Row([string] $Name, [string] $Endpoint, [bool] $Ok, [string] $Detail, [bool] $Required = $true) {
    $script:rows += [pscustomobject]@{ Name = $Name; Endpoint = $Endpoint; Ok = $Ok; Detail = $Detail; Required = $Required }
}

$u = "http://127.0.0.1:$($cfg.IndexTtsPort)/"
Add-Row 'IndexTTS (Gradio)' $u (Test-HttpOk -Url $u) 'WebUI page'

$u = "http://127.0.0.1:$($cfg.LlamaPort)/health"
$llamaOk = Test-HttpOk -Url $u
$off = Get-LlamaOffload
if ($off) {
    $detail = "offloaded $($off.Offloaded)/$($off.Total) layers"
    if ($off.Offloaded -ne $off.Total -or $off.Total -ne $cfg.LlamaExpectedLayers) {
        $llamaOk = $false
        $detail += " (expected $($cfg.LlamaExpectedLayers)/$($cfg.LlamaExpectedLayers))"
    }
} else {
    $detail = 'offload line not found in logs\llama-server.log'
}
Add-Row 'llama-server' $u $llamaOk $detail

$u = "http://127.0.0.1:$($cfg.AsrPort)/health"
Add-Row 'ASR (SenseVoice)' $u (Test-HttpOk -Url $u) '/health'

$u = 'http://127.0.0.1:7880/'
Add-Row 'LiveKit HTTP/WS' $u (Test-HttpOk -Url $u) 'answers OK'
Add-Row 'LiveKit RTC TCP' ':7881' (Test-TcpListening -Port 7881) 'listening'
Add-Row 'LiveKit RTC UDP' ':7882' (Test-UdpBound -Port 7882) 'bound'

$u = "http://127.0.0.1:$($cfg.TokenPort)/healthz"
Add-Row 'Token server' $u (Test-HttpOk -Url $u) '/healthz'

$u = "http://127.0.0.1:$($cfg.AgentHealthPort)/"
Add-Row 'Agent worker' $u (Test-HttpOk -Url $u) 'connected to LiveKit'

$u = "http://127.0.0.1:$webPort/"
Add-Row "Web ($($cfg.WebMode))" $u (Test-HttpOk -Url $u) "LAN: http://$($cfg.LanIp):$webPort"

if ($cfg.EnableHttps) {
    Add-Row 'Caddy HTTPS web' ":$($cfg.HttpsWebPort)" (Test-TcpListening -Port $cfg.HttpsWebPort) "https://$($cfg.LanIp):$($cfg.HttpsWebPort)"
    Add-Row 'Caddy HTTPS LiveKit' ":$($cfg.HttpsLiveKitPort)" (Test-TcpListening -Port $cfg.HttpsLiveKitPort) "wss://$($cfg.LanIp):$($cfg.HttpsLiveKitPort)"
}

# GPU memory (informational)
$gpu = $null
try {
    $gpu = (& nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
} catch { $gpu = $null }
if ($gpu) {
    $parts = $gpu -split ','
    Add-Row 'GPU memory' 'nvidia-smi' $true ("{0} / {1} MiB used" -f $parts[0].Trim(), $parts[1].Trim()) $false
} else {
    Add-Row 'GPU memory' 'nvidia-smi' $false 'nvidia-smi not available' $false
}

Write-Host ''
Write-Host ('{0,-20} {1,-6} {2,-40} {3}' -f 'SERVICE', 'STATUS', 'ENDPOINT', 'DETAIL')
Write-Host ('{0,-20} {1,-6} {2,-40} {3}' -f '-------', '------', '--------', '------')
foreach ($r in $rows) {
    if ($r.Ok) { $status = 'OK'; $color = 'Green' } else { $status = 'DOWN'; $color = 'Red' }
    if (-not $r.Required -and -not $r.Ok) { $status = 'N/A'; $color = 'Yellow' }
    Write-Host ('{0,-20} ' -f $r.Name) -NoNewline
    Write-Host ('{0,-6} ' -f $status) -ForegroundColor $color -NoNewline
    Write-Host ('{0,-40} {1}' -f $r.Endpoint, $r.Detail)
}
Write-Host ''

$down = @($rows | Where-Object { $_.Required -and -not $_.Ok })
if ($down.Count -gt 0) {
    Write-Host "$($down.Count) service(s) down." -ForegroundColor Red
    exit 1
}
Write-Host 'All services up.' -ForegroundColor Green
exit 0
