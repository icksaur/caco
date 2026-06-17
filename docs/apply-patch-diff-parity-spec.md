# apply_patch diff parity

## Goal
- `apply_patch` gets the same Caco treatment as `edit`: successful file mutation wakes the Files applet diff list, and chat shows an inline diff card when the event carries parseable patch/diff content.

## Design
- **File-edits wakeup:** add `apply_patch` to the server write-tool set in `src/dispatch-events.ts`.
  - Existing `GitEditPoller` remains the source of truth for changed files and full diffs.
  - Trigger only on `tool.execution_complete` with `success === true`, matching `edit/create/write`.
- **Chat inline diff:** add `apply_patch` to the client edit-tool set in `public/ts/dom-regions.ts`.
  - Extend `parseEditResult()` in `public/ts/edit-diff.ts` to parse:
    - existing unified diffs from `result.detailedContent` / `result.content`;
    - Codex apply-patch envelopes from string payload fields (`arguments.patch`, `arguments.input`, `arguments.content`, `result.detailedContent`, `result.content`).
  - Codex parser recognizes `*** Begin Patch` / `*** End Patch`, `*** Update|Add|Delete File:`, bare `@@` hunk markers, and header-less add/delete runs.
  - If parsing fails or the output is opaque success text, fall back to the existing generic tool renderer.
- **Header path:** if the event has no `arguments.path`, derive a display path from the first parsed patch file header only.
- **Scope:** no direct file reads from the browser, no duplicate diff source, no session-context auto-add for `apply_patch` in V1.

## Considerations
- `apply_patch` is a freeform tool; event payloads may vary. Parser must be conservative and null-return on unknown shapes.
- SDK type surface confirms `CUSTOM_TOOL_NAMES = ["apply_patch"]` and `editingToolsStyle?: "replace" | "apply-patch"`, but does not guarantee a normalized diff field for custom-tool completions.
- Files applet parity does not require parsing the patch payload; git status/diff polling already handles actual working tree state.
- Inline chat diffs are best-effort summaries; full truth stays in `/file-edits/snapshot`.
- Multi-file patches render as one card with aggregate stats and the first touched filename.

## Acceptance
- Unit test: successful `apply_patch` completion triggers `gitEditPoller.triggerPoll(sessionId, 'event')`; failed completion does not.
- Unit test: `parseEditResult()` extracts add/remove stats from Codex envelope payloads without filesystem access, including:
  - update with bare `@@`;
  - update with no `@@`;
  - add file with no `@@`.
- Unit test: `dom-regions` renders `apply_patch` completion as an edit event when parseable and keeps generic rendering when opaque.
- Existing `edit/create/write` behavior remains unchanged.

## Plan
1. Add failing tests for `apply_patch` poll triggering, Codex-envelope patch parsing, and chat rendering.
2. Add `apply_patch` to server/client write/edit tool sets.
3. Extend `edit-diff` with a conservative Codex-envelope parser and first-file display path extraction.
4. Run focused tests, then typecheck/lint/test suite.
5. Run implementation code review against `code-quality.md`; apply warranted fixes.
