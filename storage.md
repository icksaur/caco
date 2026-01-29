# Storage Design

Storage for session-specific data and persistent applets.

---

## Problem

Current gaps in persistence:

| What | Current State | Problem |
|------|---------------|---------|
| Chat history | SDK stores in `~/.copilot/session-state/` | ✓ Works |
| Display tool outputs | In-memory cache with 30min TTL | Lost on session reload |
| Applet content | Not implemented | Needs full persistence |
| Applet state | Not implemented | User data between sessions |

**Display tools affected:**
- `render_file_contents` — file content shown to user
- `run_and_display` — terminal output
- `display_image` — base64 images
- `embed_media` — oEmbed content (YouTube, etc.)

These prepend content to responses. On session reload, SDK returns message history but our injected outputs are gone.

---

## Goals

1. **Session-correlated storage**: Outputs tied to specific messages/turns
2. **Applet persistence**: Save/load applet HTML/JS/CSS
3. **Applet runtime state**: CRUD storage for applet data (form inputs, etc.)
4. **Portable**: Storage should be git-friendly and human-readable

---

## Architecture

### Storage Root

**Two CWD concepts:**

| Concept | Value | Purpose |
|---------|-------|---------|
| **Program CWD** | Where Node process runs (e.g., `/home/user/Caco`) | Fixed at startup, where app lives |
| **Session CWD** | Per-session working directory (e.g., `/home/user/my-project`) | Where Copilot runs commands, has lock |

**Decision**: Storage root = **Program CWD** (`process.cwd()/.Caco/`)

Rationale:
- Centralized, predictable location
- Survives session CWD changes
- Easy to backup/gitignore
- Outputs keyed by sessionId (unique across all sessions)

```
<program-cwd>/.Caco/
├── sessions/
│   └── <sessionId>/
│       ├── outputs.json       # Map of outputId → metadata
│       └── outputs/
│           ├── out_123.txt    # Text outputs
│           ├── out_456.json   # Structured data
│           └── out_789.b64    # Binary (base64)
│
└── applets/
    ├── _index.json            # Manifest of saved applets
    └── <applet-slug>/
        ├── meta.json          # { name, description, created, updated }
        ├── content.html
        ├── script.js
        ├── style.css
        └── state.json         # Runtime state (form data, etc.)
```

### Tool Factory

Tools need sessionId to store outputs. Problem: SDK needs tools at session creation, but sessionId comes from SDK.

**Solution**: Tools receive session CWD in closure. Session CWD → sessionId mapping available via `cwdLocks` in session-manager (enforced unique).

```typescript
// server.ts
const toolFactory = (sessionCwd: string) => createDisplayTools(
  (data, meta) => storeOutput(sessionCwd, data, meta),
  detectLanguage
);

// session-manager.ts create()
const tools = options.toolFactory(cwd);
const session = await client.createSession({ ..., tools });
// Later: storage layer resolves sessionCwd → sessionId via cwdLocks
```

---

## Session Output Storage

### Correlation Strategy

**Problem**: How do we associate stored outputs with messages in the chat history?

**SDK message structure** (from `session.getMessages()`):
```typescript
interface SessionEvent {
  type: string;  // 'text', 'tool_use', 'tool_result', etc.
  data?: Record<string, unknown>;
  // No guaranteed unique messageId across reloads
}
```

**Options:**

| Approach | Description | Pros | Cons |
|----------|-------------|------|------|
| Turn index | Store with turn number (0, 1, 2...) | Simple | Fragile if history edited |
| Content hash | Hash of message content | Stable | Complex, collisions |
| Inject marker | Put outputId in tool result text | SDK stores it for us | Implicit contract |

**Decision**: Inject marker in tool result

Display tools already return text like:
```
"Displayed /path/to/file to user (lines 1-50)"
```

Change to include outputId:
```
"[output:out_123] Displayed /path/to/file to user (lines 1-50)"
```

On reload, we scan message history for `[output:xxx]` markers and load corresponding data.

### Output Storage API

```typescript
interface OutputStore {
  // Store output, return ID
  store(sessionId: string, data: string | Buffer, metadata: OutputMetadata): string;
  
  // Retrieve output
  get(sessionId: string, outputId: string): StoredOutput | null;
  
  // List all outputs for session
  list(sessionId: string): OutputMetadata[];
  
  // Cleanup old sessions
  prune(maxAge: number): void;
}

interface OutputMetadata {
  type: 'file' | 'terminal' | 'image' | 'embed' | 'raw';
  createdAt: string;
  path?: string;
  command?: string;
  highlight?: string;
  mimeType?: string;
  [key: string]: unknown;
}
```

### Migration from In-Memory Cache

Current `output-cache.ts`:
```typescript
const displayOutputs = new Map<string, CacheEntry>();
// 30 minute TTL, lost on restart
```

New flow:
1. On tool execution: write to disk, return ID
2. On GET `/api/outputs/:id`: read from disk (with memory cache)
3. On session reload: parse markers from history, preload outputs

---

## Applet Storage

### Applet Lifecycle

```
Agent calls set_applet() 
    → Content sent to client via SSE
    → Client renders in #appletView
    → Optionally: agent calls save_applet(slug)
    → Persisted to disk
    
User requests saved applet
    → load_applet(slug)
    → Returns { html, js, css }
    → Client renders
```

