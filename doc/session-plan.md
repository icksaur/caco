# Session Manager - Implementation Status

## implementation overview

### SessionManager (`src/session-manager.ts`)
- Singleton owning all SDK interactions
- Discovers sessions from `~/.copilot/session-state/`
- Methods: `init()`, `create()`, `resume()`, `stop()`, `send()`, `getHistory()`, `delete()`, `list()`, `listAllGrouped()`, `getMostRecentForCwd()`, `isActive()`, `isBusy()`, `getSessionCwd()`

### Server Routes (`src/routes/sessions.ts`, `session-messages.ts`)
- `GET /api/session` - Current session info
- `GET /api/sessions` - List all sessions (grouped by cwd)
- `POST /api/sessions` - Create new session
- `POST /api/sessions/:id/resume` - Switch to existing session  
- `DELETE /api/sessions/:id` - Delete session (blocked if busy)
- `GET /api/sessions/:id/state` - Session state for agent-to-agent
- `POST /api/sessions/:id/messages` - Send message
- `POST /api/sessions/:id/cancel` - Cancel streaming

### Frontend (`public/`)
- Hamburger menu → session panel overlay
- Sessions grouped by cwd, sorted by updatedAt
- Busy indicator (throbber) via WebSocket globalEvent
- Delete with confirmation (blocked if busy)
- History loads correctly (filters to user.message/assistant.message)
- Markdown/Mermaid/syntax highlighting on history load

### Model Selection
- Model dropdown in header
- Models fetched from SDK at startup
- Fallback to hardcoded list if SDK unavailable
- Selected model shown in placeholder: "Ask Claude Sonnet 4..."

## improving session-view usefulness

### Current State
- Throbber for busy sessions
- Delete button when not busy
- SDK-provided summary
- Session age appended to summary string
- Sessions grouped by CWD

### Issues
1. **Usage UI broken/hidden** - `GET /api/usage` endpoint exists, `loadUsage()` is called, `#usageInfo` div exists in HTML. Need to verify why it's not displaying.
2. **Age cut off by long summary** - Summary + age are concatenated: `summarySpan.textContent = summary + age`. Long summaries hide age.
3. **Summary strings not helpful** - SDK auto-generates summaries during context compaction. No API to set custom summaries.

### Investigation Results

#### Usage UI
- **Frontend**: `loadUsage()` in `session-panel.ts:220` fetches `/api/usage` and displays in `#usageInfo`
- **Backend**: `GET /api/usage` in `api.ts:76` returns `getUsage()` from `usage-state.ts`
- **Data source**: Usage updated from SDK `assistant.usage` events via `updateUsage()` 
- **Persistence**: Cached to `~/.caco/usage.json`, loaded on startup
- **Issue**: May not receive `assistant.usage` events if no sessions run yet, or the element may be hidden by CSS

#### SDK Summary API
- **Read-only**: `SessionMetadata.summary` returned by `listSessions()` is auto-generated
- **No update API**: SDK has no `updateSummary()` or similar method
- **Source**: Summary generated during `session.compaction_complete` event (`summaryContent` field)
- **Hook option**: `SessionEndHookOutput.sessionSummary` exists but unclear if it persists to metadata

### Tasks

#### Task 1: Fix Usage Display ✅
- [x] Root cause: `toggleSessions()` duplicated `showSessionManager()` logic but missed `loadUsage()`
- [x] Fix: Changed `toggleSessions()` to call `showSessionManager()` 
- [x] Code quality lesson: wrong abstraction / code duplication

#### Task 2: Fix Age Visibility ✅
- [x] Separate spans: summary (ellipsis) + age (fixed right)
- [x] CSS: `.session-item-content` flex wrapper (renamed from `.session-content` to avoid collision)

#### Task 3: Custom Session Names
Since SDK has no summary update API:
- [ ] Create `~/.caco/session-names.json` to store custom names by sessionId
- [ ] Add `PATCH /api/sessions/:id` endpoint to update name
- [ ] Display custom name if set, fall back to SDK summary
- [ ] Add inline edit UI (click to edit, enter to save)

