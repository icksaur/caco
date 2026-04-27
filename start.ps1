# Start the Caco server in background
Set-Location $PSScriptRoot

# Prevent agents from killing their own server
if ($env:CACO_SESSION) {
    Write-Host "ERROR: Don't run start.ps1 from inside Caco - use the restart_server tool"
    exit 1
}

# Port configuration: CACO_PORT → PORT → 53000
if ($env:CACO_PORT) { $Port = $env:CACO_PORT }
elseif ($env:PORT) { $Port = $env:PORT }
else { $Port = 53000 }
$env:PORT = $Port
# Host configuration: CACO_HOST → 127.0.0.1 (localhost only)
if (-not $env:CACO_HOST) { $env:CACO_HOST = '127.0.0.1' }

& .\stop.ps1 2>$null

# Write port file so stop.ps1 knows which port to kill
$Port | Out-File "server.port" -NoNewline

# Start via cmd.exe (needed for npx batch file)
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npx tsx server.ts > server.log 2>&1" `
    -WindowStyle Hidden

# Wait for node to start listening (up to 10 seconds)
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { break }
}

if ($conn) {
    Write-Host "[OK] Server started on port $Port"
    Write-Host "  URL: http://localhost:$Port"
} else {
    Write-Host "[FAIL] Server failed to start"
    if (Test-Path server.log) { Get-Content server.log }
    exit 1
}
