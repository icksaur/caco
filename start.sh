#!/bin/bash
# Start the Copilot web server in background

cd "$(dirname "$0")"

# Kill any existing server first
./stop.sh 2>/dev/null

# Start in background with nohup
nohup node server.js > server.log 2>&1 &
echo $! > server.pid

sleep 1

if kill -0 $(cat server.pid) 2>/dev/null; then
  echo "✓ Server started (PID: $(cat server.pid))"
  echo "  Log: server.log"
  echo "  URL: http://localhost:3000"
else
  echo "✗ Server failed to start"
  cat server.log
  exit 1
fi
