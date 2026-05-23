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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
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

if [[ -z "$PORT" ]]; then
  PORT=9222
  while ! port_free "$PORT"; do PORT=$((PORT + 1)); if [[ $PORT -gt 9300 ]]; then log "ERROR: No free port"; exit 4; fi; done
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

# Detach via setsid so the browser survives this shell exiting.
if command -v setsid >/dev/null 2>&1; then
  setsid "$EDGE" "${ARGS[@]}" </dev/null >/dev/null 2>&1 &
else
  nohup "$EDGE" "${ARGS[@]}" </dev/null >/dev/null 2>&1 &
  disown
fi
log "Launched $EDGE (pid $!) mode=$MODE port=$PORT"
exit 0
