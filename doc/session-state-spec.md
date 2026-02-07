# Session State & Schedule UI - Design Considerations

## Goal

Easy to quickly review busy or idle-but-unobserved sessions. User running multiple sessions wants to quickly find completed sessions and review busy ones.

## Current Architecture

### Session State Sources

| Source | Location | Data |
|--------|----------|------|
| SDK | `~/.copilot/session-state/<id>/workspace.yaml` | cwd, summary, updatedAt |
| Caco meta | `~/.caco/sessions/<id>/meta.json` | custom name only |
| Runtime | `busyTracker` (in-memory Set) | isBusy flag |
| Schedule | `~/.caco/schedule/<slug>/` | definition.json, last-run.json |

### WebSocket Events for Live Updates

Currently: `session.busy` event updates session item state in DOM.

### Session List API

`GET /api/sessions` returns:
```json
{
  "grouped": { "/cwd": [{ sessionId, summary, updatedAt, isBusy, name }] },
  "models": [...]
}
```

## New State: "Unobserved"

### Definition

Session is **unobserved** when:
1. Session completed work (`session.idle` received) AND
2. User has not viewed that session since idle

### State Transitions

```
busy → idle: session becomes "unobserved" 
             (unless currently viewing it)
user clicks session: session becomes "observed"
user is viewing when idle: stays observed
```

### Storage Options

**Option A: Extend SessionMeta**
```json
// ~/.caco/sessions/<id>/meta.json
{
  "name": "...",
  "lastObservedAt": "2026-02-05T12:00:00Z"
}
```
Compare `lastObservedAt` vs SDK's `updatedAt` - if updated > observed, unobserved.

**Option B: Separate unobserved.json**
```json
// ~/.caco/unobserved.json
{
  "sessions": ["id1", "id2"]
}
```
Add to set on idle, remove on view.

**Recommendation**: Option A. Already have meta.json per session, adds one field. Allows O(1) check per session, no global file lock contention.

### Server-Side Changes

1. **On `session.idle`**: Update `lastIdleAt` in meta.json
2. **On session view**: Update `lastObservedAt` in meta.json  
3. **API response**: Add `isUnobserved: boolean` computed field

```typescript
// In routes/sessions.ts or session-manager.ts
function isUnobserved(sessionId: string): boolean {
  const meta = getSessionMeta(sessionId);
  const sdk = getSdkMeta(sessionId); // updatedAt
  if (!meta?.lastObservedAt) return true; // Never observed
  return new Date(sdk.updatedAt) > new Date(meta.lastObservedAt);
}
```

### API for Marking Observed

**Correct behavior**: Session is marked observed when:

1. **Live streaming ends**: User is viewing session AND `session.idle` event arrives
2. **History loaded**: User switches to an unobserved session AND `historyComplete` event arrives

Both scenarios indicate the user has "seen" the session content.

**Terminal events for observation** (trigger markSessionObserved):
- `session.idle` - Normal completion during live streaming
- `historyComplete` - History finished loading (session switch/reload)

**NOT observed** (error states or partial loads):
- `session.error` - Error during processing (may retry, user should check later)
- Streaming in progress (session.busy)
- Resume without history load

**Implementation**: 
- Client sends `POST /api/sessions/:id/observe` when terminal event received for active session
- Both `session.idle` and `historyComplete` are terminal observation events
- `session.error` is a terminal event (re-enables form) but does NOT mark observed

### Multi-Client Sync

When user views session on one tab, other tabs should update.

**WebSocket events include count**: Events now include `unobservedCount` for direct badge update:
```json
{ "type": "session.observed", "data": { "sessionId": "...", "unobservedCount": 2 } }
{ "type": "session.idle", "data": { "sessionId": "...", "unobservedCount": 3 } }
```

**Sync behavior**:
- Client A observes session → broadcasts `session.observed` with updated count
- Client B receives event → updates badge to new count, removes unobserved indicator
- No refetch needed - count comes from single source of truth (UnobservedTracker)

**Per-client busy indicator**:
- Each client tracks which session it is viewing
- Busy badge on menu button only shows if OTHER sessions are busy
- If Client A views busy session X, Client A sees no busy badge
- If Client B views idle session Y while X is busy, Client B sees busy badge

## Session List UI Changes

### Sorting & Layout

**No CWD grouping** - sessions displayed as flat MRU list.

**Sessions without CWD are omitted** - these are likely incomplete or corrupted sessions.

**Sort order**: `updatedAt` descending (most recently updated first).

