#!/usr/bin/env bash
# Run the whole matrix: three entry points x two models x the relevant arms.
# Rebuilds the fixture once so every trial shares one set of marker codes.
#
# Usage: run-all.sh [labroot]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB="${1:-/tmp/instrlab/main}"
read -r -a MODELS <<< "${INSTRLAB_MODELS:-claude-sonnet-4.6 gpt-5.6-terra}"

bash "$HERE/mklab.sh" "$LAB" >/dev/null
REPORT="$LAB/results/report.txt"
mkdir -p "$LAB/results"; : > "$REPORT"

run() { echo "--- $*" >&2; "$@" 2>/dev/null | tee -a "$REPORT"; }

for M in "${MODELS[@]}"; do
  git -C "$LAB/proj" checkout -- . 2>/dev/null
  run "$HERE/run-cli.sh"  "$LAB" "$M" notools
  git -C "$LAB/proj" checkout -- . 2>/dev/null
  run "$HERE/run-cli.sh"  "$LAB" "$M" ondemand
  run "$HERE/run-caco.sh" "$LAB" "$M" notools
  git -C "$LAB/proj" checkout -- . 2>/dev/null
  run "$HERE/run-caco.sh" "$LAB" "$M" ondemand
  run "$HERE/run-caco.sh" "$LAB" "$M" task-general "$HERE/task-general-purpose.txt"
  run "$HERE/run-caco.sh" "$LAB" "$M" task-explore "$HERE/task-explore.txt"
done

echo
echo "report: $REPORT"
