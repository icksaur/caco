# start-browser.ps1 — Launch Microsoft Edge for Caco automation on Windows.
#
# Spawns Edge fully detached via Start-Process; this PowerShell exits immediately.
# Writes the chosen port to %CACO_HOME%\browser-config.json (default ~\.caco).
#
# Usage:
#   .\start-browser.ps1 [-Mode visible|hidden|headless] [-Port N] [-LogFile PATH]

param(
  [ValidateSet('visible','hidden','headless')] [string]$Mode = 'visible',
  [int]$Port = 0,
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Continue'

function Write-Log($msg) {
  if ($LogFile) { Add-Content -LiteralPath $LogFile -Value $msg -ErrorAction SilentlyContinue }
  Write-Output $msg
}

$cacoHome = if ($env:CACO_HOME) { $env:CACO_HOME } else { Join-Path $env:USERPROFILE '.caco' }
$profileDir = Join-Path $cacoHome 'browser-profile'
$configFile = Join-Path $cacoHome 'browser-config.json'
$screenshotDir = Join-Path $cacoHome 'browser-screenshots'
New-Item -ItemType Directory -Force -Path $cacoHome, $profileDir | Out-Null

$edgeCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
  "${env:LocalAppData}\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) {
  Write-Log "ERROR: Microsoft Edge not found in default install locations."
  exit 3
}
Write-Log "Using browser: $edge"

function Test-PortFree($p) {
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch { return $false }
}

if ($Port -eq 0) {
  $Port = 9222
  while (-not (Test-PortFree $Port)) {
    $Port++
    if ($Port -gt 9300) { Write-Log "ERROR: No free port"; exit 4 }
  }
}
Write-Log "Using port: $Port"

$config = @{
  cdpUrl = "http://127.0.0.1:$Port"
  defaultTimeoutMs = 10000
  launchTimeoutMs = 30000
  evalEnabled = $false
  evalOriginAllowlist = @()
  authOriginAllowlist = @('login.microsoftonline.com','login.live.com','accounts.google.com')
  profileDir = $profileDir
  screenshotDir = $screenshotDir
  lastLaunchedMode = $Mode
}
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configFile -Encoding utf8NoBOM

$edgeArgs = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$profileDir",
  '--no-first-run',
  '--no-default-browser-check'
)
$windowStyle = 'Normal'
switch ($Mode) {
  'hidden'   { $edgeArgs += '--start-minimized'; $windowStyle = 'Minimized' }
  'headless' { $edgeArgs += '--headless=new'; $edgeArgs += '--disable-gpu'; $windowStyle = 'Hidden' }
}

Start-Process -FilePath $edge -ArgumentList $edgeArgs -WindowStyle $windowStyle | Out-Null
Write-Log "Launched Edge mode=$Mode port=$Port"
exit 0
