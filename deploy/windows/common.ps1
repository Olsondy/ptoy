# Shared helpers for the ptoy Windows deploy scripts. Dot-source this file:
#   . "$PSScriptRoot\common.ps1"
# Targets Windows PowerShell 5.1 (and works in PowerShell 7). Keep this file ASCII-only.

$ErrorActionPreference = 'Stop'

$script:DeployDir = $PSScriptRoot
$script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:LogDir = Join-Path $PSScriptRoot 'logs'
$script:RunDir = Join-Path $PSScriptRoot '.run'

function Import-PtoyConfig {
    $configPath = Join-Path $script:DeployDir 'config.ps1'
    if (-not (Test-Path $configPath)) {
        throw "Missing $configPath. Copy config.example.ps1 to config.ps1 and edit the paths."
    }
    . $configPath
    if (-not $Ptoy) { throw "$configPath must define the `$Ptoy hashtable." }
    return $Ptoy
}

function Initialize-ProxyEnv {
    param([Parameter(Mandatory)] [hashtable] $Config)
    if ($Config.NoProxy) {
        $env:NO_PROXY = $Config.NoProxy
        $env:no_proxy = $Config.NoProxy
    }
    if ($Config.ClearProxyEnv) {
        foreach ($name in 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy') {
            Remove-Item "Env:$name" -ErrorAction SilentlyContinue
        }
    }
}

function Enable-CondaEnv {
    param(
        [Parameter(Mandatory)] [string] $CondaRoot,
        [Parameter(Mandatory)] [string] $EnvName
    )
    $hook = Join-Path $CondaRoot 'shell\condabin\conda-hook.ps1'
    if (-not (Test-Path $hook)) { throw "conda hook not found: $hook (check CondaRoot in config.ps1)" }
    . $hook
    conda activate $EnvName
    if ($env:CONDA_DEFAULT_ENV -ne $EnvName) { throw "conda activate $EnvName failed" }
}

function Assert-Path {
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [string] $What)
    if (-not (Test-Path $Path)) { throw "$What not found: $Path (check config.ps1)" }
}

function Set-WindowTitle {
    param([Parameter(Mandatory)] [string] $Title)
    try { $Host.UI.RawUI.WindowTitle = "ptoy - $Title" } catch { Write-Verbose 'cannot set window title' }
}

function Test-HttpOk {
    # True when GET $Url answers 2xx within $TimeoutSec. Never goes through a proxy.
    param([Parameter(Mandatory)] [string] $Url, [int] $TimeoutSec = 3)
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Proxy = $null
        $req.Timeout = $TimeoutSec * 1000
        $req.ReadWriteTimeout = $TimeoutSec * 1000
        $res = $req.GetResponse()
        $code = [int]$res.StatusCode
        $res.Close()
        return ($code -ge 200 -and $code -lt 300)
    } catch {
        return $false
    }
}

function Test-TcpListening {
    param([Parameter(Mandatory)] [int] $Port)
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
}

function Test-UdpBound {
    param([Parameter(Mandatory)] [int] $Port)
    $c = Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue
    return [bool]$c
}

function Wait-HttpReady {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Url,
        [int] $TimeoutSec = 120
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    Write-Host -NoNewline "  waiting for $Name ($Url) "
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpOk -Url $Url) {
            Write-Host ' ready' -ForegroundColor Green
            return $true
        }
        Write-Host -NoNewline '.'
        Start-Sleep -Seconds 2
    }
    Write-Host ' TIMEOUT' -ForegroundColor Red
    return $false
}

function Get-LlamaOffload {
    # Parses "offloaded X/Y layers to GPU" from the llama-server log. Returns $null when not found.
    $log = Join-Path $script:LogDir 'llama-server.log'
    if (-not (Test-Path $log)) { return $null }
    $m = Select-String -Path $log -Pattern 'offloaded (\d+)/(\d+) layers to GPU' | Select-Object -Last 1
    if (-not $m) { return $null }
    return [pscustomobject]@{
        Offloaded = [int]$m.Matches[0].Groups[1].Value
        Total     = [int]$m.Matches[0].Groups[2].Value
        Line      = $m.Line.Trim()
    }
}

function Start-ServiceWindow {
    # Opens a new PowerShell window running deploy\windows\<Script> and records its PID
    # in deploy\windows\.run\<Name>.pid so stop-all.ps1 can close it.
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Script
    )
    $path = Join-Path $script:DeployDir $Script
    $argList = "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$path`""
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WorkingDirectory $script:RepoRoot -PassThru
    New-Item -ItemType Directory -Force -Path $script:RunDir | Out-Null
    Set-Content -Path (Join-Path $script:RunDir "$Name.pid") -Value $p.Id -Encoding ascii
    return $p
}
