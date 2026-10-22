# Token server (apps/agent src/token-server.ts) on :8787. Reads apps/agent/.env.
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig
Set-WindowTitle "token server :$($cfg.TokenPort)"
Initialize-ProxyEnv -Config $cfg

Set-Location (Join-Path $script:RepoRoot 'apps\agent')
if (-not (Test-Path '.env')) { throw 'apps\agent\.env is missing. See docs/runbook/windows.md section 2.' }
$env:NODE_ENV = 'production'

Write-Host 'Starting token server (pnpm run start:token)' -ForegroundColor Cyan
pnpm run start:token
Write-Host "token server exited with code $LASTEXITCODE" -ForegroundColor Yellow
