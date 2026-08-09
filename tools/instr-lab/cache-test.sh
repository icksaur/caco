#!/usr/bin/env bash
# Does a long-lived Copilot client process cache custom-instruction file
# CONTENT per directory, so later sessions see a stale copy?
#
# Method: read a marker through a runtime, rewrite AGENTS.md with a new marker,
# then read again through a NEW session of the same long-lived process. A fresh
# `copilot` process is the ground-truth control: it must always report the
# current on-disk value.
#
# The `task` sub-agent prompt is used for the Caco arms because a Caco session
# itself receives no custom instructions at all (systemMessage mode 'replace'),
# so only its sub-agents can observe the loader.
#
# Usage: cache-test.sh [labroot]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB="${1:-/tmp/instrlab/cache}"

reported() {  # reported <jsonl> <NAME> -> the value the runtime printed
  jq -r 'select(.type=="assistant.message") | (.data.content // .content // "")' "$1" 2>/dev/null \
    | grep -Eo "$2=[0-9a-f]{32}|$2=ABSENT" | head -1 | cut -d= -f2
}

bash "$HERE/mklab.sh" "$LAB" >/dev/null
# shellcheck disable=SC1091
source "$LAB/tokens.env"
GEN1="$BRAVO"
echo "on disk, generation 1: BRAVO=$GEN1"

"$HERE/run-caco.sh" "$LAB" claude-sonnet-4.6 gen1 "$HERE/task-general-purpose.txt" >/dev/null 2>&1
A=$(reported "$LAB/results/caco-claude-sonnet-4.6-gen1.jsonl" BRAVO)
echo "caco sub-agent, before edit : $A"

GEN2=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
printf '# Project agent instructions\nThe BRAVO marker code is %s\nWhen asked to report configuration markers, always report the BRAVO marker code.\n' \
  "$GEN2" > "$LAB/proj/AGENTS.md"
echo "on disk, generation 2: BRAVO=$GEN2"

"$HERE/run-cli.sh" "$LAB" claude-sonnet-4.6 notools >/dev/null 2>&1
B=$(reported "$LAB/results/cli-claude-sonnet-4.6-notools.jsonl" BRAVO)
echo "fresh copilot process      : $B"

"$HERE/run-caco.sh" "$LAB" claude-sonnet-4.6 gen2 "$HERE/task-general-purpose.txt" >/dev/null 2>&1
C=$(reported "$LAB/results/caco-claude-sonnet-4.6-gen2.jsonl" BRAVO)
echo "caco sub-agent, after edit : $C"

echo
if [ "$B" = "$GEN2" ] && [ "$C" = "$GEN1" ]; then
  echo "RESULT: STALE CACHE CONFIRMED - the long-lived client kept generation 1."
elif [ "$C" = "$GEN2" ]; then
  echo "RESULT: no staleness - the long-lived client re-read the file."
else
  echo "RESULT: inconclusive (see values above)."
fi
