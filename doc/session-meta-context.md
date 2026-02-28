# Session Meta-Context

**Status: Simplification planned**

The context footer tracks recently touched files and displays session status.

## Problem (original)

When resuming a session, the agent loses awareness of which files were being worked on.

## Problem (current)

The original design over-invested in agent-driven context tracking:

1. **`set_relevant_context` / `get_relevant_context` tools** — Agents rarely call them. The system message nags about them ("REQUIRED", "MUST"), burning prompt tokens for negligible benefit.
2. **`[SESSION RESUMED]` disclaimer** — Prepended to first user message after resume. Adds noise; the session directory is already in the system message.
3. **Applet capture in footer** — The applet slug/params are saved and displayed in the footer. Not useful to the user — they know what applet they had open.
4. **Auto-populate adds folders** — The `view` tool triggers `autoAddFileContext`, which adds directory paths that don't open in the file-browser applet.
5. **No session status in footer** — Model name, budget, and cwd are only visible in the session list, not during active chat.

## Goals

1. **Remove context tools** — Delete `set_relevant_context` and `get_relevant_context` tools and their system message section.
2. **Remove `[SESSION RESUMED]` injection** — Stop prepending the disclaimer to user messages on resume.
3. **Simplify auto-populate** — Only track files from `edit` and `create` tools (not `view`). Keep last 3 files.
4. **Remove applet from footer** — Stop capturing and displaying applet state in the context footer.
5. **Add status bar** — Show model name, budget %, and clickable cwd in the right side of the footer.

## Design

### Context footer layout

```
[ file1.ts · file2.ts · file3.ts                   Model Name · repo/ ]
```

Left side: last 3 files touched (edit/create), clickable to open in text-editor applet.
Right side: friendly model name, cwd basename clickable to open file-browser applet.

The footer is always visible when any content exists (files or status). The status side is always visible during an active session.

### Auto-populate (simplified)

Only `edit` and `create` tool calls add file paths. `view` is excluded (too noisy — agents view many files they don't work on). Directories are filtered out. The list is capped at 3 entries, newest wins (FIFO eviction of oldest).

The `mergeContextSet` utility and the PATCH `/api/sessions/:id` endpoint remain for the `files` set. The `endpoints`, `ports`, and `applet` set names are removed from `KNOWN_SET_NAMES`.

### Resume context (simplified)

The `buildResumeContext` function is removed entirely. The `pendingResumeContext` flag in `SessionManager` is removed. Session directory is already in the system message. File context is in `SessionMeta` and visible in the footer — the agent doesn't need a text injection.

### Status data sources

| Field | Source | Available |
|-------|--------|-----------|
| Model name | `getAvailableModels()` matched by `getSelectedModel()` → `.name` | Yes, from `/api/sessions` on page load |
| CWD | `getCurrentCwd()` from app-state | Yes, set on session activate |

### Status update flow

On session activate: render model name and cwd from app-state. No async fetch needed.

## Implementation plan

### 1. Remove context tools

- `src/context-tools.ts`: Remove `createContextTools`, `set_relevant_context`, `get_relevant_context`. Keep `mergeContextSet` and `KNOWN_SET_NAMES` (used by PATCH endpoint and auto-populate).
- `server.ts`: Remove `createContextTools` import, remove `contextTools` from tool factory return.
- `src/prompts.ts`: Remove "Session Context — REQUIRED" section from system message.
- `tests/unit/applet-tools.test.ts` or similar: Verify no test breakage.

### 2. Remove `[SESSION RESUMED]` injection

- `src/prompts.ts`: Remove `buildResumeContext`, `formatContextForResume`, `buildResumeContextForSession`, `ResumeContextInput` interface.
- `src/session-manager.ts`: Remove `pendingResumeContext` flag from `ActiveSession`. Remove the context injection in `send()` and `sendStream()`. Remove `buildResumeContext` private method.
- `tests/unit/resume-context.test.ts`: Delete file (tests the removed functions).

### 3. Simplify auto-populate

- `src/routes/session-messages.ts` `autoAddFileContext`: 
  - Only called for `edit` and `create` (remove `view` from the `fileTool` check).
  - Cap `context.files` at 3 entries (drop oldest when adding new).
  - Filter out directories (skip if path ends with `/` or doesn't contain a `.` extension — or better, just trust that edit/create always target files).

### 4. Remove applet from footer

- `public/ts/context-footer.ts`: Remove applet rendering section from `renderContextFooter()`. Remove `captureAppletState()` and `sendAppletContext()` exports.
- `public/ts/message-streaming.ts`: Remove `sendAppletContext()` call on `session.idle`.
- `src/prompts.ts` `formatContextForResume`: Remove (already deleted in step 2).
- Reduce `KNOWN_SET_NAMES` to just `files`.

### 5. Add status bar to footer

- `public/index.html`: Add `<span class="context-status"></span>` inside `#contextFooter`.
- `public/ts/context-footer.ts`: Add `renderStatus(model, cwd)` function. Render model name (friendly) and cwd basename as link to `/?applet=file-browser&path=<cwd>`.
- `public/style.css`: Flex layout for footer — `context-links` left, `context-status` right.
- Wire up: call `renderStatus` from session activation and view state changes.

### 6. Update doc

- `doc/session-meta-context.md`: Update to reflect simplified design (this file).

## Key files (after simplification)

| File | Purpose |
|------|---------|
| `src/context-tools.ts` | `mergeContextSet()` utility only |
| `src/routes/session-messages.ts` | `autoAddFileContext()` — edit/create only, max 3 |
| `src/routes/sessions.ts` | PATCH `setContext` handler (unchanged) |
| `src/storage.ts` | `SessionMeta.context` field (unchanged) |
| `public/ts/context-footer.ts` | File links (left) + status bar (right) |
| `public/style.css` | Footer flex layout |

## Risks

- **Removing resume context could degrade agent quality on resume.** Mitigation: the system message already includes the session directory and environment context via `resolveSystemMessage`. Files are visible in the footer. The `envHint` field in SessionMeta remains available for future use if needed.
- **File-browser applet may not exist.** The cwd link should degrade gracefully (just show text if no applet available).
