#!/usr/bin/env bash
# start-browser.sh — Launch Edge (or Chromium fallback) for Caco automation.
#
# Spawns the browser fully detached so the calling shell can exit immediately.
# Writes the chosen port to ~/.caco/browser-config.json. Honors CACO_HOME.
#
# Usage:
#   start-browser.sh [--mode visible|hidden|headless] [--port N] [--log-file PATH]

set -u

MODE="visible"
PORT=""
LOG_FILE=""
READY_TIMEOUT=25

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --ready-timeout) READY_TIMEOUT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { if [[ -n "$LOG_FILE" ]]; then echo "$*" >>"$LOG_FILE"; fi; echo "$*"; }

if [[ "$MODE" != "visible" && "$MODE" != "hidden" && "$MODE" != "headless" ]]; then
  log "ERROR: --mode must be visible|hidden|headless (got: $MODE)"
  exit 2
fi

CACO_HOME="${CACO_HOME:-$HOME/.caco}"
PROFILE_DIR="$CACO_HOME/browser-profile"
CONFIG_FILE="$CACO_HOME/browser-config.json"
mkdir -p "$CACO_HOME" "$PROFILE_DIR"

EDGE=""
for cand in microsoft-edge-stable microsoft-edge-beta microsoft-edge microsoft-edge-dev msedge; do
  if command -v "$cand" >/dev/null 2>&1; then EDGE="$cand"; break; fi
done
if [[ -z "$EDGE" ]]; then
  for cand in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$cand" >/dev/null 2>&1; then EDGE="$cand"; break; fi
  done
fi
if [[ -z "$EDGE" ]]; then
  log "ERROR: No Edge or Chromium executable found. Install microsoft-edge-stable (AUR) or chromium."
  exit 3
fi
log "Using browser: $EDGE"

port_free() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ! ss -ltn "sport = :$p" 2>/dev/null | grep -q LISTEN
  else
    ! (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null
  fi
}

# True if a CDP endpoint answers /json/version on the given port.
cdp_ready() {
  local p="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 2 "http://127.0.0.1:$p/json/version" >/dev/null 2>&1
  else
    (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1
  fi
}

# Remove stale singleton locks if no live browser owns our profile, so a fresh
# launch does not try to hand off to a dead instance.
clear_stale_locks() {
  if pgrep -af "user-data-dir=$PROFILE_DIR" >/dev/null 2>&1; then return; fi
  for n in SingletonLock SingletonCookie SingletonSocket DevToolsActivePort; do
    if [[ -e "$PROFILE_DIR/$n" ]]; then rm -f "$PROFILE_DIR/$n" && log "Removed stale profile file: $n"; fi
  done
}

start_edge() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$EDGE" "${ARGS[@]}" </dev/null >/dev/null 2>&1 &
  else
    nohup "$EDGE" "${ARGS[@]}" </dev/null >/dev/null 2>&1 &
    disown
  fi
  EDGE_PID=$!
}

if [[ -z "$PORT" ]]; then
  PORT=9222
  if cdp_ready "$PORT"; then
    log "Reusing existing CDP on port $PORT"
  else
    while ! port_free "$PORT"; do PORT=$((PORT + 1)); if [[ $PORT -gt 9300 ]]; then log "ERROR: No free port"; exit 4; fi; done
  fi
fi
log "Using port: $PORT"

cat >"$CONFIG_FILE" <<JSON
{
  "cdpUrl": "http://127.0.0.1:$PORT",
  "defaultTimeoutMs": 10000,
  "launchTimeoutMs": 30000,
  "evalEnabled": false,
  "evalOriginAllowlist": [],
  "authOriginAllowlist": ["login.microsoftonline.com", "login.live.com", "accounts.google.com"],
  "profileDir": "$PROFILE_DIR",
  "screenshotDir": "$CACO_HOME/browser-screenshots",
  "lastLaunchedMode": "$MODE"
}
JSON

# Reuse path: CDP already serving on this port.
if cdp_ready "$PORT"; then
  log "CDP ready on port $PORT (reused existing instance)"
  exit 0
fi

ARGS=(
  "--remote-debugging-port=$PORT"
  "--user-data-dir=$PROFILE_DIR"
  "--no-first-run"
  "--no-default-browser-check"
)
case "$MODE" in
  hidden)   ARGS+=("--start-minimized") ;;
  headless) ARGS+=("--headless=new" "--disable-gpu") ;;
esac

# Authoritative launch: spawn the browser, then verify CDP actually comes up.
# Detect early exit (handoff/absorption) and retry once.
DEADLINE=$(( $(date +%s) + READY_TIMEOUT ))
ATTEMPT=0
MAX_ATTEMPTS=2
EDGE_PID=""

while [[ $(date +%s) -lt $DEADLINE ]]; do
  if [[ -z "$EDGE_PID" ]] || ! kill -0 "$EDGE_PID" 2>/dev/null; then
    if [[ $ATTEMPT -ge $MAX_ATTEMPTS ]]; then
      log "ERROR: browser exited before CDP came up after $ATTEMPT attempt(s)"
      exit 6
    fi
    [[ -n "$EDGE_PID" ]] && log "Browser exited early (pid $EDGE_PID); cleaning locks and retrying"
    clear_stale_locks
    ATTEMPT=$((ATTEMPT + 1))
    start_edge
    log "Launched $EDGE (pid $EDGE_PID) mode=$MODE port=$PORT attempt=$ATTEMPT"
  fi
  if cdp_ready "$PORT"; then
    log "CDP ready on port $PORT (pid $EDGE_PID)"
    exit 0
  fi
  sleep 0.25
done

log "ERROR: CDP never came up on port $PORT within ${READY_TIMEOUT}s (last pid $EDGE_PID)"
exit 7
