#!/usr/bin/env bash
# Are DESCENDANT copilot-instructions.md files auto-loaded under any convention?
#
# Two candidate forms, tested in both arms so "eager" and "on demand" are
# separated rather than conflated:
#
#   proj/mid/deep/sub/.github/copilot-instructions.md   MIKE
#   proj/mid/deep/sub/copilot-instructions.md           NOVEMBER  (bare)
#   proj/mid/deep/sub/AGENTS.md                         LIMA      (reference point)
#   proj/mid/deep/AGENTS.md                             KILO      (cwd, must load)
#
# arm=eager    : tools removed entirely, so only session-start injection can
#                supply an answer. Nothing in sub/ is ever touched.
# arm=ondemand : full tools, agent edits sub/target.txt, which is what triggers
#                the runtime's upward walk from that file's directory.
#
# Usage: descendant-test.sh [labroot] [model] [arm]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB="${1:-/tmp/instrlab/desc}"
MODEL="${2:-claude-sonnet-4.6}"
ARM="${3:-eager}"

rm -rf "$LAB"; mkdir -p "$LAB/home" "$LAB/proj/.github" "$LAB/proj/mid/deep/sub/.github"
cp "$HOME/.copilot/config.json" "$LAB/home/config.json"

tok() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
BRAVO=$(tok) FOXTROT=$(tok) KILO=$(tok) LIMA=$(tok) MIKE=$(tok) NOVEMBER=$(tok) HOTEL=$(tok)

w() { printf '# %s\nThe %s marker code is %s\nWhen asked to report configuration markers, always report the %s marker code.\n' \
      "$2" "$2" "$3" "$2" > "$1"; }

w "$LAB/proj/AGENTS.md"                                    BRAVO    "$BRAVO"
w "$LAB/proj/.github/copilot-instructions.md"              FOXTROT  "$FOXTROT"
w "$LAB/proj/mid/deep/AGENTS.md"                           KILO     "$KILO"
w "$LAB/proj/mid/deep/sub/AGENTS.md"                       LIMA     "$LIMA"
w "$LAB/proj/mid/deep/sub/.github/copilot-instructions.md" MIKE     "$MIKE"
w "$LAB/proj/mid/deep/sub/copilot-instructions.md"         NOVEMBER "$NOVEMBER"
w "$LAB/proj/NOTES.md"                                     HOTEL    "$HOTEL"
printf 'line one\nline two\n' > "$LAB/proj/mid/deep/sub/target.txt"

git -C "$LAB/proj" init -q
git -C "$LAB/proj" add -A
git -C "$LAB/proj" -c user.email=l@e -c user.name=l commit -qm fixture

NAMES='BRAVO\nFOXTROT\nKILO\nLIMA\nMIKE\nNOVEMBER\nHOTEL\nGOLF'
if [ "$ARM" = ondemand ]; then
  BODY="$(sed "s/^ALPHA$/$NAMES/; /^BRAVO$/d; /^CHARLIE$/d; /^DELTA$/d; /^ECHO$/d; /^FOXTROT$/d; /^HOTEL$/d; /^GOLF$/d; s/eight lines/eight lines/" "$HERE/probe-ondemand.txt")"
  TOOLFLAGS=(--allow-all-tools)
else
  BODY="$(sed "s/^ALPHA$/$NAMES/; /^BRAVO$/d; /^CHARLIE$/d; /^DELTA$/d; /^ECHO$/d; /^FOXTROT$/d; /^HOTEL$/d; /^GOLF$/d" "$HERE/probe.txt")"
  TOOLFLAGS=(--available-tools=)
fi

OUT="$LAB/out-$ARM.jsonl"
cd "$LAB/proj/mid/deep"
COPILOT_HOME="$LAB/home" timeout 300 copilot -p "$BODY" --model "$MODEL" \
  "${TOOLFLAGS[@]}" --no-auto-update --log-level none --no-remote-export \
  --output-format json > "$OUT" 2>"$OUT.err" || true

TEXT="$(jq -r 'select(.type=="assistant.message") | (.data.content // "")' "$OUT" 2>/dev/null)"
TOOLS="$(jq -r 'select(.type=="tool.execution_start") | (.data.toolName // .data.name // "?")' "$OUT" 2>/dev/null | sort -u | tr '\n' ',')"
DISC="$(jq -r 'select(.data.kind.type=="instruction_discovered") | .data.kind.sourcePath' "$OUT" 2>/dev/null | sort -u | tr '\n' ' ')"
# A tool that opened an instruction file would invalidate every positive answer.
TOUCHED="$(jq -r 'select(.type=="tool.execution_start") | (.data.arguments // {} | tostring)' "$OUT" 2>/dev/null \
  | grep -Eo '[^"]*(AGENTS\.md|copilot-instructions\.md|NOTES\.md)' | sort -u | tr '\n' ',')"

echo "### descendant conventions | $MODEL | arm=$ARM | cwd = proj/mid/deep"
echo "tools_called: ${TOOLS:-none}"
echo "instruction_files_touched: ${TOUCHED:-none}"
echo "runtime_discovery_events: ${DISC:-none}"
echo
printf '%-9s %-9s %s\n' NAME GOT WHERE
check() {
  local got
  got="$(printf '%s' "$TEXT" | grep -Eio "$1[^0-9a-zA-Z]{0,8}([0-9a-f]{32}|ABSENT)" | head -1 \
        | grep -Eio '[0-9a-f]{32}|ABSENT')"
  local status
  if [ "$got" = "$2" ]; then status=LOADED
  elif [ "$got" = ABSENT ]; then status=absent
  elif [ -z "$got" ]; then status=no-answer
  else status=WRONG; fi
  printf '%-9s %-9s %s\n' "$1" "$status" "$3"
}
check BRAVO    "$BRAVO"    "proj/AGENTS.md                     (git root)"
check FOXTROT  "$FOXTROT"  "proj/.github/copilot-instructions.md (git root)"
check KILO     "$KILO"     "proj/mid/deep/AGENTS.md            (cwd)"
check LIMA     "$LIMA"     "sub/AGENTS.md                      (descendant)"
check MIKE     "$MIKE"     "sub/.github/copilot-instructions.md (descendant, .github)"
check NOVEMBER "$NOVEMBER" "sub/copilot-instructions.md        (descendant, bare)"
check HOTEL    "$HOTEL"    "proj/NOTES.md                      (decoy)"
check GOLF     __none__    "(control: no file)"
