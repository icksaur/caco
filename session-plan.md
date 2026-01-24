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

---

## 🔄 In Progress

### Model Selection
Add UI to select model before/between messages.

**SDK API:**
- `client.listModels()` → `ModelInfo[]`
- `ModelInfo`: `{ id, name, capabilities, policy?, billing? }`
- `billing.multiplier` = cost multiplier (0.33, 1, 3, etc.)
- `createSession({ model: "claude-sonnet-4.5" })` or `resumeSession(id, { model })`
- `session.model_change` event fires on model change

**UI Options (pick one):**
1. **Dropdown in input area** - Select before each message
2. **Model strip below hamburger** - Always visible, tap to cycle
3. **Long-press send button** - Pop up model picker

**Implementation:**
- [ ] Add `GET /api/models` endpoint → `listModels()`
- [ ] Cache models on page load
- [ ] Show model name in placeholder: "Ask Claude Sonnet 4.5..."
- [ ] Add model selector UI
- [ ] Pass `model` to send endpoint, forward to session

---

## 📋 TODO

### New Session Experience
- [ ] "New chat" button in session panel
- [ ] Creates session for process.cwd() (stops current if needed)
- [ ] Focus input after creation

### Testing
- [ ] Cwd lock: error on second resume for same cwd
- [ ] Stop releases lock
- [ ] Model selection persists across messages

### Cleanup
- [ ] Remove `/api/debug/messages` if present
