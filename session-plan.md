# Session Manager Implementation Plan

## Architecture

```
Express routes (thin)  →  SessionManager (singleton)  →  SDK
       ↑                         ↑
  Parse request            Owns SDK objects
  Format response          One active session per cwd
```

**Simplifications (single identity, not single session):**
- No userId/permissions (all requests are "me")
- Multiple sessions can be active simultaneously
- **One session per cwd** (cwd lock enforced)
- Error thrown if create/resume on locked cwd

## Current State Analysis

**Issues in `server.js`:**
- Global `copilotClient` and `copilotSession` variables
- Single session, single cwd (hardcoded to `process.cwd()`)
- No session lifecycle management

---

## Tasks

### 1. Create SessionManager Module
- [x] `src/session-manager.js` - Singleton class
- [x] Discover existing sessions from `~/.copilot/session-state/`
- [x] Extract `sessionId`, `cwd`, `summary` from disk
- [x] In-memory cwd locks: `Map<cwd, sessionId>`
- [x] Active sessions: `Map<sessionId, { cwd, session, client }>`

### 2. SessionManager Methods
- [x] All methods implemented:
  - `init()`, `create()`, `resume()`, `stop()`, `send()`
  - `getHistory()`, `delete()`, `list()`, `listByCwd()`
  - `getMostRecentForCwd()`, `getActive()`, `isActive()`

### 3. Refactor server.js
- [x] Import SessionManager singleton
- [x] Remove global `copilotClient`/`copilotSession`
- [x] On startup: `init()` then auto-resume most recent for `process.cwd()`
- [x] Route handlers use active session for cwd
- [x] New endpoints: `/api/session`, `/api/history`, `/api/sessions`

### 4. Minimal Frontend Update (v1)
- [x] On page load, fetch conversation history for active session
- [x] **FIXED:** History now displays correctly
  - SDK `getMessages()` returns events, not chat messages
  - Filter to `user.message` and `assistant.message` types
  - Content is in `event.data.content`
  - Skip empty content (tool-call messages have no text)
- [x] Send new messages as before
- [x] Fix: call `renderMarkdown()` after loading history (was `renderMarkdownMessages`)
- [ ] Session switcher UI (hamburger menu stub added)

### 5. Testing
- [ ] Create → send → stop cycle
- [x] Resume existing session, history loads
- [x] Markdown rendering works on loaded history
- [ ] Cwd lock: error on second create/resume for same cwd
- [ ] Stop releases lock, allows new session
- [ ] Error: send to non-active session

### 6. Cleanup
- [ ] Remove debug endpoint `/api/debug/messages` before merge
