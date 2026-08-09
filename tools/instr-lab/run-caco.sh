#!/usr/bin/env bash
# Run one canary trial against a Caco session (the same path that
# create_caco_session and caco_session_delegate use).
#
# Caco does not honour COPILOT_HOME, so the global-instructions scenario is
# tested by temporarily writing a delimited marker block into the operator's
# real ~/.copilot/copilot-instructions.md. Opt in with INSTRLAB_GLOBAL=1; see
# the sweep() comment for why a backup-restore is not used.
#
# Usage: run-caco.sh <labroot> <model> <arm> [promptfile]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB="${1:?labroot}"; MODEL="${2:?model}"; ARM="${3:-notools}"
BASE="${CACO_BASE:-http://localhost:53000}"
# shellcheck disable=SC1091
source "$LAB/tokens.env"

case "$ARM" in
  notools)  PROMPT_FILE="${4:-$HERE/probe.txt}" ;;
  ondemand) PROMPT_FILE="${4:-$HERE/probe-ondemand.txt}" ;;
  *)        PROMPT_FILE="${4:?arm needs an explicit prompt file}" ;;
esac

# Caco does not honour COPILOT_HOME, so the global-instructions scenario needs a
# marker in the operator's real ~/.copilot/copilot-instructions.md. That file is
# shared with every live session, so the marker is written as a delimited block
# and removed by matching those delimiters -- never by restoring a whole-file
# backup, which would silently discard an edit made while the trial ran. An
# orphaned block from a killed run is swept on the next start, so residue is
# self-healing rather than permanent.
#
# Opt in with INSTRLAB_GLOBAL=1. Without it the trial still runs; only the
# ALPHA row is untested, which costs nothing for entry points that load no
# instructions at all.
GLOBAL="$HOME/.copilot/copilot-instructions.md"
BEGIN='<!-- instr-lab:begin -->'
END='<!-- instr-lab:end -->'

sweep() {
  [ -f "$GLOBAL" ] || return 0
  grep -qF "$BEGIN" "$GLOBAL" || return 0
  local tmp; tmp="$(mktemp "$GLOBAL.XXXXXX")"
  awk -v b="$BEGIN" -v e="$END" '
    index($0,b) {skip=1} !skip {print} index($0,e) {skip=0}' "$GLOBAL" > "$tmp"
  # Preserve ownership/permissions of the operator's file.
  cat "$tmp" > "$GLOBAL"; rm -f "$tmp"
}

if [ "${INSTRLAB_GLOBAL:-0}" = 1 ]; then
  trap sweep EXIT INT TERM
  sweep
  printf '%s\n# Diagnostic fixture (instr-lab)\nThe ALPHA marker code is %s\n%s\n' \
    "$BEGIN" "$ALPHA" "$END" >> "$GLOBAL"
fi

mkdir -p "$LAB/results"
OUT="$LAB/results/caco-$MODEL-$ARM.jsonl"

SID="$(curl -sS -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg cwd "$LAB/proj" --arg m "$MODEL" --arg d "instr-lab $MODEL $ARM" \
        '{cwd:$cwd, model:$m, description:$d}')" | jq -r '.sessionId')"
[ -n "$SID" ] && [ "$SID" != null ] || { echo "session create failed" >&2; exit 1; }
echo "caco session: $SID" >&2

EV="$HOME/.copilot/session-state/$SID/events.jsonl"
for _ in $(seq 1 60); do [ -f "$EV" ] && break; sleep 0.5; done
OFF=$(stat -c %s "$EV" 2>/dev/null || echo 0)

curl -sS -X POST "$BASE/api/sessions/$SID/messages" -H 'Content-Type: application/json' \
  -d "$(jq -Rs '{prompt:.}' < "$PROMPT_FILE")" >/dev/null

# The session is done when a turn ends with no tool call still open. Poll the
# event log rather than the HTTP status, which reports idle before the log
# settles.
for _ in $(seq 1 240); do
  sleep 2
  tail -c "+$((OFF+1))" "$EV" 2>/dev/null > "$OUT" || true
  starts=$(grep -c '"assistant.turn_start"' "$OUT" 2>/dev/null || true); starts=${starts:-0}
  ends=$(grep -c '"assistant.turn_end"' "$OUT" 2>/dev/null || true); ends=${ends:-0}
  [ "$starts" -gt 0 ] && [ "$ends" -ge "$starts" ] && break
done

echo "caco_session_id: $SID"
"$HERE/verdict.sh" "$LAB" "caco" "$MODEL" "$ARM" "$OUT"
