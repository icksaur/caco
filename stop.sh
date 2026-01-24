#!/bin/bash
# Stop the Copilot web server

cd "$(dirname "$0")"

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
  PID=$(lsof -ti:3000 2>/dev/null)
  if [ -n "$PID" ]; then
    kill $PID
    echo "✓ Killed process on port 3000 (PID: $PID)"
  else
    echo "No server running"
  fi
fi
