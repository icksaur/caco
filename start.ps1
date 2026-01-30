# Start the Copilot web server in background
Set-Location $PSScriptRoot

# Port configuration: CACO_PORT → PORT → 3000
if ($env:CACO_PORT) { $Port = $env:CACO_PORT }
elseif ($env:PORT) { $Port = $env:PORT }
else { $Port = 3000 }
$env:PORT = $Port

& .\stop.ps1 2>$null

# Start via cmd.exe (needed for npx batch file)
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npx tsx server.ts > server.log 2>&1" `
    -WindowStyle Hidden

# Wait for node to start listening, then capture its PID by port
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { break }
}

if ($conn) {
    $nodePid = $conn.OwningProcess | Where-Object { $_ -ne 0 } | Select-Object -First 1
    $nodePid | Out-File "server.pid"
    Write-Host "[OK] Server started (PID: $nodePid)"
    Write-Host "  URL: http://localhost:$Port"
} else {
    Write-Host "[FAIL] Server failed to start"
    if (Test-Path server.log) { Get-Content server.log }
    exit 1
}
