# Session Migration

## Overview

Migrate Caco sessions between machines (e.g., work desktop → home laptop) so you can continue a conversation where you left off. Both machines run Caco against the same repos (typically at the same paths via consistent workspace layout).

## Goals

1. **Export** a session from machine A into a portable archive
2. **Import** the archive on machine B, making the session appear in Caco's session list
3. **Preserve** full conversation history, checkpoints, metadata, and Caco context (roadmaps, icons, outputs)
4. **No path rewriting** required when CWDs match across machines (typical case: `~/workspace/Substrate`)

## Use Cases

### 1. Work-to-home handoff
Start a deep investigation session at work on Windows. Export it. `git push` the archive or copy via shared drive. Import at home on Linux. Continue the conversation.

### 2. Machine migration
Moving to a new dev machine. Bulk-export all active sessions, import on the new machine.

### 3. Sharing a session
Send a session archive to a colleague so they can see the full conversation and continue from it.

## Data Inventory

A complete session consists of two directory trees:

### SDK session data — `~/.copilot/session-state/<id>/`

| File | Purpose | Portable? |
|---|---|---|
| `workspace.yaml` | id, cwd, git_root, branch, summary, timestamps | ✅ Yes (cwd may need rewrite) |
| `events.jsonl` | Full conversation history (all turns, tool calls, results) | ✅ Yes (cwd in session.start event) |
| `checkpoints/` | Agent checkpoint markdown files | ✅ Yes |
| `files/` | Session workspace artifacts | ✅ Yes |
| `research/` | Research artifacts | ✅ Yes |

### Caco session data — `~/.caco/sessions/<id>/`

| File | Purpose | Portable? |
|---|---|---|
| `meta.json` | name, kind, model, parentSessionId, timestamps, context | ✅ Yes |
| `outputs/` | Display tool outputs (images, embeds) | ✅ Yes |
| `icon.gif` / `icon.png` | Session avatar | ✅ Yes |
| `roadmap.json` | Saved roadmap steps | ✅ Yes |

### Not migrated (server-side, ephemeral)

- Active SDK client connection (re-established on resume)
- Unobserved tracker state (re-hydrated from meta.json timestamps)
- Dispatch state (empty between requests)
- In-memory output cache (rebuilt from disk)

## Design

### Archive Format

A `.caco-session` file is a gzipped tar containing:

```
<sessionId>/
  sdk/
    workspace.yaml
    events.jsonl
    checkpoints/
    files/
    research/
  caco/
    meta.json
    outputs/
    icon.*
    roadmap.json
```

### Export

```
GET /api/sessions/:id/export
```

Returns the `.caco-session` archive as a download.

**Steps:**
1. Validate session exists (SDK dir + optionally Caco dir)
2. Tar both directories into the archive structure
3. Stream response with `Content-Disposition: attachment`

**CLI equivalent:** `/export` slash command triggers download of current session.

### Import

```
POST /api/sessions/import
Content-Type: multipart/form-data (file upload)
```

**Steps:**
1. Extract archive to temp directory
2. Read `workspace.yaml` to get session ID
3. Check for ID collision (session already exists on this machine)
4. If CWD doesn't exist locally, prompt user for replacement path (or use `?cwd=` query param)
5. Copy SDK files to `~/.copilot/session-state/<id>/`
6. Copy Caco files to `~/.caco/sessions/<id>/`
7. Trigger session cache refresh
8. Return session ID for immediate use

**CLI equivalent:** `/import` slash command with file picker.

### CWD Handling

Three scenarios:

| Scenario | Action |
|---|---|
| CWD matches on target machine | No rewrite needed |
| CWD doesn't exist, user provides replacement | Rewrite `workspace.yaml` cwd/git_root + `events.jsonl` session.start context |
| CWD doesn't exist, no replacement | Import anyway with warning; Caco falls back to server CWD on resume |

Path rewriting (when needed) is a simple string replace of the old CWD with the new one in:
- `workspace.yaml` → `cwd`, `git_root`
- `events.jsonl` line 1 → `session.start` context `cwd` and `gitRoot`

**Not rewritten:** absolute paths inside conversation content (tool call results referencing files). These are historical context — the conversation is readable, but "open this file" references may not work.

## Implementation Plan

### Phase 1: Export

1. Add `GET /api/sessions/:id/export` route
2. Use Node `tar` stream to create gzipped archive from both directories
3. Add `/export` slash command that triggers download of current session
4. Verify: export a session, check archive contains both SDK and Caco directories

### Phase 2: Import

1. Add `POST /api/sessions/import` route with multipart file upload
2. Extract, validate, check for ID collision
3. Copy to correct locations
4. Optional CWD rewrite via `?cwd=/new/path` query param
5. Refresh session cache, broadcast `session.listChanged`
6. Add `/import` slash command with file picker
7. Verify: import exported session, confirm it loads and conversation history is intact

### Phase 3: Bulk operations

1. `GET /api/sessions/export-all` — export all sessions in one archive
2. Useful for machine migration

## Considerations

- **Session ID collisions** — if importing to a machine that already has the session, skip or offer to overwrite
- **SDK version compatibility** — `events.jsonl` format may differ across SDK versions. Import should validate the first event parses correctly.
- **Archive size** — long sessions can have multi-MB events.jsonl. Gzip compression is essential.
- **No secrets in archive** — events.jsonl may contain tool call results with sensitive data. Export should warn the user.
- **Partial archives** — Caco dir may not exist (session was only used in VS Code). Import should handle SDK-only archives gracefully.
- **Cross-platform paths** — Windows `C:\Users\user\workspace` vs Linux `/home/user/workspace`. CWD rewrite handles this if paths differ.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| events.jsonl corruption during transfer | Validate JSON parse of first/last lines on import |
| ID collision silently overwrites | Check before write, return error with option to force |
| Large archive sizes (100MB+) | Gzip compression; consider excluding tool call result bodies |
| Sensitive data in archive | Warn user on export; don't auto-share |
| CWD mismatch breaks resume | Caco already falls back gracefully; warn but don't block |