### Applet Storage API

```typescript
interface AppletStore {
  // Save applet content
  save(cwd: string, slug: string, content: AppletContent): void;
  
  // Load applet
  load(cwd: string, slug: string): AppletContent | null;
  
  // List saved applets
  list(cwd: string): AppletMeta[];
  
  // Delete applet
  delete(cwd: string, slug: string): boolean;
  
  // Runtime state CRUD
  getState(cwd: string, slug: string): Record<string, unknown>;
  setState(cwd: string, slug: string, state: Record<string, unknown>): void;
}

interface AppletContent {
  html: string;
  js?: string;
  css?: string;
}

interface AppletMeta {
  slug: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}
```

### Applet MCP Tools

```typescript
// Save current applet to disk
defineTool('save_applet', {
  parameters: z.object({
    slug: z.string().describe('URL-safe identifier'),
    name: z.string().describe('Human-readable name'),
    description: z.string().optional()
  }),
  handler: async ({ slug, name, description }) => {
    // Get current applet content from client state
    // Save to disk
    return `Applet saved as "${name}"`;
  }
});

// Load applet from disk
defineTool('load_applet', {
  parameters: z.object({
    slug: z.string()
  }),
  handler: async ({ slug }) => {
    const content = appletStore.load(cwd, slug);
    // Send to client via SSE
    return `Loaded applet "${slug}"`;
  }
});

// List available applets
defineTool('list_applets', {
  parameters: z.object({}),
  handler: async () => {
    const applets = appletStore.list(cwd);
    return applets.map(a => `${a.slug}: ${a.name}`).join('\n');
  }
});
```

---

## HTTP Endpoints

For applet runtime file/state access:

```
GET  /api/storage/file?path=<abs>       → { content, encoding }
POST /api/storage/file?path=<abs>       ← { content }
GET  /api/storage/list?path=<abs>       → { files: [{name, type, size}] }

GET  /api/storage/applet/:slug          → { html, js, css, state }
POST /api/storage/applet/:slug/state    ← { state }
GET  /api/storage/applets               → [{ slug, name, description }]
```

### Security

| Risk | Mitigation |
|------|------------|
| Path traversal | Validate paths, restrict to cwd subtree |
| Sensitive files | Block patterns: `.env`, `.git/config`, `*_key`, `*.pem` |
| Arbitrary write | Restrict to `.Caco/` directory |
| Symlink escape | Resolve real path, validate still in allowed tree |

---

## Implementation Plan

### Phase 0: Tool Factory Refactor ✅
Tools must be created per-session with session CWD in closure for storage scoping.

- [x] Add `ToolFactory` type to `src/types.ts`: `(sessionCwd: string) => unknown[]`
- [x] Update `SessionConfig` to use `toolFactory` instead of `tools`
- [x] Update `session-manager.ts` `create()` to call `toolFactory(cwd)` before SDK session creation
- [x] Update `session-manager.ts` `resume()` to call `toolFactory(cwd)` using cached cwd
- [x] Update `session-state.ts` `SessionStateConfig` to use `toolFactory`
- [x] Update `session-state.ts` to pass `toolFactory` through to session-manager
- [x] Update `server.ts` to define `toolFactory` that creates display tools with cwd
- [x] Verify build passes
- [ ] Test: create session, use display tool, verify output works

### Phase 1: Output Persistence ✅
- [x] Create `src/storage.ts` with OutputStore
- [x] Update display tools to use disk storage (with session registration)
- [x] Add outputId markers `[output:xxx]` to tool results
- [x] Update history reload to parse markers and load outputs
- [x] Migrate `/api/outputs/:id` to use disk store
- [x] Delete old `src/output-cache.ts` (merged into storage.ts)

### Phase 2: Applet Storage ✅
- [x] Create `src/applet-store.ts` for file-based applet storage
- [x] Create `save_applet`, `load_applet`, `list_applets` tools in `applet-tools.ts`
- [x] Tools include file paths so agent can inspect/edit with standard file tools
- [x] `get_applet_state` returns `activeSlug` for context
- [ ] HTTP endpoints for applet file access (deferred - agent uses file tools)
- [ ] UI for browsing saved applets (deferred)

### Phase 3: Applet Runtime State ✅
- [x] In-memory state with `setAppletState()` push pattern
- [x] State batching with message POST (optimized for SSH tunnels)
- [ ] Persistent state per-applet (deferred - in-memory sufficient for now)
- [ ] Client-side wrapper for state API (deferred)

---

## Open Questions

1. **State conflict**: What if applet saves state while agent is also calling set_applet?
   - Option: Lock state during agent operation
   - Option: Last-write-wins (simple)

2. **Applet versioning**: Should we keep history of applet changes?
   - Probably not in v1, rely on git if desired

3. **Cross-session applets**: Can applet from project A be used in project B?
   - Could support explicit export/import
   - Or global applet library in `~/.Caco/applets/`

4. **Output pruning**: How long to keep session outputs?
   - 30 days default?
   - Prune on session delete?

---

## References

- [applet.md](doc/applet.md) — Applet interface design
- [custom-tools.md](doc/custom-tools.md) — MCP tool patterns
- [output-cache.ts](src/output-cache.ts) — Current in-memory implementation
- [display-tools.ts](src/display-tools.ts) — Tools that need persistence