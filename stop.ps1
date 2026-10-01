# Stop the Caco server
Set-Location $PSScriptRoot

# Prevent agents from killing their own server
if ($env:CACO_SESSION) {
    Write-Host "ERROR: Don't run stop.ps1 from inside Caco - use the restart_server tool"
    exit 1
}

# The server's single-instance lock (src/server-lock.ts SERVER_LOCK_PATH).
$LockPath = Join-Path $env:USERPROFILE ".copilot\caco-server.lock"

if (Test-Path $LockPath) {
    try { $lock = Get-Content $LockPath -Raw | ConvertFrom-Json } catch { $lock = $null }
    $lockPid = if ($lock -and $lock.pid) { [int]$lock.pid } else { 0 }
    # Stop the lock's pid only if its command line shows the Caco server: after
    # a crash the pid may belong to an unrelated program, even another node one.
    $cmdLine = $null
    if ($lockPid) {
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $lockPid" -ErrorAction SilentlyContinue).CommandLine
    }
    if ($cmdLine -and $cmdLine -match 'server\.ts') {
        $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
        # /T also ends the server's own children (the Copilot CLI, terminals).
        & taskkill.exe /PID $lockPid /T /F 2>$null | Out-Null
        if ($proc -and -not $proc.WaitForExit(10000)) {
            Write-Host "[FAIL] Caco (pid $lockPid) did not stop; it still owns the session state"
            exit 1
        }
        # A forced kill skips the server's exit handler, so remove its lock here,
        # but only if it still names the stopped server: a replacement may own it.
        try { $after = Get-Content $LockPath -Raw -ErrorAction Stop | ConvertFrom-Json } catch { $after = $null }
        if ($after -and [int]$after.pid -eq $lockPid) { Remove-Item $LockPath -ErrorAction SilentlyContinue }
        Write-Host "[OK] Server stopped (pid $lockPid)"
    } elseif ($lockPid -and (Get-Process -Id $lockPid -ErrorAction SilentlyContinue) -and -not $cmdLine) {
        # Alive, but its command line can't be read (another user, or elevated).
        Write-Host "[FAIL] pid $lockPid holds the Caco lock but can't be identified; not stopping it."
        Write-Host "  If it is not Caco, delete the stale lock: $LockPath"
        exit 1
    } else {
        Write-Host "No server running (stale lock)"
    }
    Remove-Item server.pid, server.port -ErrorAction SilentlyContinue
    exit 0
}

# No lock: a server from before the lock existed, found by its port. Never
# reached once a lock-writing server has run.
# Read port from server.port file, fall back to env, then default
if (Test-Path server.port) {
    $Port = (Get-Content server.port).Trim()
} elseif ($env:CACO_PORT) {
    $Port = $env:CACO_PORT
} elseif ($env:PORT) {
    $Port = $env:PORT
} else {
    $Port = 53000
}

# Find and stop any process listening on the port
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $procIds = $conn.OwningProcess | Where-Object { $_ -ne 0 } | Select-Object -Unique
    foreach ($procId in $procIds) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    Write-Host "[OK] Server stopped (port $Port)"
} else {
    Write-Host "No server running on port $Port"
}

Remove-Item server.pid, server.port -ErrorAction SilentlyContinue

# Brief wait for port to be released
Start-Sleep -Milliseconds 500
exit 0
