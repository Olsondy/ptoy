# Web app (apps/web). WebMode 'preview' serves the production build on :4173 (builds it if missing);
# 'dev' runs the Vite dev server on :5173. Both proxy /api to the token server.
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig
Initialize-ProxyEnv -Config $cfg

Set-Location (Join-Path $script:RepoRoot 'apps\web')
if ($cfg.WebMode -eq 'dev') {
    Set-WindowTitle "web dev :$($cfg.WebDevPort)"
    $env:WEB_PORT = "$($cfg.WebDevPort)"
    Write-Host 'Starting Vite dev server' -ForegroundColor Cyan
    pnpm exec vite --host 0.0.0.0 --port $cfg.WebDevPort --strictPort
} else {
    Set-WindowTitle "web preview :$($cfg.WebPreviewPort)"
    if (-not (Test-Path 'dist\index.html')) {
        Write-Host 'dist\ not found, building (pnpm run build)' -ForegroundColor Cyan
        pnpm run build
        if ($LASTEXITCODE -ne 0) { throw 'web build failed' }
    }
    Write-Host 'Starting vite preview (production build)' -ForegroundColor Cyan
    pnpm exec vite preview --host 0.0.0.0 --port $cfg.WebPreviewPort --strictPort
}
Write-Host "web exited with code $LASTEXITCODE" -ForegroundColor Yellow