**Each session item** shows:
- State indicator (busy cursor, unobserved dot, or none)
- Session summary/name
- Age (e.g., "2m ago")
- CWD path below (small text)

```
┌────────────────────────────────────────────────────┐
│ ▌ Analyzing code...                    2m ago     │
│   /home/carl/project-a                            │  ← cwd below
├────────────────────────────────────────────────────┤
│ ● Refactored auth module               5m ago     │
│   /home/carl/project-b                            │
├────────────────────────────────────────────────────┤
│   Fixed login bug                      1h ago     │
│   /home/carl/project-a                            │
└────────────────────────────────────────────────────┘
```

### Visual Indicators

#### Menu Button Badge (Priority Order)

1. **Unobserved sessions exist**: Solid red circle with count (e.g., "3")
2. **ELSE IF other busy sessions exist**: Blinking colorful cursor (matching chat streaming cursor)
3. **Otherwise**: No badge

**Important**: The busy indicator only shows for sessions OTHER than the one currently being viewed. If the user is viewing a busy session, they already see the streaming cursor in the chat - no need for redundant badge.

```
┌──────┐      ┌──────┐      ┌──────┐
│ ☰  3 │  OR  │ ☰  ▌│  OR  │ ☰    │
└──────┘      └──────┘      └──────┘
 unobserved    busy (other)  all idle
```

#### Session List Items

| State | Indicator |
|-------|-----------|
| Busy | Blinking colorful cursor + accent left border |
| Unobserved | Red dot + red left border |
| Active (current) | Blue border (existing) |

### Badge on Menu Button

Show count of unobserved sessions on hamburger menu button.

```html
<button class="menu-btn">
  <span class="badge">3</span>
  <!-- hamburger lines -->
</button>
```

## Intent Display for Busy Sessions

### Problem

When session is busy, user wants to know what it's doing.

### Solution

Capture `report_intent` tool result or `assistant.intent` event, store in meta.

```json
// ~/.caco/sessions/<id>/meta.json
{
  "name": "...",
  "lastObservedAt": "...",
  "currentIntent": "Analyzing git commits for standup"
}
```

### WebSocket Events

Add `session.intent` event:
```json
{
  "type": "session.intent",
  "data": { "sessionId": "...", "intent": "Analyzing git commits..." }
}
```

Client updates session item's subtitle in real-time.

### UI Layout

```
┌────────────────────────────────────────────────────┐
│ ⏳ Analyzing git commits for standup    5m ago    │
│    [Custom name or SDK summary]                   │
└────────────────────────────────────────────────────┘
```

First line: intent (if busy) or last intent (if idle/unobserved)
Second line: session name/summary (truncated)

## Schedule Integration

### Current State

- Schedule system implemented (`schedule-manager.ts`, `schedule-store.ts`)
- API endpoints exist (`/api/schedule/*`)
- Jobs applet exists but untested
- No built-in UI in session view

### Session View Integration

**Option A: Separate schedules section**
```
┌─────────────────────────────────────────────────┐
│ + New Chat                                      │
├─────────────────────────────────────────────────┤
│ SCHEDULES                                       │
│  daily-standup     next: 9:00 AM    ✓ enabled  │
│  nightly-backup    next: 2:00 AM    ○ disabled │
├─────────────────────────────────────────────────┤
│ /home/carl/project (current)                    │
│  [sessions...]                                  │
└─────────────────────────────────────────────────┘
```

**Option B: Schedules as special sessions**
Scheduled sessions appear in session list with schedule icon.

**Recommendation**: Option A. Schedules are configuration, not conversations. Keep separate but visible.

### Empty State

If no schedules:
```
SCHEDULES
  No scheduled tasks. Add with /api/schedule API.
```

Or hide section entirely until first schedule created.

### Schedule Item Actions

- Click: Show schedule details (cron, last run, prompt preview)
- Toggle: Enable/disable inline
- Edit: Not in v1 (use API)

## Data Flow Summary

### Session State Events

```
session.busy   → Update session item, add throbber
session.idle   → Update session item, remove throbber, 
                 mark unobserved (if not currently viewing)
session.intent → Update session item subtitle
session.observed → Remove unobserved indicator, decrement badge
```

### Single Point of Entry for Observed

```typescript
// storage.ts
export function markSessionObserved(sessionId: string): void {
  // 1. Update meta.json lastObservedAt
  // 2. (Caller broadcasts 'session.observed' via WebSocket)
}

// Called from:
// - POST /api/sessions/:id/observe (when client sees session.idle for active session)
// NOT called from:
// - POST /api/sessions/:id/resume (just loading, user hasn't seen new content)
// - When user clicks session in list (same as resume)
```

