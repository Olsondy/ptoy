# Pulls the latest main, reinstalls JS deps and rebuilds the web app. Restart services afterwards:
#   stop-all.ps1 ; start-all.ps1
. "$PSScriptRoot\common.ps1"
Set-Location $script:RepoRoot

git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'git pull failed (local changes or diverged branch?)' }
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
pnpm --filter @ptoy/web run build
if ($LASTEXITCODE -ne 0) { throw 'web build failed' }
Write-Host 'Updated. If services/asr/requirements.txt changed, also run pip install -r requirements.txt in the ptoy-asr env.' -ForegroundColor Green
Write-Host 'Now restart: stop-all.ps1 then start-all.ps1' -ForegroundColor Green
