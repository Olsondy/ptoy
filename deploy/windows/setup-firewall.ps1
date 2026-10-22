# Adds inbound firewall rules for ptoy (run once, as Administrator). Idempotent.
# Rules are limited to the local subnet and apply to all network profiles.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$rules = @(
    @{ Name = 'ptoy LiveKit HTTP/WS 7880'; Protocol = 'TCP'; Port = 7880 },
    @{ Name = 'ptoy LiveKit RTC TCP 7881'; Protocol = 'TCP'; Port = 7881 },
    @{ Name = 'ptoy LiveKit RTC UDP 7882'; Protocol = 'UDP'; Port = 7882 },
    @{ Name = 'ptoy web preview 4173'; Protocol = 'TCP'; Port = 4173 },
    @{ Name = 'ptoy web dev 5173'; Protocol = 'TCP'; Port = 5173 },
    @{ Name = 'ptoy HTTPS web 5443'; Protocol = 'TCP'; Port = 5443 },
    @{ Name = 'ptoy HTTPS LiveKit 7443'; Protocol = 'TCP'; Port = 7443 },
    @{ Name = 'ptoy IndexTTS 7860'; Protocol = 'TCP'; Port = 7860 },
    @{ Name = 'ptoy llama-server 8080'; Protocol = 'TCP'; Port = 8080 },
    @{ Name = 'ptoy ASR 8100'; Protocol = 'TCP'; Port = 8100 },
    @{ Name = 'ptoy token server 8787'; Protocol = 'TCP'; Port = 8787 }
)
foreach ($r in $rules) {
    if (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue) {
        Write-Host "exists: $($r.Name)" -ForegroundColor DarkGray
        continue
    }
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow -Protocol $r.Protocol `
        -LocalPort $r.Port -RemoteAddress LocalSubnet -Profile Any | Out-Null
    Write-Host "added:  $($r.Name)" -ForegroundColor Green
}
