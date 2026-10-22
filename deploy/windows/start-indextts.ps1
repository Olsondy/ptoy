# IndexTTS2 Gradio WebUI on :7860 (GPU). Start this BEFORE llama-server.
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig
Set-WindowTitle "IndexTTS :$($cfg.IndexTtsPort)"
Initialize-ProxyEnv -Config $cfg

Assert-Path -Path $cfg.IndexTtsDir -What 'IndexTTS directory'
Enable-CondaEnv -CondaRoot $cfg.CondaRoot -EnvName $cfg.IndexTtsEnv
Set-Location $cfg.IndexTtsDir

Write-Host "Starting IndexTTS: $($cfg.IndexTtsCommand) $($cfg.IndexTtsArgs -join ' ')" -ForegroundColor Cyan
$indexArgs = $cfg.IndexTtsArgs
& $cfg.IndexTtsCommand @indexArgs
Write-Host "IndexTTS exited with code $LASTEXITCODE" -ForegroundColor Yellow
