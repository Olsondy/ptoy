# Optional HTTPS front door for phones / other LAN devices (Caddy, local CA):
#   https://<LanIp>:5443  -> web (vite preview :4173 or dev :5173)
#   https://<LanIp>:7443  -> LiveKit signaling ws://127.0.0.1:7880 (as wss)
# Media (UDP 7882) does not go through Caddy.
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig
Set-WindowTitle "caddy https :$($cfg.HttpsWebPort) :$($cfg.HttpsLiveKitPort)"

Assert-Path -Path $cfg.CaddyExe -What 'caddy.exe'
$env:PTOY_LAN_IP = $cfg.LanIp
$env:PTOY_HTTPS_WEB_PORT = "$($cfg.HttpsWebPort)"
$env:PTOY_HTTPS_LIVEKIT_PORT = "$($cfg.HttpsLiveKitPort)"
if ($cfg.WebMode -eq 'dev') { $env:PTOY_WEB_PORT = "$($cfg.WebDevPort)" } else { $env:PTOY_WEB_PORT = "$($cfg.WebPreviewPort)" }

$caddyfile = Join-Path $PSScriptRoot 'Caddyfile'
Write-Host "Starting Caddy with $caddyfile" -ForegroundColor Cyan
Write-Host "Root CA for phones: $env:APPDATA\Caddy\pki\authorities\local\root.crt" -ForegroundColor Cyan
& $cfg.CaddyExe run --config $caddyfile --adapter caddyfile
Write-Host "caddy exited with code $LASTEXITCODE" -ForegroundColor Yellow
