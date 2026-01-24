# Session Manager - Implementation Status

## ✅ Completed

### SessionManager (`src/session-manager.js`)
- Singleton owning all SDK interactions
- Discovers sessions from `~/.copilot/session-state/`
- Cwd locks: one session per cwd, error if locked
- Methods: `init()`, `create()`, `resume()`, `stop()`, `send()`, `getHistory()`, `delete()`, `list()`, `listAllGrouped()`, `getMostRecentForCwd()`

### Server (`server.js`)
- Uses SessionManager singleton
- Auto-resumes most recent session for `process.cwd()` on startup
- Endpoints: `GET /api/session`, `GET /api/history`, `GET /api/sessions`, `POST /api/sessions/:id/resume`, `POST /api/sessions/new`, `DELETE /api/sessions/:id`

### Frontend (`public/`)
- Hamburger menu → session panel
- Sessions grouped by cwd, sorted by age
- Delete with confirmation
- History loads correctly (filters SDK events to user.message/assistant.message)
- Markdown/Mermaid/syntax highlighting on history load

### Model Selection
- Blue hamburger button (next to Send) opens model panel
- Curated list of 9 models with cost indicators (free/0.33x/1x/3x)
- Selected model shown in placeholder: "Ask Claude Sonnet 4..."
- Model passed to send endpoint → session

---

## 🔄 In Progress

### New Session Experience
Create new session with user-specified cwd (not just `process.cwd()`).

**Chosen: Option 2 - Inline in Session Panel**

"+ New Chat" button at top of session panel:
- Clicking expands to show path input (pre-filled with `process.cwd()`)
- "Create" button validates path and creates session
- On success: closes panel, clears chat, focuses input
- On error: shows inline error message

**Implementation:**
- [x] Add expandable "+ New Chat" form at top of session list
- [x] Pre-fill path with currentCwd from `/api/sessions`
- [x] "Create" button → `POST /api/sessions/new` with `{ cwd }`
- [x] Server validates path exists before creating session
- [x] On success: reload page to start fresh session

---

## 📋 TODO

### Testing
- [ ] Cwd lock: error on second resume for same cwd
- [ ] Stop releases lock
- [ ] Model selection persists across messages

### Cleanup
- [ ] Remove `/api/debug/messages` if present
