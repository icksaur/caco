#!/bin/bash
# Start the Caco server in background

cd "$(dirname "$0")"

# Prevent agents from killing their own server
if [ -n "$CACO_SESSION" ]; then
  echo "ERROR: Don't run start.sh from inside Caco — use the restart_server tool"
  exit 1
fi

# Port configuration: CACO_PORT → PORT → 53000
export PORT=${CACO_PORT:-${PORT:-53000}}
# Host configuration: CACO_HOST → 127.0.0.1 (localhost only)
export CACO_HOST=${CACO_HOST:-127.0.0.1}

# Kill any existing server first
./stop.sh 2>/dev/null

# Preserve the previous run's log before it gets overwritten below.
# Crashes often leave their stack trace in server.log; overwriting it
# on restart destroys post-mortem evidence. Archive into logs/ with a
# timestamp. Keep the most recent 20 archives.
if [ -f server.log ]; then
  mkdir -p logs
  mv -f server.log "logs/server-$(date +%Y%m%d-%H%M%S).log" 2>/dev/null || true
  ls -1t logs/server-*.log 2>/dev/null | tail -n +21 | xargs -r rm -f
fi

# Write port file so stop.sh knows which port to kill
echo "$PORT" > server.port

# Start in background with nohup (use tsx for TypeScript)
nohup npx tsx server.ts > server.log 2>&1 &

# Wait for the port to be listening (up to 10 seconds)
for i in $(seq 1 10); do
  sleep 1
  if ss -tlnp 2>/dev/null | grep -q ":$PORT " || lsof -ti:$PORT >/dev/null 2>&1; then
    echo "✓ Server started on port $PORT"
    echo "  Log: server.log"
    echo "  URL: http://localhost:$PORT"
    exit 0
  fi
done

echo "✗ Server failed to start"
cat server.log
exit 1
