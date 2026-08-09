#!/usr/bin/env bash
# Score one trial: map reported secrets back to their source file, and decide
# whether the trial is CONCLUSIVE.
#
# A trial is INCONCLUSIVE if the runtime called any tool that could have read an
# instruction file, because then a correct secret proves nothing about
# automatic injection. It is INVALID if the control secret GOLF was answered
# with anything other than ABSENT, because that runtime confabulates.
#
# Usage: verdict.sh <labroot> <entrypoint> <model> <arm> <jsonl>
set -euo pipefail

LAB="${1:?}"; EP="${2:?}"; MODEL="${3:?}"; ARM="${4:?}"; JSONL="${5:?}"
# shellcheck disable=SC1091
source "$LAB/tokens.env"

TEXT="$(jq -r 'select(.type=="assistant.message") | (.data.content // .content // "")' "$JSONL" 2>/dev/null || true)"
# The task tool's result carries the sub-agent's own reply, which the parent
# may summarise rather than relay. Score the raw result too.
TEXT="$TEXT
$(jq -r 'select(.type=="tool.execution_complete") | (.data.result // .data.output // "" | tostring)' "$JSONL" 2>/dev/null || true)"
TOOLS="$(jq -r 'select(.type=="tool.execution_start") | (.data.name // .data.toolName // "unknown")' "$JSONL" 2>/dev/null | sort -u | tr '\n' ',' || true)"

# The runtime announces on-demand discovery as a first-class event. This is
# ground truth, independent of anything the model says about itself.
DISCOVERED="$(jq -r 'select(.data.kind.type=="instruction_discovered")
  | "\(.data.kind.sourcePath) (trigger: \(.data.kind.triggerTool) on \(.data.kind.triggerFile|split("/")|last))"' \
  "$JSONL" 2>/dev/null | sort -u || true)"

# A sub-agent runs inside the parent process and gets no event log of its own,
# but its tool calls still raise preToolUse hooks carrying ITS session id. That
# makes "the sub-agent read nothing" checkable rather than merely plausible.
PARENT="$(jq -r 'select(.type=="session.start") | .data.sessionId' "$JSONL" 2>/dev/null | head -1)"
SUBTOOLS="$(jq -r --arg p "$PARENT" 'select(.type=="hook.start")
  | .data.input? // empty
  | select((.sessionId // "") != $p)
  | (.toolName // ((.toolCalls // [])[]?.name) // empty)' "$JSONL" 2>/dev/null | sort -u | tr '\n' ',' || true)"
SUBAGENTS="$(jq -r 'select(.type=="subagent.started") | "\(.data.agentName)/\(.data.model)"' "$JSONL" 2>/dev/null | sort -u | tr '\n' ',' || true)"

# A positive answer proves nothing if the runtime read an instruction file
# itself. Only paths matter: viewing the file it was asked to edit is fine.
READPATHS="$(jq -r 'select(.type=="tool.execution_start")
  | (.data.arguments // .data.input // {}) | tostring' "$JSONL" 2>/dev/null \
  | grep -Eo '[^"]*(AGENTS\.md|CLAUDE\.md|GEMINI\.md|copilot-instructions\.md|\.instructions\.md|NOTES\.md)' \
  | sort -u | tr '\n' ',' || true)"

declare -A SRC=(
  [ALPHA]='$COPILOT_HOME/copilot-instructions.md (global)'
  [BRAVO]='<root>/AGENTS.md'
  [CHARLIE]='<root>/sub/AGENTS.md'
  [DELTA]='<root>/copilot-instructions.md'
  [ECHO]='<root>/sub/copilot-instructions.md'
  [FOXTROT]='<root>/.github/copilot-instructions.md'
  [HOTEL]='<root>/NOTES.md (decoy: no convention loads it)'
  [GOLF]='(control: no file)'
)

echo "### $EP | $MODEL | $ARM"
echo "tools_called: ${TOOLS:-none}"
echo "subagents: ${SUBAGENTS:-none}"
echo "subagent_tools_called: ${SUBTOOLS:-none}"
echo "instruction_files_touched_by_tools: ${READPATHS:-none}"
echo "runtime_discovery_events: ${DISCOVERED:-none}"

control_ok=yes
searched=no
missing=0
for NAME in ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT HOTEL GOLF; do
  EXPECT="${!NAME}"
  # Tolerant extraction: models wrap answers in bullets, bold, or code fences,
  # and a strict line-anchored match would score a loaded marker as absent --
  # the one direction of error that would understate what a runtime receives.
  GOT="$(printf '%s' "$TEXT" | grep -Eio "$NAME[^0-9a-zA-Z]{0,8}([0-9a-f]{32}|ABSENT)" | head -1 \
         | grep -Eio '[0-9a-f]{32}|ABSENT' || true)"
  if [ -z "$GOT" ]; then STATUS="no-answer"; missing=$((missing+1))
  elif [ "$NAME" = GOLF ]; then
    if [ "$GOT" = ABSENT ]; then STATUS="control-ok"; else STATUS="CONTROL-FAILED"; control_ok=no; fi
  elif [ "$NAME" = HOTEL ]; then
    # No loader ever injects NOTES.md, so a correct HOTEL means the runtime
    # went looking on disk and every other positive answer is unprovable.
    if [ "$GOT" = "$EXPECT" ]; then STATUS="DECOY-FOUND"; searched=yes
    elif [ "$GOT" = ABSENT ]; then STATUS="decoy-clean"
    else STATUS="WRONG-VALUE"; control_ok=no; fi
  elif [ "$GOT" = "$EXPECT" ]; then STATUS="LOADED"
  elif [ "$GOT" = ABSENT ]; then STATUS="absent"
  else STATUS="STALE-OR-WRONG"; control_ok=no
  fi
  printf '%-8s %-14s %s\n' "$NAME" "$STATUS" "${SRC[$NAME]}"
done

# A refusal is a model-policy artifact, not evidence about the loader. Keep it
# distinct from confabulation, which invalidates the runtime's other answers.
if printf '%s' "$TEXT" | grep -qiE "can.?t (provide|share|report|disclose)|I'?m not able to (provide|share)"; then
  echo "verdict: REFUSED (model declined; rerun or use another model)"
elif [ "$missing" -gt 0 ] && [ "$control_ok" = yes ]; then
  echo "verdict: INCOMPLETE ($missing of 8 names unanswered)"
elif [ "$control_ok" = no ]; then
  echo "verdict: INVALID (runtime answered a value it could not have had)"
elif [ "$searched" = yes ]; then
  echo "verdict: INCONCLUSIVE (decoy found: the runtime searched the filesystem)"
elif [ -n "$READPATHS" ]; then
  echo "verdict: INCONCLUSIVE (a tool touched an instruction file: $READPATHS)"
elif [ -n "$SUBTOOLS" ]; then
  echo "verdict: INCONCLUSIVE (a sub-agent called tools: $SUBTOOLS)"
else
  echo "verdict: CONCLUSIVE"
fi
echo
