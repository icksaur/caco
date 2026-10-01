#!/bin/bash
# Stop the Caco server

cd "$(dirname "$0")"

# Prevent agents from killing their own server
if [ -n "$CACO_SESSION" ]; then
  echo "ERROR: Don't run stop.sh from inside Caco — use the restart_server tool"
  exit 1
fi

# The server's single-instance lock (src/server-lock.ts SERVER_LOCK_PATH).
LOCK="$HOME/.copilot/caco-server.lock"

if [ -f "$LOCK" ]; then
  LOCK_PID=$(node -e '
    try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pid)); } catch {}
  ' "$LOCK" 2>/dev/null)
  # Stop the lock's pid only if it is really a Caco server: after a crash the
  # pid may belong to an unrelated process.
  if [ -n "$LOCK_PID" ] && tr '\0' ' ' < "/proc/$LOCK_PID/cmdline" 2>/dev/null | grep -q 'server\.ts'; then
    kill "$LOCK_PID" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$LOCK_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$LOCK_PID" 2>/dev/null && kill -9 "$LOCK_PID" 2>/dev/null
    sleep 0.5
    if kill -0 "$LOCK_PID" 2>/dev/null; then
      echo "✗ Caco (pid $LOCK_PID) did not stop; it still owns the session state"
      exit 1
    fi
    echo "✓ Server stopped (pid $LOCK_PID)"
  else
    echo "No server running (stale lock)"
  fi
  rm -f server.pid server.port
  exit 0
fi

# No lock: a server from before the lock existed, found by its port. Never
# reached once a lock-writing server has run.
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