### API Changes

**`GET /api/sessions`** - Add fields:
```json
{
  "grouped": {
    "/cwd": [{
      "sessionId": "...",
      "isUnobserved": true,
      "currentIntent": "..."
    }]
  },
  "unobservedCount": 3,
  "schedules": [{
    "slug": "daily-standup",
    "nextRun": "...",
    "enabled": true
  }]
}
```

**`POST /api/sessions/:id/observe`** - Explicit endpoint (required, not optional)

## Implementation Status

### Phase 1: Unobserved State ✅ Complete

| File | Status | Notes |
|------|--------|-------|
| `src/unobserved-tracker.ts` | ✅ | **NEW** - Single source of truth for unobserved state |
| `src/storage.ts` | ✅ | Extended `SessionMeta`, low-level persistence |
| `src/routes/session-messages.ts` | ✅ | Calls `unobservedTracker.markIdle()` on `session.idle` event |
| `src/routes/sessions.ts` | ✅ | Uses `unobservedTracker.getCount()` and `unobservedTracker.markObserved()` |
| `src/session-manager.ts` | ✅ | Hydrates tracker on init, uses `unobservedTracker.isUnobserved()` |
| `src/routes/websocket.ts` | ✅ | Wires up tracker broadcast function |
| `tests/unit/unobserved-tracker.test.ts` | ✅ | **NEW** - 20 unit tests for tracker |

### Phase 2: Session List UI ✅ Complete

| File | Status | Notes |
|------|--------|-------|
| `public/ts/session-panel.ts` | ✅ | Badge from event data (no refetch), excludes active session from busy badge |
| `public/ts/session-observed.ts` | ✅ | Client calls `/observe` on session.idle |
| `public/ts/message-streaming.ts` | ✅ | Calls `markSessionObserved()` when idle arrives |
| `public/ts/types.ts` | ✅ | Extended `SessionData` with `isUnobserved`, `currentIntent` |
| `public/index.html` | ✅ | Added badge/indicator elements to menu button |
| `public/style.css` | ✅ | Colorful gradient cursor for busy, red for unobserved |

### Phase 3: Intent Display ⏳ Partial

| File | Status | Notes |
|------|--------|-------|
| Intent storage | ✅ | `setSessionIntent()` in storage.ts |
| Intent display | ⏳ | Field exists but not prominently displayed |

### Phase 4: Schedule Integration ✅ Complete

| File | Status | Notes |
|------|--------|-------|
| Schedule info in API | ✅ | `scheduleSlug`, `scheduleNextRun` in session response |
| Schedule badge in UI | ✅ | 📅 badge shown on scheduled sessions |
| Dedicated schedules section | ✅ | Header, list, empty state, enable/disable toggle |
| `public/ts/session-panel.ts` | ✅ | `loadSchedules()` fetches and renders schedules |
| `public/index.html` | ✅ | Added `#schedulesSection` with header and list container |
| `public/style.css` | ✅ | Styles for schedules section matching session list |

## Implementation Phases

### Pre-Implementation Refactoring

**Code quality review (per code-quality.md):**

1. **SessionMeta interface** - Currently only has `name: string`. Extend cleanly:
   - Add optional fields for backward compatibility
   - Existing `getSessionMeta`/`setSessionMeta` already tested
   
2. **Single point of entry** - Create `markSessionObserved()` function in storage.ts
   - Avoid duplication across routes
   - One place to add WebSocket broadcast later

3. **Data flow verification**:
   - `session.idle` event already handled in `session-messages.ts:266`
   - `session.busy` broadcast already exists at line 275
   - Add `session.idle` meta update in same location (co-located, not scattered)

**90% of requirement with 10% of code:**
- Phase 1 is pure data layer (no UI changes)
- Existing SessionMeta storage pattern used
- Existing WebSocket broadcast pattern used

### Phase 1: Unobserved State (foundation)

**Files to modify:**
- `src/storage.ts` - Extend `SessionMeta` interface, add `markSessionObserved()`
- `src/routes/session-messages.ts` - Call storage on `session.idle`
- `src/session-manager.ts` - Call `markSessionObserved()` on resume
- `src/routes/sessions.ts` - Compute `isUnobserved` in response
- `tests/unit/storage.test.ts` - Add tests for new meta fields

