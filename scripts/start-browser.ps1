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
  [string]$LogFile = '',
  [int]$ReadyTimeoutSec = 25
)

$ErrorActionPreference = 'Continue'

$cacoHome = if ($env:CACO_HOME) { $env:CACO_HOME } else { Join-Path $env:USERPROFILE '.caco' }
$profileDir = Join-Path $cacoHome 'browser-profile'
$configFile = Join-Path $cacoHome 'browser-config.json'
$screenshotDir = Join-Path $cacoHome 'browser-screenshots'
$persistLog = Join-Path $cacoHome 'logs\browser-helper.log'
New-Item -ItemType Directory -Force -Path $cacoHome, $profileDir, (Join-Path $cacoHome 'logs') | Out-Null

# Each run starts a fresh persistent log so the last launch attempt is always
# inspectable (the per-call -LogFile is a temp file that may be cleaned up).
Set-Content -LiteralPath $persistLog -Value "[$(Get-Date -Format o)] start-browser mode=$Mode" -ErrorAction SilentlyContinue

function Write-Log($msg) {
  $line = "[$(Get-Date -Format HH:mm:ss.fff)] $msg"
  if ($LogFile) { Add-Content -LiteralPath $LogFile -Value $line -ErrorAction SilentlyContinue }
  Add-Content -LiteralPath $persistLog -Value $line -ErrorAction SilentlyContinue
  Write-Output $line
}

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

# Returns $true if a CDP endpoint answers /json/version on the given port.
# Uses a raw TcpClient + HTTP/1.1 request (NO Invoke-WebRequest): on corporate
# Windows, Invoke-WebRequest can stall on system-proxy auto-detection even for
# 127.0.0.1, and its -TimeoutSec does not reliably cap the connect phase.
function Test-Cdp($p) {
  $client = $null
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1500)) { return $false }
    $client.EndConnect($iar)
    $stream = $client.GetStream()
    $stream.ReadTimeout = 1500
    $req = "GET /json/version HTTP/1.1`r`nHost: 127.0.0.1:$p`r`nConnection: close`r`n`r`n"
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($req)
    $stream.Write($bytes, 0, $bytes.Length)
    $reader = [System.IO.StreamReader]::new($stream)
    $statusLine = $reader.ReadLine()
    return ($statusLine -match ' 200 ')
  } catch { return $false }
  finally { if ($client) { $client.Close() } }
}

# True if any live msedge.exe has our dedicated profile on its command line.
function Test-ProfileInUse {
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($profileDir)) }
    return (($procs | Measure-Object).Count -gt 0)
  } catch { return $false }
}

# Remove stale singleton/lock files left by a crashed debug Edge so a fresh launch
# does not try to hand off to a dead instance (a common cold-launch hang/absorption).
function Clear-StaleProfileLocks {
  if (Test-ProfileInUse) { return }  # never touch a profile a live Edge owns
  foreach ($name in @('SingletonLock','SingletonCookie','SingletonSocket','DevToolsActivePort')) {
    $f = Join-Path $profileDir $name
    if (Test-Path -LiteralPath $f) {
      Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
      Write-Log "Removed stale profile file: $name"
    }
  }
}

# Launch one Edge process (detached) and return the process object, or $null on failure.
function Start-DebugEdge($p) {
  $edgeArgs = @(
    "--remote-debugging-port=$p",
    "--user-data-dir=$profileDir",
    '--no-first-run',
    '--no-default-browser-check'
  )
  $windowStyle = 'Normal'
  switch ($Mode) {
    'hidden'   { $edgeArgs += '--start-minimized'; $windowStyle = 'Minimized' }
    'headless' { $edgeArgs += '--headless=new'; $edgeArgs += '--disable-gpu'; $windowStyle = 'Hidden' }
  }
  try {
    return Start-Process -FilePath $edge -ArgumentList $edgeArgs -WindowStyle $windowStyle -PassThru
  } catch {
    Write-Log "ERROR: Start-Process failed: $($_.Exception.Message)"
    return $null
  }
}

if ($Port -eq 0) {
  $Port = 9222
  # If CDP already answers on 9222, reuse it instead of spawning a duplicate Edge.
  if (Test-Cdp $Port) {
    Write-Log "Reusing existing CDP on port $Port"
  } else {
    while (-not (Test-PortFree $Port)) {
      $Port++
      if ($Port -gt 9300) { Write-Log "ERROR: No free port"; exit 4 }
    }
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

# Already serving CDP (reuse path) — nothing to launch.
if (Test-Cdp $Port) {
  Write-Log "CDP ready on port $Port (reused existing instance)"
  exit 0
}

# Authoritative launch: spawn Edge, then verify the CDP port actually comes up.
# On a box with Edge "startup boost" / many background brokers, a freshly spawned
# debug Edge can be absorbed by the running browser and exit before opening the port.
# Detect that (process exited early) and retry once.
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
$attempt = 0
$maxAttempts = 2
$proc = $null

while ((Get-Date) -lt $deadline) {
  if (-not $proc -or $proc.HasExited) {
    if ($attempt -ge $maxAttempts) {
      Write-Log "ERROR: Edge exited before CDP came up after $attempt attempt(s) (startup-boost absorption?)"
      exit 6
    }
    if ($proc -and $proc.HasExited) {
      Write-Log "Edge exited early (pid $($proc.Id), code $($proc.ExitCode)); cleaning locks and retrying"
      Clear-StaleProfileLocks
    } else {
      Clear-StaleProfileLocks
    }
    $attempt++
    $proc = Start-DebugEdge $Port
    if ($proc) { Write-Log "Launched Edge mode=$Mode port=$Port pid=$($proc.Id) attempt=$attempt" }
    else { Write-Log "ERROR: failed to start Edge (attempt $attempt)"; exit 3 }
  }
  if (Test-Cdp $Port) {
    Write-Log "CDP ready on port $Port (pid $($proc.Id))"
    exit 0
  }
  Start-Sleep -Milliseconds 250
}

Write-Log "ERROR: CDP never came up on port $Port within ${ReadyTimeoutSec}s (last pid $($proc.Id), exited=$($proc.HasExited))"
exit 7
