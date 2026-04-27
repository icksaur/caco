# Stop the Caco server
Set-Location $PSScriptRoot

# Prevent agents from killing their own server
if ($env:CACO_SESSION) {
    Write-Host "ERROR: Don't run stop.ps1 from inside Caco - use the restart_server tool"
    exit 1
}

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