**Steps:**
1. Extend `SessionMeta` with `lastObservedAt?: string`, `lastIdleAt?: string`, `currentIntent?: string`
2. Add `markSessionObserved(sessionId)` in storage.ts (updates lastObservedAt)
3. Add `markSessionIdle(sessionId)` in storage.ts (updates lastIdleAt)
4. In `session-messages.ts`, on `session.idle`: call `markSessionIdle()`
5. In `routes/sessions.ts`, add `POST /sessions/:id/observe` endpoint that calls `markSessionObserved()` and broadcasts `session.observed`
6. In `routes/sessions.ts`, add `isUnobserved` computed field to response
7. Client calls `/observe` endpoint when `session.idle` arrives for active session
8. Unit tests for new storage functions

### Phase 2: Session List UI

**Files to modify:**
- `public/ts/session-panel.ts` - Sort by state, add unobserved indicator
- `public/ts/types.ts` - Extend `SessionData` interface
- `public/index.html` - Add badge element to menu button
- `public/style.css` - Badge and unobserved indicator styles
- `public/ts/websocket.ts` - Subscribe to `session.observed` event

**Steps:**
1. Extend `SessionData` type with `isUnobserved`, `currentIntent`
2. Update `loadSessions()` to read new fields
3. Sort sessions: busy → unobserved → observed (within cwd groups)
4. Add `.unobserved` class and CSS (dot badge or background tint)
5. Add badge HTML to menu button
6. Update badge count from `unobservedCount` in API response
7. Subscribe to `session.observed` event, update DOM accordingly

### Phase 3: Intent Display

**Files to modify:**
- `src/routes/session-messages.ts` - Capture intent on `report_intent` tool
- `src/storage.ts` - Store intent in meta
- `src/routes/websocket.ts` - Emit `session.intent` event
- `public/ts/session-panel.ts` - Display intent subtitle

**Steps:**
1. In `session-messages.ts`, detect `tool.execution_complete` for `report_intent`
2. Extract intent text, call `setSessionIntent(sessionId, intent)`
3. Broadcast `session.intent` WebSocket event
4. Client subscribes, updates session item subtitle in real-time
5. Show intent in session list items (first line if busy, second line if idle)

### Phase 4: Schedule Integration

**Files to modify:**
- `src/routes/sessions.ts` - Include schedules in response
- `public/ts/session-panel.ts` - Render schedules section
- `public/index.html` - Add schedules container in session view
- `public/style.css` - Schedule item styles

**Steps:**
1. Import schedule store, add `schedules` array to `/api/sessions` response
2. Add schedules section HTML (below New Chat, above session groups)
3. Render schedule items with slug, next run, enabled toggle
4. Wire toggle to `PUT /api/schedule/:slug` (enable/disable)
5. Handle empty state (hide section or show placeholder)

## Open Questions (Resolved)

1. **Badge persistence**: Yes, based on meta.json timestamps (computed on each load)
2. **Clear all observed**: Defer. Individual clicks sufficient for v1.
3. **Schedule creation UI**: Defer. API-only for v1.
4. **Intent for non-busy sessions**: Yes, show last intent to help understand what session did.
5. **MRU vs grouped by cwd**: Flat MRU list, no grouping. CWD shown below each session item.

## Code Quality: Single Source of Truth

### Current Issues (Post-Implementation Review)

The current implementation has reliability and testability concerns:

**1. State computed on-demand**
- `isSessionUnobserved()` compares `lastIdleAt > lastObservedAt` each call
- No cached count - must iterate all sessions to get unobservedCount
- Multiple file reads per API call

**2. Multiple entry points for mutations**
```
markSessionIdle()   ← called from session-messages.ts
markSessionObserved() ← called from sessions.ts route
isSessionUnobserved() ← computed, not tracked
```

**3. Client must re-fetch to sync**
- After `session.busy` event, client calls `fetchAndUpdateBadgeCount()`
- Full GET /api/sessions just to get count
- Wasteful, fragile (network errors leave badge stale)

**4. Hard to unit test**
- Count logic in route handler (loops over sessions)
- No single function to test "when A happens, count becomes X"

### Proposed Refactoring: UnobservedTracker Class

Create a single class that owns the unobserved state:

