#!/bin/bash
# Stop the Copilot web server

cd "$(dirname "$0")"

# Port configuration: CACO_PORT → PORT → 3000
PORT=${CACO_PORT:-${PORT:-3000}}

if [ -f server.pid ]; then
  PID=$(cat server.pid)
  if kill -0 $PID 2>/dev/null; then
    kill $PID
    echo "✓ Server stopped (PID: $PID)"
  else
    echo "Server not running (stale PID: $PID)"
  fi
  rm -f server.pid
else
  # Try to find and kill by port
  PID=$(lsof -ti:$PORT 2>/dev/null)
  if [ -n "$PID" ]; then
    kill $PID
    echo "✓ Killed process on port $PORT (PID: $PID)"
  else
    echo "No server running"
  fi
fi