---

## SDK Research: Session Summary API

### Summary Sources

1. **workspace.yaml** - Stored in `~/.copilot/session-state/{id}/workspace.yaml`
   ```yaml
   id: 03b80308-877b-4808-b000-98930a1505a2
   cwd: /home/carl/copilot-web
   summary_count: 0
   created_at: 2026-01-25T22:38:26.437Z
   updated_at: 2026-01-25T22:38:40.669Z
   summary: What model are you?
   ```

2. **session.compaction_complete event** - Contains `summaryContent` field
   - Generated during infinite session context compaction
   - Updates the `summary` in workspace.yaml

3. **SessionEndHookOutput.sessionSummary** - Hook output field
   - Unclear if this persists to workspace.yaml (likely not)

### SDK Methods Investigated

| Method | Exists | Updates Summary |
|--------|--------|-----------------|
| `listSessions()` | ✅ | Returns `summary` (read-only) |
| `deleteSession()` | ✅ | N/A |
| `createSession()` | ✅ | No summary param |
| `resumeSession()` | ✅ | No summary param |
| `setSummary()` | ❌ | Does not exist |
| `updateSession()` | ❌ | Does not exist |

### Conclusion

**SDK provides NO API to update session summary.** The summary is:
- Auto-generated from first user message
- Updated during context compaction (infinite sessions)
- Read-only via `listSessions()`

### Implementation Options for Task 3

**Option A: Modify workspace.yaml directly**
- Pros: Summary shows in SDK's listSessions()
- Cons: SDK may overwrite on compaction, fragile, undocumented behavior

**Option B: Caco-managed session metadata (recommended)**
- Store in `~/.caco/sessions/<sessionId>/meta.json`
- Caco merges with SDK metadata at display time
- SDK summary used as fallback if no custom name
- Pros: Isolated from SDK, survives SDK updates, per-session storage pattern already exists
- Cons: Separate storage layer

**Option C: First-line override in events.jsonl**
- Prepend a custom event type
- Cons: Very hacky, SDK may ignore or break

---

## Task 3: Custom Session Names - Implementation Plan

### Storage Design

File: `~/.caco/sessions/<sessionId>/meta.json`
```json
{
  "name": "Custom Session Name"
}
```

Extends existing storage structure:
```
~/.caco/sessions/<sessionId>/
├── outputs/       # Already exists - display tool outputs (lazy, on first storeOutput)
└── meta.json      # NEW - session metadata (created by ensureSessionMeta)
```

**Creation timing**: `ensureSessionMeta(sessionId)` called from session-manager.ts on create/resume. Separate from `registerSession()` to avoid coupling.

**Display logic**: Frontend decides: `name || summary`. Backend returns both fields separately.

**No summary duplication**: We never store SDK summary in meta.json. SDK summary fetched via `listSessions()`.

### Quality Considerations

| Issue | Severity | Resolution |
|-------|----------|------------|
| registerSession would have two concerns | Medium | Separate `ensureSessionMeta()` function |
| Backend merging display logic | Low | Return `name` and `summary` separately |
| Hidden side effects in registerSession | Medium | Explicit call from session-manager |
| YAGNI on meta.json fields | Low | Accept simple extensible structure |

### Backend Changes

**`src/storage.ts`** - Add functions:
```typescript
export interface SessionMeta {
  name: string;
}

// Helper for session directory path (DRY)
function getSessionDir(sessionId: string): string {
  return join(STORAGE_ROOT, 'sessions', sessionId);
}

export function getSessionMeta(sessionId: string): SessionMeta | undefined {
  const metaPath = join(getSessionDir(sessionId), 'meta.json');
  if (!existsSync(metaPath)) return undefined;
  return JSON.parse(readFileSync(metaPath, 'utf-8'));
}

export function setSessionMeta(sessionId: string, meta: SessionMeta): void {
  const sessionDir = getSessionDir(sessionId);
  ensureDir(sessionDir);
  writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

// Create meta.json if missing - called from session-manager, NOT registerSession
export function ensureSessionMeta(sessionId: string): void {
  const sessionDir = getSessionDir(sessionId);
  ensureDir(sessionDir);
  const metaPath = join(sessionDir, 'meta.json');
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, JSON.stringify({ name: '' }, null, 2));
  }
}
```

