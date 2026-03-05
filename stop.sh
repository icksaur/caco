#!/bin/bash
# Stop the Caco server

cd "$(dirname "$0")"

# Prevent agents from killing their own server
if [ -n "$CACO_SESSION" ]; then
  echo "ERROR: Don't run stop.sh from inside Caco — use the restart_server tool"
  exit 1
fi

# Read port from server.port file, fall back to env, then default
if [ -f server.port ]; then
  PORT=$(cat server.port)
elif [ -n "$CACO_PORT" ]; then
  PORT=$CACO_PORT
else
  PORT=${PORT:-53000}
fi

# Find and kill any node process listening on the port
PIDS=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u)

if [ -z "$PIDS" ]; then
  # Fallback: try lsof
  PIDS=$(lsof -ti:$PORT 2>/dev/null)
fi

if [ -n "$PIDS" ]; then
  for PID in $PIDS; do
    kill $PID 2>/dev/null
  done
  echo "✓ Server stopped (port $PORT)"
else
  echo "No server running on port $PORT"
fi

rm -f server.pid server.port
