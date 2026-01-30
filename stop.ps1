# Stop the Copilot web server
Set-Location $PSScriptRoot

# First, kill any process on port 3000
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $procIds = $conn.OwningProcess | Where-Object { $_ -ne 0 } | Select-Object -Unique
    foreach ($procId in $procIds) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] Killed process $procId on port 3000"
    }
}

# Also kill the wrapper process from pid file
if (Test-Path server.pid) {
    $pidValue = Get-Content server.pid
    if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
    Remove-Item server.pid
}

# Brief wait for port to be released
Start-Sleep -Milliseconds 500
