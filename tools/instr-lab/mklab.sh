#!/usr/bin/env bash
# Build a fresh canary fixture for custom-instruction loading experiments.
#
# Each of six candidate instruction locations gets ONE unguessable secret.
# The secret names are neutral (NATO alphabet) so a runtime cannot infer which
# file a secret lives in and confabulate a plausible answer.
#
# Usage: mklab.sh <labdir>
# Emits a shell-sourceable key file at <labdir>/tokens.env
set -euo pipefail

LAB="${1:?usage: mklab.sh <labdir>}"
rm -rf "$LAB"
mkdir -p "$LAB/proj/sub" "$LAB/proj/.github" "$LAB/home"

tok() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

ALPHA=$(tok)    # ~/.copilot/copilot-instructions.md   (global, COPILOT_HOME)
BRAVO=$(tok)    # <root>/AGENTS.md
CHARLIE=$(tok)  # <root>/sub/AGENTS.md
DELTA=$(tok)    # <root>/copilot-instructions.md
ECHO_=$(tok)    # <root>/sub/copilot-instructions.md
FOXTROT=$(tok)  # <root>/.github/copilot-instructions.md
HOTEL=$(tok)    # <root>/NOTES.md -- decoy. No convention loads this file, so a
                # runtime that reports HOTEL must have searched the filesystem.
                # This is the tool-use detector for runtimes whose transcripts
                # we cannot inspect (notably `task` sub-agents).
# GOLF is the control: it exists in no file anywhere. Any answer but ABSENT
# means the runtime confabulates, which invalidates its other answers.

# Credentials only. settings.json and the real global instructions file are
# deliberately NOT copied, so the sandbox home carries no behaviour from the
# operator's live configuration.
cp "$HOME/.copilot/config.json" "$LAB/home/config.json"

w() { printf '%s\n' "$2" > "$1"; }

w "$LAB/home/copilot-instructions.md" "# Global user instructions
The ALPHA marker code is $ALPHA
When asked to report configuration markers, always report the ALPHA marker code."

w "$LAB/proj/AGENTS.md" "# Project agent instructions
The BRAVO marker code is $BRAVO
When asked to report configuration markers, always report the BRAVO marker code."

w "$LAB/proj/sub/AGENTS.md" "# Subdirectory agent instructions
The CHARLIE marker code is $CHARLIE
When asked to report configuration markers, always report the CHARLIE marker code."

w "$LAB/proj/copilot-instructions.md" "# Project copilot instructions
The DELTA marker code is $DELTA
When asked to report configuration markers, always report the DELTA marker code."

w "$LAB/proj/sub/copilot-instructions.md" "# Subdirectory copilot instructions
The ECHO marker code is $ECHO_
When asked to report configuration markers, always report the ECHO marker code."

w "$LAB/proj/.github/copilot-instructions.md" "# Dot-github copilot instructions
The FOXTROT marker code is $FOXTROT
When asked to report configuration markers, always report the FOXTROT marker code."

w "$LAB/proj/sub/target.txt" "line one
line two"

w "$LAB/proj/NOTES.md" "# Notes
The HOTEL marker code is $HOTEL
When asked to report configuration markers, always report the HOTEL marker code."

w "$LAB/proj/README.md" "# Fixture
A throwaway repo for custom-instruction loading experiments."

git -C "$LAB/proj" init -q
git -C "$LAB/proj" add -A
git -C "$LAB/proj" -c user.email=lab@example.com -c user.name=lab commit -qm fixture

cat > "$LAB/tokens.env" <<EOF
ALPHA=$ALPHA
BRAVO=$BRAVO
CHARLIE=$CHARLIE
DELTA=$DELTA
ECHO=$ECHO_
FOXTROT=$FOXTROT
HOTEL=$HOTEL
GOLF=__CONTROL_EXISTS_NOWHERE__
EOF

echo "$LAB"
