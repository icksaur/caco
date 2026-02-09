#!/bin/bash
# Start the Copilot web server in background

cd "$(dirname "$0")"

# Port configuration: CACO_PORT → PORT → 53000
export PORT=${CACO_PORT:-${PORT:-53000}}
# Host configuration: CACO_HOST → 127.0.0.1 (localhost only)
export CACO_HOST=${CACO_HOST:-127.0.0.1}

# Kill any existing server first
./stop.sh 2>/dev/null

# Start in background with nohup (use tsx for TypeScript)
nohup npx tsx server.ts > server.log 2>&1 &
echo $! > server.pid

sleep 1

if kill -0 $(cat server.pid) 2>/dev/null; then
  echo "✓ Server started (PID: $(cat server.pid))"
  echo "  Log: server.log"
  echo "  URL: http://localhost:$PORT"
else
  echo "✗ Server failed to start"
  cat server.log
  exit 1
fi
