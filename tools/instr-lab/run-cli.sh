#!/usr/bin/env bash
# Run one canary trial against the `copilot` CLI entry point.
#
# Usage: run-cli.sh <labroot> <model> <arm>
#   arm = notools   : tools removed from the model entirely. Any secret the
#                     model reports must therefore have been injected.
#   arm = ondemand  : full tools, agent first edits a file inside sub/ to see
#                     whether that surfaces subdirectory instructions.
#
# Writes <labroot>/results/cli-<model>-<arm>.jsonl and prints a verdict block.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB="${1:?labroot}"; MODEL="${2:?model}"; ARM="${3:-notools}"
mkdir -p "$LAB/results"
OUT="$LAB/results/cli-$MODEL-$ARM.jsonl"

case "$ARM" in
  notools)  PROMPT_FILE="$HERE/probe.txt";          TOOLFLAGS=(--available-tools=) ;;
  ondemand) PROMPT_FILE="$HERE/probe-ondemand.txt"; TOOLFLAGS=(--allow-all-tools) ;;
  *) echo "unknown arm $ARM" >&2; exit 2 ;;
esac

cd "$LAB/proj"
COPILOT_HOME="$LAB/home" timeout 300 copilot \
  -p "$(cat "$PROMPT_FILE")" \
  --model "$MODEL" \
  "${TOOLFLAGS[@]}" \
  --no-auto-update --log-level none --no-remote-export \
  --output-format json > "$OUT" 2>"$OUT.err" || true

"$HERE/verdict.sh" "$LAB" "cli" "$MODEL" "$ARM" "$OUT"
