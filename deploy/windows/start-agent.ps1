# Voice agent worker (apps/agent src/agent.ts) in production mode (`start`).
# Health endpoint: http://127.0.0.1:8081/ answers OK once connected to LiveKit. Reads apps/agent/.env.
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig
Set-WindowTitle 'agent worker'
Initialize-ProxyEnv -Config $cfg

Set-Location (Join-Path $script:RepoRoot 'apps\agent')
if (-not (Test-Path '.env')) { throw 'apps\agent\.env is missing. See docs/runbook/windows.md section 2.' }
$env:NODE_ENV = 'production'

Write-Host 'Starting agent worker (pnpm run start)' -ForegroundColor Cyan
pnpm run start
Write-Host "agent exited with code $LASTEXITCODE" -ForegroundColor Yellow
