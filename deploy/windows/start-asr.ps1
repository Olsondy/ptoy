# ASR service (SenseVoice-Small on CPU) on :8100. See services/asr/README.md.
. "$PSScriptRoot\common.ps1"
$cfg = Import-PtoyConfig
Set-WindowTitle "ASR :$($cfg.AsrPort)"
Initialize-ProxyEnv -Config $cfg

Enable-CondaEnv -CondaRoot $cfg.CondaRoot -EnvName $cfg.AsrEnv
Set-Location (Join-Path $script:RepoRoot 'services\asr')
$env:ASR_HOST = '0.0.0.0'
$env:ASR_PORT = "$($cfg.AsrPort)"
if ($cfg.AsrModel) { $env:ASR_MODEL = $cfg.AsrModel }

Write-Host 'Starting ASR service (ready when "model ready" + "Uvicorn running" appear)' -ForegroundColor Cyan
python -m asr_service
Write-Host "ASR exited with code $LASTEXITCODE" -ForegroundColor Yellow
