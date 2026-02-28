#!/bin/bash
# Start the Caco server in background

cd "$(dirname "$0")"

# Port configuration: CACO_PORT → PORT → 53000
export PORT=${CACO_PORT:-${PORT:-53000}}
# Host configuration: CACO_HOST → 127.0.0.1 (localhost only)
export CACO_HOST=${CACO_HOST:-127.0.0.1}

# Kill any existing server first
./stop.sh 2>/dev/null

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
