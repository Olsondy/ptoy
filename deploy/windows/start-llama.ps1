# llama-server (llama.cpp) on :8080, single-model mode, all layers on GPU.
# Flags mirror docs/architecture/server.md section 5; do not change them here without updating that doc.
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig
Set-WindowTitle "llama-server :$($cfg.LlamaPort)"
Initialize-ProxyEnv -Config $cfg

Assert-Path -Path $cfg.LlamaServerExe -What 'llama-server.exe'
Assert-Path -Path $cfg.LlamaModel -What 'GGUF model'

if (-not (Test-HttpOk -Url "http://127.0.0.1:$($cfg.IndexTtsPort)/")) {
    Write-Host "WARNING: IndexTTS is not up on :$($cfg.IndexTtsPort). Start it first so VRAM is reserved in the right order." -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null
$logFile = Join-Path $script:LogDir 'llama-server.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$llamaArgs = @(
    '-m', $cfg.LlamaModel, '--alias', 'qwen3-8b', '--host', '0.0.0.0', '--port', "$($cfg.LlamaPort)",
    '-ngl', '99', '--fit', 'off', '-c', '8192', '-np', '1', '-fa', 'on',
    '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0',
    '-b', '512', '-ub', '512', '-t', '8', '--cache-ram', '512',
    '--jinja', '--reasoning', 'off', '--reasoning-budget', '0',
    '--log-file', $logFile
)
Write-Host "Starting llama-server (log: $logFile)" -ForegroundColor Cyan
Write-Host "Look for: offloaded $($cfg.LlamaExpectedLayers)/$($cfg.LlamaExpectedLayers) layers to GPU" -ForegroundColor Cyan
& $cfg.LlamaServerExe @llamaArgs
Write-Host "llama-server exited with code $LASTEXITCODE" -ForegroundColor Yellow
