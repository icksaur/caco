# Start the Caco server in background and wait until it is ready
Set-Location $PSScriptRoot

# Prevent agents from killing their own server
if ($env:CACO_SESSION) {
    Write-Host "ERROR: Don't run start.ps1 from inside Caco - use the restart_server tool"
    exit 1
}

# Port configuration: CACO_PORT -> PORT -> 53000. The server may bind one of
# the next ports if this one is unavailable; the lock records the port it used.
if ($env:CACO_PORT) { $Port = $env:CACO_PORT }
elseif ($env:PORT) { $Port = $env:PORT }
else { $Port = 53000 }
$env:PORT = $Port
# Host configuration: CACO_HOST -> 127.0.0.1 (localhost only)
if (-not $env:CACO_HOST) { $env:CACO_HOST = '127.0.0.1' }

# The server's single-instance lock (src/server-lock.ts SERVER_LOCK_PATH). It
# names the running server's pid and, once ready, the URL it is serving.
$LockPath = Join-Path $env:USERPROFILE ".copilot\caco-server.lock"

# Windows Defender scans every node_modules file on a cold start, which can
# take well past 10 s. CACO_START_TIMEOUT_SEC raises the wait further if needed.
$StartTimeoutSec = 30
if ($env:CACO_START_TIMEOUT_SEC -match '^\d+$' -and [int]$env:CACO_START_TIMEOUT_SEC -gt 0) {
    $StartTimeoutSec = [int]$env:CACO_START_TIMEOUT_SEC
}

Write-Host "Starting Caco (requested http://$($env:CACO_HOST):$Port); log: server.log"
Write-Host "  A first start after install or reboot can take a while (Defender scans node_modules)."

# Stop any existing server first. If it won't stop, launching another would put
# two servers on one session state. LASTEXITCODE is global and may hold a stale
# value from an earlier command, so reset it and read it explicitly.
$global:LASTEXITCODE = 0
& .\stop.ps1 2>$null
if ($global:LASTEXITCODE) {
    Write-Host "[FAIL] Could not stop the running Caco; not starting another"
    exit 1
}

# Preserve the previous run's log before it gets overwritten below.
# Crashes often leave their stack trace in server.log; overwriting it
# on restart destroys post-mortem evidence. Archive into logs/ with a
# timestamp. Keep the most recent 20 archives.
if (Test-Path "server.log") {
    $logDir = Join-Path $PSScriptRoot "logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Move-Item -LiteralPath "server.log" -Destination (Join-Path $logDir "server-$stamp.log") -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $logDir -Filter "server-*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

$launchedAt = [DateTime]::UtcNow
# Start via cmd.exe (needed for npx batch file). cmd.exe lives as long as node,
# so its exit is the server's exit.
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npx tsx server.ts > server.log 2>&1" `
    -WindowStyle Hidden -PassThru
# Cache the handle now, or ExitCode can read as empty after the process exits.
$null = $proc.Handle

# Echo server.log lines not shown yet, so startup progress appears live. The
# ready line is left out: this script prints the final URL itself.
$script:seen = 0
function Show-NewLog {
    if (-not (Test-Path "server.log")) { return }
    $lines = @(Get-Content "server.log" -ErrorAction SilentlyContinue)
    if ($lines.Count -gt $script:seen) {
        $lines[$script:seen..($lines.Count - 1)] |
            Where-Object { $_ -notmatch '^(npm notice|Caco ready:)' } |
            ForEach-Object { Write-Host "  $_" }
        $script:seen = $lines.Count
    }
}

# The lock's URL once a server launched by this run reports ready, else $null.
function Get-ReadyUrl {
    if (-not (Test-Path $LockPath)) { return $null }
    try { $lock = Get-Content $LockPath -Raw | ConvertFrom-Json } catch { return $null }
    if ($lock.state -ne 'ready' -or -not $lock.url) { return $null }
    # PowerShell 7 parses the timestamp to a DateTime; 5.1 leaves a string.
    $started = ([DateTime]$lock.startedAt).ToUniversalTime()
    if ($started -lt $launchedAt.AddSeconds(-1)) { return $null }
    return $lock.url
}

$url = $null
for ($i = 0; $i -lt $StartTimeoutSec; $i++) {
    Start-Sleep -Seconds 1
    Show-NewLog
    $url = Get-ReadyUrl
    if ($url) { break }
    if ($proc.HasExited) { break }
}

if ($url) {
    Write-Host "[OK] Caco ready: $url"
    exit 0
}

if ($proc.HasExited) {
    Show-NewLog
    $code = $proc.ExitCode
    Write-Host "[FAIL] Caco exited during startup (exit code $code); see server.log"
    if (-not $code) { $code = 1 }
    exit $code
}

# Not ready in time: stop what was launched so it can't become ready later,
# behind a failure the user has already been told about.
& taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null
Show-NewLog
Write-Host "[FAIL] Caco was not ready after ${StartTimeoutSec}s and was stopped (set CACO_START_TIMEOUT_SEC to wait longer); see server.log"
exit 1