**`registerSession()` stays pure** - only manages CWD→sessionId mapping:
```typescript
export function registerSession(cwd: string, sessionId: string): void {
  cwdToSessionId.set(cwd, sessionId);
  // No file I/O here - ensureSessionMeta called separately
}
```

**`src/session-manager.ts`** - Explicit initialization:
```typescript
import { registerSession, ensureSessionMeta } from './storage.js';

// In create():
registerSession(cwd, session.sessionId);
ensureSessionMeta(session.sessionId);

// In resume():
registerSession(cwd, sessionId);
ensureSessionMeta(sessionId);
```

**`src/routes/sessions.ts`** - Add endpoint:
```typescript
// PATCH /api/sessions/:id - Update session metadata
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  setSessionMeta(id, { name: name ?? '' });
  res.json({ success: true });
});
```

**API response** - Return both fields, let frontend merge:
```typescript
// In list endpoint - return raw values
const meta = getSessionMeta(session.id);
return {
  ...session,
  name: meta?.name ?? '',      // Custom name (empty if not set)
  summary: session.summary     // SDK summary (always present)
};
```

### Frontend Changes

**`public/ts/session-panel.ts`** - Session item layout:
```
[throbber?] [.session-item-content: name...  age] [✏️ edit] [× delete]
```

**Display logic in frontend:**
```typescript
// Frontend decides what to show
const displayName = session.name || session.summary;
summarySpan.textContent = displayName;
```

### UI Options Considered

| Option | Complexity | UX |
|--------|------------|-----|
| `window.prompt()` | ~5 lines | Ugly but functional |
| Inline contenteditable | ~20 lines | Native feel, handles Enter/Esc/blur |
| Modal `<dialog>` | ~30 lines | Polished, more UI code |
| Applet navigation | High | Requires view-state management |

**Recommended: `window.prompt()`** - Simplest possible, upgrade later if needed.

### Interface Details

**Session item structure:**
```html
<div class="session-item">
  <span class="throbber" />           <!-- if busy -->
  <div class="session-item-content">
    <span class="summary">...</span>
    <span class="age">2h ago</span>
  </div>
  <button class="edit-btn">✏️</button>   <!-- NEW -->
  <button class="delete-btn">×</button>
</div>
```

**Pencil button handler (using prompt):**
```typescript
editBtn.onclick = async () => {
  const currentName = session.name || session.summary;
  const newName = prompt('Session name:', currentName);
  if (newName !== null) {
    await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    loadSessionList();  // Refresh to show new name
  }
};
```

### Implementation Checklist

Backend:
- [ ] Add `SessionMeta` interface to `src/storage.ts`
- [ ] Add `getSessionDir()` helper (DRY)
- [ ] Add `getSessionMeta()` function
- [ ] Add `setSessionMeta()` function
- [ ] Add `ensureSessionMeta()` function
- [ ] Export `ensureSessionMeta` from storage.ts
- [ ] Call `ensureSessionMeta()` from session-manager.ts create()
- [ ] Call `ensureSessionMeta()` from session-manager.ts resume()
- [ ] Add `PATCH /api/sessions/:id` endpoint
- [ ] Update `GET /api/sessions` to return `name` and `summary` separately

Frontend:
- [ ] Add edit button (✏️) to session items
- [ ] Style edit button (match delete button)
- [ ] Add click handler with `prompt()`
- [ ] Call PATCH endpoint on save
- [ ] Refresh list after save
- [ ] Display `name || summary` (frontend merge)

### Future Enhancements

- Upgrade from `prompt()` to inline edit or modal
- Add more fields to meta.json (tags, color, notes)
- Session search/filter by custom name