```typescript
// src/unobserved-tracker.ts
class UnobservedTracker {
  private unobservedSet: Set<string> = new Set();
  
  constructor() {
    // Load from meta.json files on startup
    this.rehydrateFromStorage();
  }
  
  /**
   * Called when session goes idle
   * @returns true if session became unobserved (wasn't already)
   */
  markIdle(sessionId: string): boolean {
    if (this.unobservedSet.has(sessionId)) return false;
    this.unobservedSet.add(sessionId);
    this.persistToMeta(sessionId, 'idle');
    return true;
  }
  
  /**
   * Called when user observes session
   * @returns true if session was unobserved (count decremented)
   */
  markObserved(sessionId: string): boolean {
    if (!this.unobservedSet.has(sessionId)) return false;
    this.unobservedSet.delete(sessionId);
    this.persistToMeta(sessionId, 'observed');
    return true;
  }
  
  /** O(1) count */
  getCount(): number {
    return this.unobservedSet.size;
  }
  
  /** O(1) check */
  isUnobserved(sessionId: string): boolean {
    return this.unobservedSet.has(sessionId);
  }
  
  /** Remove session from tracking (on delete) */
  remove(sessionId: string): void {
    this.unobservedSet.delete(sessionId);
  }
}

export const unobservedTracker = new UnobservedTracker();
```

### Benefits

1. **Single source of truth** - all mutations go through one class
2. **O(1) count and check** - no iteration needed
3. **Memory-backed with file persistence** - fast reads, durable writes
4. **Easy to unit test**:
   ```typescript
   test('markIdle increments count', () => {
     const tracker = new UnobservedTracker();
     expect(tracker.getCount()).toBe(0);
     tracker.markIdle('sess1');
     expect(tracker.getCount()).toBe(1);
     expect(tracker.isUnobserved('sess1')).toBe(true);
   });
   
   test('markObserved decrements count', () => {
     const tracker = new UnobservedTracker();
     tracker.markIdle('sess1');
     tracker.markObserved('sess1');
     expect(tracker.getCount()).toBe(0);
   });
   
   test('double markIdle is idempotent', () => {
     const tracker = new UnobservedTracker();
     tracker.markIdle('sess1');
     tracker.markIdle('sess1');
     expect(tracker.getCount()).toBe(1);
   });
   ```
5. **WebSocket events include count** - client doesn't need to refetch:
   ```json
   { "type": "session.observed", "data": { "sessionId": "...", "unobservedCount": 2 } }
   ```

### Migration Path ✅ Complete

1. ✅ Create `UnobservedTracker` class (`src/unobserved-tracker.ts`)
2. ✅ On startup, hydrate from existing meta.json files (in `session-manager.ts init()`)
3. ✅ Replace `markSessionIdle/markSessionObserved` calls with tracker methods
4. ✅ Include `unobservedCount` in WebSocket events (`session.idle`, `session.observed`)
5. ✅ Remove client-side `fetchAndUpdateBadgeCount()` - update badge from event data
6. ✅ Add unit tests for tracker (20 tests in `tests/unit/unobserved-tracker.test.ts`)

### Sync Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     UnobservedTracker                           │
│  ┌─────────────────┐   ┌─────────────────┐   ┌──────────────┐  │
│  │ Memory: Set<id> │ ← │ markIdle()      │ ← │ session.idle │  │
│  │                 │   │ markObserved()  │   │ /observe API │  │
│  └────────┬────────┘   └────────┬────────┘   └──────────────┘  │
│           │                     │                               │
│           │ persist             │ broadcast                     │
│           ▼                     ▼                               │
│  ┌─────────────────┐   ┌─────────────────────────────────────┐  │
│  │ meta.json files │   │ WebSocket { type, sessionId, count }│  │
│  │ (lastIdleAt,    │   │ → All clients update badge directly │  │
│  │  lastObservedAt)│   └─────────────────────────────────────┘  │
│  └─────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
```

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Meta.json write contention | Already atomic per-session, no shared files |
| Stale badge after server restart | Badge derived from meta.json, not in-memory |
| Intent too long | Truncate to ~60 chars in UI (CSS text-overflow) |
| Too many unobserved after vacation | Consider "dismiss all" in future phase |
| Breaking existing meta.json | New fields are optional, getSessionMeta handles gracefully |
| Test coverage gaps | Add unit tests for new storage functions in Phase 1 |
| WebSocket event not received | Client already handles disconnect/reconnect, reloads on reconnect |

## Data Flow Diagram

```
User sends message → session.busy broadcast
                   → markBusy(sessionId)

Agent processes   → tool events, deltas

Agent completes   → session.idle event
                   → markSessionIdle(sessionId) [writes lastIdleAt]
                   → if (user not viewing session) → isUnobserved = true
                   → markIdle(sessionId)
                   → session.busy { isBusy: false } broadcast

User clicks session → POST /sessions/:id/resume
                    → Load history, show chat
                    → (session may still be unobserved)

Session goes idle   → session.idle event
WHILE user viewing  → Client calls POST /sessions/:id/observe
                    → markSessionObserved(sessionId) [writes lastObservedAt]
                    → session.observed broadcast
                    → All clients decrement badge, remove indicator
```
