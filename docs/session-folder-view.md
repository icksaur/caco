# Session Folder View

## Goal

Organize sessions into virtual folders in the session panel. Folders are a lightweight organizational layer — they don't affect the SDK, file system, or session CWD. They're purely for visual grouping in the UI.

## Terminology

| Term | Meaning | Used in |
|------|---------|---------|
| **folder** | Virtual session organization path (e.g., `/work`, `/personal`) | Session panel UI, session metadata |
| **cwd** | SDK working directory for file/tool operations | SDK, session-manager, file paths |
| **path** | File system path | File operations, applets |
| **directory** | File system directory | File operations |

**Refactoring rule:** If existing code uses "path" or "directory" to mean the virtual folder concept, rename to "folder". The codebase should never conflate virtual folders with file system paths.

## Folder Path Rules

- Characters allowed: `a-z A-Z 0-9 space _ -`
- Separators: `/` and `\` accepted, normalized to `/`
- Leading `/` optional — `work` and `/work` are equivalent, stored as `/work`
- Empty string, `/`, or `root` = root (no folder). "root" is reserved and normalized to empty string at load time.
- Max depth: 1 for v1 (e.g., `/work` but not `/work/projects`)
- Trailing slashes stripped
- Single source of truth: `normalizeFolder(input: string): string` and `isValidFolder(input: string): boolean`
- Invalid characters silently stripped during normalization
- At load time, stored folder paths are normalized (auto-fix corrupt data)

## Data Model

### SessionMeta addition

```typescript
interface SessionMeta {
  // ... existing fields ...
  folder?: string;  // Virtual folder path, e.g., "/work". Absent or empty = root.
}
```

Stored in `~/.caco/sessions/<id>/meta.json`. No file system folders created.

### API changes

`GET /api/sessions` response adds `folder` field per session:
```typescript
interface SessionListItem {
  // ... existing fields ...
  folder?: string;
}
```

`PATCH /api/sessions/:id` accepts `folder` field (same as name/model):
```json
{ "folder": "/work" }
```

## UI Behavior

### Session panel layout

Root sessions render first (no header), then folders alphabetically with collapsible headers:

- **Root sessions** — sessions without a folder, in MRU order, no group header
- **Folder headers** — collapsible row: chevron (▸/▾) + name + session count + aggregate badge
- **Folder contents** — indented session items, in MRU order within the folder
- **Expand/collapse:** click the whole folder header row. State persisted in localStorage.
- **Aggregate badges:** folder header shows busy indicator if any contained session is busy, unobserved badge if any is unobserved. Busy takes priority.
- **Empty folders:** do not render. Moving the last session out removes the folder.

### Within folders

Sessions inside a folder are sorted by MRU snapshot order (same as root), just filtered to that folder.

### MRU interaction

MRU snapshot ordering is **preserved within each group** (root and each folder). The snapshot doesn't cross folder boundaries — a session's position within its folder is determined by its MRU rank relative to other sessions in the same folder.

**No conflict with MRU:** MRU determines order within root and within each folder. Folders determine grouping. These are orthogonal.

## Slash Command

### `/session-folder <folder>`

Move the current session to a folder.

| Input | Result |
|-------|--------|
| `/session-folder work` | Moves to `/work` |
| `/session-folder /work` | Same — normalizes |
| `/session-folder /` | Moves to root |
| `/session-folder root` | Same — moves to root |
| `/session-folder ` | Toast: "Usage: /session-folder <name>" |
| `/session-folder work/sub` | Toast: "Nested folders not supported yet" |
| `/session-folder @invalid!` | Toast: "Invalid folder name: only letters, numbers, space, dash, underscore" |

Success toast: `Session moved to /work`

This is the only way to create a folder. If a session is moved to `/work` and no other session is in `/work`, the folder appears. Moving the last session out makes it disappear.

## Implementation

### API changes: flatten `grouped`, add `folder`

The current `GET /api/sessions` returns `grouped: Record<cwd, SessionData[]>`. **Replace `grouped` with a flat `sessions` array.** The frontend already flattens it immediately (session-panel.ts:312-318). CWD grouping was visual debt — the UI never rendered CWD group headers.

New response shape:
```typescript
{
  sessions: SessionData[],        // flat list, each has cwd + folder
  sessionOrder: string[],         // MRU snapshot
  activeSessionId: string,
  // ... models, peers, unobservedCount unchanged
}
```

This simplifies the API and eliminates the `grouped` → flatten → sort roundtrip. The `folder` field on each session drives the UI grouping.

### Backend

**`src/folder.ts`** (new module) — folder validation/normalization:
```typescript
export function normalizeFolder(input: string): string
export function isValidFolder(input: string): boolean
```

Normalization rules:
- Trim whitespace
- Replace `\` with `/`
- Strip characters not in `[a-zA-Z0-9 _-/]`
- Strip leading/trailing `/`
- `"root"` (case-insensitive) → empty string
- Enforce max depth 1 (strip everything after first `/`)
- If result is empty after stripping → empty string (= root)

**`src/storage.ts`** — `SessionMeta` gains `folder?: string`.

**`src/session-manager.ts`** — `list()` reads `meta.folder` and includes in `SessionListItem`. `listAllGrouped()` removed or deprecated — replaced by flat `list()`.

**`src/routes/sessions.ts`**:
- `GET /api/sessions`: return flat `sessions` array instead of `grouped`
- `PATCH /api/sessions/:id`: accept `folder` field, validate with `isValidFolder()`, return 400 on invalid, normalize before saving. Broadcast `session.listChanged` after folder change.

### Frontend

**`public/ts/types.ts`**:
- `SessionData` gains `folder?: string`
- `SessionsResponse.grouped` replaced with `sessions: SessionData[]`

**`public/ts/session-panel.ts`**:
- `loadSessions()`: read `data.sessions` directly (no flatten step)
- `renderFilteredSessions()` rewritten:
  1. Partition `allSessions` into root (no folder) and `Map<folder, SessionData[]>`
  2. Render root sessions
  3. For each folder (sorted alphabetically): render folder header + contained sessions
  4. Folder header includes: chevron (▸/▾), name, count, aggregate badge
  5. Collapse state from `localStorage` keyed by `caco:folder-collapsed:<name>`
- Aggregate badge: computed during render by scanning contained sessions for `isUnobserved`/`isBusy`. Re-computed on each render call (triggered by `sessionTracker.onChange` → `renderFilteredSessions()`).

**`public/ts/command-registry.ts`** — add `/session-folder` command.

**`public/style.css`** — folder header styles, session indent within folders.

### Real-time updates

`sessionTracker.onChange()` currently calls `updateSessionItemState()` (per session) + `updateMenuIndicators()`. For folders:
- Keep `updateSessionItemState()` for individual session DOM updates
- Add: call `updateFolderBadges()` after any session state change — iterates folder headers and recomputes aggregate from contained `session-item` elements' classes

This avoids re-rendering the full list on every state change. `renderFilteredSessions()` is only called on `loadSessions()` (list changes), not on busy/unobserved toggles.

### Unit tests

- `normalizeFolder("")` → `""` (root)
- `normalizeFolder("/")` → `""` (root)
- `normalizeFolder("root")` → `""` (root)
- `normalizeFolder("ROOT")` → `""` (case-insensitive)
- `normalizeFolder("work")` → `"work"`
- `normalizeFolder("/work")` → `"work"` (leading slash stripped)
- `normalizeFolder("work/")` → `"work"` (trailing slash stripped)
- `normalizeFolder("work\\sub")` → `"work"` (backslash normalized, depth enforced)
- `normalizeFolder("work/sub/deep")` → `"work"` (depth 1 enforced)
- `normalizeFolder("  work  ")` → `"work"` (trimmed)
- `normalizeFolder("@!#$")` → `""` (all invalid → root)
- `normalizeFolder("  ")` → `""` (whitespace-only → root)
- `normalizeFolder("///")` → `""` (all slashes → root)
- `normalizeFolder("my folder")` → `"my folder"` (spaces allowed)
- `normalizeFolder("root/sub")` → `"root"` (note: "root" only reserved standalone, not as prefix)
- `isValidFolder("work")` → `true`
- `isValidFolder("work/sub")` → `false` (nested not supported v1)
- `isValidFolder("@invalid")` → `false`
- Folder grouping: pure function test with mock session list

## Future (post-phase 2)

- 2-depth folders (e.g., `/work/frontend`)
- Folder rename

## Phase 2: Drag-Drop + Visual Polish

### Visual changes

- Folder header name uses larger typeface (`--text-base` vs `--text-sm`)
- 📁 emoji displayed before the chevron in each folder header
- Folder header: `📁 ▾ name (count) [badge]`

### Drag-drop sessions into folders

Sessions are always draggable (not just in portal mode). Dragging supports two distinct targets:

1. **Folder zones** — drop a session into a folder (or root) within the same Caco instance
2. **Portal transfer** — existing cross-instance drag via postMessage (unchanged, only in portal mode)

#### Drag data

On dragstart, `dataTransfer.setData('text/x-caco-session', sessionId)` is set for all drags. This MIME type distinguishes session drags from file drops (.tar.gz import). Portal transfer additionally sends `postMessage` as before.

#### Drop zones

The session list is restructured into **drop zones**:

- **Root zone** — wraps all root sessions in a `.folder-zone[data-folder=""]`. When no root sessions exist, a thin colored line (`.root-drop-indicator`) renders as a visible drop target so users can drag sessions back to root.
- **Folder zones** — each folder header + its `.folder-content` are wrapped in a `.folder-zone[data-folder="name"]`.

Drop zone event handling:
- `dragover`: Accept only if `dataTransfer.types` includes `text/x-caco-session`. Call `preventDefault()`, set `dropEffect = 'move'`.
- `dragenter/dragleave`: Toggle `.drop-highlight` class with a `dragDepth` counter per zone (nested children fire enter/leave events).
- `drop`: Read sessionId from `dataTransfer`. PATCH `/api/sessions/:id` with `{ folder: targetFolderName }` (empty string for root = `{ folder: "/" }`). On success, `loadSessions()` re-renders. On failure, toast error.

#### Drop highlight

`.folder-zone.drop-highlight` applies a visual preview: dashed accent outline + subtly highlighted background. The highlight covers the entire zone (header + contents when expanded, header-only when collapsed).

#### Edge cases

- **Same-folder drop**: If session is already in the target folder, no-op (skip PATCH, no toast).
- **Collapsed folder drop**: Session drops into the folder without expanding it. Toast confirms the move.
- **Cancel/escape**: All `.drop-highlight` classes removed on `dragend`.
- **.tar.gz file drop**: The existing panel-level drop handler checks for `text/x-caco-session` first — if present, returns early (session drag, not file drop). File drops still trigger import.
- **Portal drag**: Portal mode drags still send `postMessage` for cross-instance transfer. The folder drop zones also activate during portal drags but the portal drop target (in the parent frame) takes priority.

## Risks

1. **MRU snapshot doesn't store folders** — the `session-order.json` is a flat list of IDs. Folder grouping is applied on top of MRU order. If a session changes folder, its MRU position is preserved within the new folder. No snapshot changes needed.

2. **Session panel assumes flat list** — `renderFilteredSessions()` currently iterates `allSessions` linearly. Must be rewritten to handle grouped rendering. This is the main implementation risk.

3. **Busy/unobserved tracking** — `sessionTracker.onChange()` updates individual session items by data-session-id. Folder badge aggregation is a new render concern — must update when any contained session changes state.

4. **Portal drag-drop** — portal transfer creates sessions without folders. New sessions default to root. No conflict.

5. **Search results** — session-search applet shows flat results. Folder info could be shown but isn't required for v1.

## Open Questions

All resolved:

1. **Folder header UX:** Whole row click to expand/collapse.
2. **Moving to root:** Both `/session-folder /` and `/session-folder root` move to root. "root" is reserved and normalized to empty string at load time.
3. **Folder order:** Root first, then folders alphabetically. No MRU for folder ordering.
4. **Collapsed folder + unobserved:** Aggregate badge shown on folder header. No special click behavior on badge — whole row expands.
