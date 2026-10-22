# LiveKit Server in dev mode: TCP 7880 (HTTP/WS), TCP 7881 (RTC), UDP 7882 (RTC, single muxed port).
# Dev key/secret: devkey / secret (matches apps/agent/.env.example).
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig
Set-WindowTitle 'LiveKit :7880'

Assert-Path -Path $cfg.LiveKitExe -What 'livekit-server.exe'
$lkArgs = @('--dev', '--bind', '0.0.0.0')
if ($cfg.LiveKitNodeIp) { $lkArgs += @('--node-ip', $cfg.LiveKitNodeIp) }

Write-Host "Starting LiveKit Server: $($lkArgs -join ' ')" -ForegroundColor Cyan
& $cfg.LiveKitExe @lkArgs
Write-Host "livekit-server exited with code $LASTEXITCODE" -ForegroundColor Yellow
