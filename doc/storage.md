# Storage Design

Storage for session-specific data and persistent applets.

---

## Problem

| What | Current State | Problem |
|------|---------------|---------|
| Chat history | SDK stores in `~/.copilot/session-state/` | Works |
| Display tool outputs | In-memory cache with 30min TTL | Lost on session reload |
| Applet content | Not implemented | Needs full persistence |
| Applet state | Not implemented | User data between sessions |

---

## Goals

1. **Session-correlated storage**: Outputs tied to specific messages/turns
2. **Applet persistence**: Save/load applet HTML/JS/CSS
3. **Applet runtime state**: CRUD storage for applet data
4. **Portable**: Git-friendly and human-readable

---

## Architecture

### Storage Root

| Concept | Value | Purpose |
|---------|-------|---------|
| **Program CWD** | Where Node process runs | Fixed at startup |
| **Session CWD** | Per-session working directory | Where Copilot runs commands |

**Decision**: Storage root = `~/.caco/`

```
~/.caco/
├── sessions/
│   └── <sessionId>/
│       ├── outputs.json       # Map of outputId → metadata
│       └── outputs/           # Text, JSON, base64 outputs
│
└── applets/
    └── <applet-slug>/
        ├── meta.json          # Name, description, timestamps
        ├── content.html
        ├── script.js
        ├── style.css
        └── state.json         # Runtime state
```

### Tool Factory

Tools need sessionId to store outputs. SDK needs tools at session creation, but sessionId comes from SDK.

**Solution**: Tools receive session CWD in closure. Session CWD → sessionId mapping via `cwdLocks` in session-manager.

### Output Correlation

Display tools inject `[output:xxx]` markers in tool result text. On session reload, message history is scanned for markers to restore outputs.

### Applet Lifecycle

1. Agent calls `set_applet()` → content sent to client via WebSocket
2. Optionally: agent calls `save_applet(slug)` → persisted to disk
3. User requests saved applet → `load_applet(slug)` → client renders

### Security

| Risk | Mitigation |
|------|------------|
| Path traversal | Validate paths, restrict to cwd subtree |
| Sensitive files | Block patterns: `.env`, `.git/config`, `*_key`, `*.pem` |
| Arbitrary write | Restrict to `~/.caco/` directory |
| Symlink escape | Resolve real path, validate still in allowed tree |