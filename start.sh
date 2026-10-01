#!/bin/bash
# Start the Caco server in the background and wait until it is ready.

cd "$(dirname "$0")"

# Prevent agents from killing their own server
if [ -n "$CACO_SESSION" ]; then
  echo "ERROR: Don't run start.sh from inside Caco — use the restart_server tool"
  exit 1
fi

# Port configuration: CACO_PORT → PORT → 53000. The server may bind one of the
# next ports if this one is unavailable; the lock records the port it used.
export PORT=${CACO_PORT:-${PORT:-53000}}
# Host configuration: CACO_HOST → 127.0.0.1 (localhost only)
export CACO_HOST=${CACO_HOST:-127.0.0.1}

# The server's single-instance lock (src/server-lock.ts SERVER_LOCK_PATH). It
# names the running server's pid and, once ready, the URL it is serving.
LOCK="$HOME/.copilot/caco-server.lock"

# A cold start can be slow while the OS scans node_modules.
TIMEOUT=30
if [[ "$CACO_START_TIMEOUT_SEC" =~ ^[0-9]+$ ]] && [ "$CACO_START_TIMEOUT_SEC" -gt 0 ]; then
  TIMEOUT=$CACO_START_TIMEOUT_SEC
fi

echo "Starting Caco (requested http://$CACO_HOST:$PORT); log: server.log"
echo "  A first start after install or reboot can take a while."

# Kill any existing server first. If it won't stop, launching another would put
# two servers on one session state.
if ! ./stop.sh 2>/dev/null; then
  echo "✗ Could not stop the running Caco; not starting another"
  exit 1
fi

# Preserve the previous run's log before it gets overwritten below.
# Crashes often leave their stack trace in server.log; overwriting it
# on restart destroys post-mortem evidence. Archive into logs/ with a
# timestamp. Keep the most recent 20 archives.
if [ -f server.log ]; then
  mkdir -p logs
  mv -f server.log "logs/server-$(date +%Y%m%d-%H%M%S).log" 2>/dev/null || true
  ls -1t logs/server-*.log 2>/dev/null | tail -n +21 | xargs -r rm -f
fi

LAUNCHED_MS=$(date +%s%3N)
# setsid gives the server its own process group, so a timeout can stop all of it.
setsid nohup npx tsx server.ts > server.log 2>&1 < /dev/null &
PID=$!

# Prints the lock's URL once a server launched by this run reports ready.
ready_url() {
  node -e '
    const fs = require("fs");
    try {
      const l = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (l.state === "ready" && l.url && Date.parse(l.startedAt) >= Number(process.argv[2])) process.stdout.write(l.url);
    } catch {}
  ' "$LOCK" "$LAUNCHED_MS" 2>/dev/null
}

# Echo server.log lines not shown yet, so startup progress appears live. The
# ready line is left out: this script prints the final URL itself.
SEEN=0
echo_new_log() {
  [ -f server.log ] || return
  local n
  n=$(wc -l < server.log)
  if [ "$n" -gt "$SEEN" ]; then
    sed -n "$((SEEN + 1)),${n}p" server.log | grep -vE '^(npm notice|Caco ready:)' | sed 's/^/  /'
    SEEN=$n
  fi
}

for _ in $(seq 1 "$TIMEOUT"); do
  sleep 1
  echo_new_log
  URL=$(ready_url)
  if [ -n "$URL" ]; then
    echo "✓ Caco ready: $URL"
    exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    wait "$PID"
    CODE=$?
    echo_new_log
    echo "✗ Caco exited during startup (exit code $CODE); see server.log"
    exit $(( CODE == 0 ? 1 : CODE ))
  fi
done

kill -- -"$PID" 2>/dev/null
echo_new_log
echo "✗ Caco was not ready after ${TIMEOUT}s and was stopped (set CACO_START_TIMEOUT_SEC to wait longer); see server.log"
exit 1
