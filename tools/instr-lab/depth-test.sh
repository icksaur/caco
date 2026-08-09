#!/usr/bin/env bash
# Does eager loading really walk from the cwd up to the git root, picking up
# every AGENTS.md in between?
#
# The main matrix never tested this: its cwd was always the repo root, so the
# "intermediate directories" claim rested on documentation rather than
# measurement. This builds a deep tree, runs from the BOTTOM of it, and checks
# each level independently.
#
#   proj/                     AGENTS.md=BRAVO   .github/copilot-instructions.md=FOXTROT
#   proj/mid/                 AGENTS.md=INDIA   .github/copilot-instructions.md=JULIET
#   proj/mid/deep/            AGENTS.md=KILO    <-- cwd
#   proj/mid/deep/sub/        AGENTS.md=LIMA    <-- descendant, expect NOT loaded
#   proj/NOTES.md             HOTEL             <-- decoy, no convention loads it
#   (GOLF exists nowhere: confabulation control)
#
# Usage: depth-test.sh [labroot] [model]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB="${1:-/tmp/instrlab/depth}"
MODEL="${2:-claude-sonnet-4.6}"

rm -rf "$LAB"; mkdir -p "$LAB/home" "$LAB/proj/.github" "$LAB/proj/mid/.github" "$LAB/proj/mid/deep/sub"
cp "$HOME/.copilot/config.json" "$LAB/home/config.json"

tok() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
ALPHA=$(tok) BRAVO=$(tok) FOXTROT=$(tok) INDIA=$(tok) JULIET=$(tok) KILO=$(tok) LIMA=$(tok) HOTEL=$(tok)

w() { printf '# %s\nThe %s marker code is %s\nWhen asked to report configuration markers, always report the %s marker code.\n' \
      "$2" "$2" "$3" "$2" > "$1"; }

w "$LAB/home/copilot-instructions.md"            ALPHA   "$ALPHA"
w "$LAB/proj/AGENTS.md"                          BRAVO   "$BRAVO"
w "$LAB/proj/.github/copilot-instructions.md"    FOXTROT "$FOXTROT"
w "$LAB/proj/mid/AGENTS.md"                      INDIA   "$INDIA"
w "$LAB/proj/mid/.github/copilot-instructions.md" JULIET "$JULIET"
w "$LAB/proj/mid/deep/AGENTS.md"                 KILO    "$KILO"
w "$LAB/proj/mid/deep/sub/AGENTS.md"             LIMA    "$LIMA"
w "$LAB/proj/NOTES.md"                           HOTEL   "$HOTEL"
printf 'line one\n' > "$LAB/proj/mid/deep/sub/target.txt"

git -C "$LAB/proj" init -q
git -C "$LAB/proj" add -A
git -C "$LAB/proj" -c user.email=l@e -c user.name=l commit -qm fixture

PROMPT="$(sed 's/^FOXTROT$/FOXTROT\nINDIA\nJULIET\nKILO\nLIMA/; s/eight lines/twelve lines/' "$HERE/probe.txt")"

OUT="$LAB/out.jsonl"
cd "$LAB/proj/mid/deep"
COPILOT_HOME="$LAB/home" timeout 300 copilot -p "$PROMPT" --model "$MODEL" \
  --available-tools= --no-auto-update --log-level none --no-remote-export \
  --output-format json > "$OUT" 2>"$OUT.err" || true

TEXT="$(jq -r 'select(.type=="assistant.message") | (.data.content // "")' "$OUT" 2>/dev/null)"
TOOLS="$(jq -r 'select(.type=="tool.execution_start") | (.data.name // "?")' "$OUT" 2>/dev/null | sort -u | tr '\n' ',')"

echo "### eager ancestor walk | $MODEL | cwd = proj/mid/deep"
echo "tools_called: ${TOOLS:-none}"
echo
printf '%-9s %-9s %-9s %s\n' NAME EXPECT GOT WHERE
check() { # check <name> <value> <expect> <where>
  local got
  got="$(printf '%s' "$TEXT" | grep -Eio "$1[^0-9a-zA-Z]{0,8}([0-9a-f]{32}|ABSENT)" | head -1 \
        | grep -Eio '[0-9a-f]{32}|ABSENT')"
  local status
  if [ "$got" = "$2" ]; then status=LOADED
  elif [ "$got" = ABSENT ]; then status=absent
  elif [ -z "$got" ]; then status=no-answer
  else status=WRONG; fi
  printf '%-9s %-9s %-9s %s\n' "$1" "$3" "$status" "$4"
}
check ALPHA   "$ALPHA"   LOADED "\$COPILOT_HOME/copilot-instructions.md"
check BRAVO   "$BRAVO"   LOADED "proj/AGENTS.md            (git root)"
check FOXTROT "$FOXTROT" LOADED "proj/.github/copilot-instructions.md (git root)"
check INDIA   "$INDIA"   LOADED "proj/mid/AGENTS.md        (INTERMEDIATE)"
check JULIET  "$JULIET"  LOADED "proj/mid/.github/copilot-instructions.md (INTERMEDIATE)"
check KILO    "$KILO"    LOADED "proj/mid/deep/AGENTS.md   (cwd)"
check LIMA    "$LIMA"    absent "proj/mid/deep/sub/AGENTS.md (DESCENDANT)"
check HOTEL   "$HOTEL"   absent "proj/NOTES.md             (decoy)"
check GOLF    __none__   absent "(control: no file)"
