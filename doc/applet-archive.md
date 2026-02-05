# Custom Applet Interface

**Critical feature: Agent-generated custom DOM interfaces in the applet view.**

## Goal

The agent can invoke one or more MCP tools to set custom DOM content inside the applet view, creating dynamic, interactive interfaces for various tasks.

---

## Requirements

### 1. Applet JS Execution

The applet can execute arbitrary JavaScript to initialize custom interfaces.

| Requirement | Description |
|-------------|-------------|
| DOM manipulation | Full access to `#appletView` container |
| Event handlers | Attach listeners, respond to user input |
| State management | Maintain local state within applet lifecycle |
| External APIs | Fetch, WebSocket, etc. for dynamic data |

**Risk acknowledgment**: This is inherently risky, but we're doing localhost agentic development with Copilot anyway. The agent already has shell access.

### 2. Agent MCP Tools

Tools the agent uses to interact with the applet:

| Tool | Direction | Purpose |
|------|-----------|---------|
| `set_applet_content` | Agent → Applet | Set HTML/JS/CSS content |
| `get_applet_state` | Applet → Agent | Query current state/user input |

### 3. Content Format Options

How does the agent send applet content?

| Format | Pros | Cons |
|--------|------|------|
| **Structured (HTML + JS + CSS)** | Clear separation, easier to validate | More complex tool schema |
| **Single HTML string** | Simple, agent familiar with format | Mixed concerns |
| **Bundled file reference** | Persisted, reusable | Extra storage layer |

**Decision**: TBD

### 4. Streaming Considerations

| Question | Options |
|----------|---------|
| Can applet content stream? | Yes (progressive render) / No (atomic set) |
| Binary data (images, charts)? | Base64 inline / Separate tool call / File reference |

### 5. File Operations

Applet JS needs to read/write files on disk for use cases like text applets, config applets, log viewers.

| Operation | Direction | Use Case |
|-----------|-----------|----------|
| Read file | Disk → Applet | Load source code, config, logs |
| Write file | Applet → Disk | Save edits, export data |
| List files | Disk → Applet | File browser, project navigation |
| Watch file | Disk → Applet | Live reload on external changes |

#### API Design Options

| Approach | Implementation | Pros | Cons |
|----------|---------------|------|------|
| **HTTP endpoints** | `GET/POST /api/files/:path` | Simple, RESTful | Path encoding, large files |
| **Tool-mediated** | Agent calls file tools | Controlled, auditable | Async, agent in loop |
| **Direct fetch** | Applet JS calls server API | Fast, no agent round-trip | Less control |

**Recommendation**: HTTP endpoints for direct applet access. Agent doesn't need to be in the loop for every file operation.

#### Proposed Endpoints

```
GET  /api/applet/file?path=/abs/path    → { content: string, encoding: string }
POST /api/applet/file?path=/abs/path    ← { content: string }
GET  /api/applet/list?path=/abs/path    → { files: [{name, type, size}] }
```

#### Throughput Considerations (Localhost HTTP)

| Concern | Analysis |
|---------|----------|
| **Latency** | Localhost: ~0.1ms RTT, negligible |
| **Bandwidth** | Loopback: 10+ Gbps, not a bottleneck |
| **Large files** | 10MB file = ~10ms transfer on localhost |
| **Streaming** | Chunked transfer for very large files |
| **Concurrent ops** | Node.js async I/O handles well |

**Conclusion**: Localhost HTTP is not a throughput concern. Even large files transfer instantly.

#### Security Considerations for File Access

| Risk | Mitigation |
|------|------------|
| Path traversal | Validate paths, restrict to allowed directories |
| Sensitive files | Exclude patterns (`.env`, `.git/config`, keys) |
| Arbitrary write | Confirm overwrites, backup before write? |
| Symlink attacks | Resolve real paths, validate |

**Minimum viable security**:
- Restrict to workspace directories (cwd-based)
- Block known sensitive patterns
- Log all file operations

---

## Architecture Considerations

### MCP Tool Design

Reference: [custom-tools.md](custom-tools.md)

#### `set_applet_content` Tool

```typescript
defineTool("set_applet_content", {
    description: "Set the content of the applet view with HTML, JavaScript, and CSS",
    parameters: z.object({
        html: z.string().describe("HTML content for the applet body"),
        js: z.string().optional().describe("JavaScript to execute after HTML is inserted"),
        css: z.string().optional().describe("CSS styles to inject"),
        title: z.string().optional().describe("Applet title/label")
    }),
    handler: async ({ html, js, css, title }) => {
        // Send to client via SSE or direct DOM update
        // Client-side: inject into #appletView, execute JS
        return "Applet content updated";
    }
});
```

#### `get_applet_state` Tool

```typescript
defineTool("get_applet_state", {
    description: "Get the current state of the applet, including user inputs",
    parameters: z.object({
        selector: z.string().optional().describe("CSS selector to query specific elements"),
        format: z.enum(["json", "text"]).optional()
    }),
    handler: async ({ selector, format }) => {
        // Query client-side applet state
        // Return structured data or text
        return { /* state */ };
    }
});
```

### Client-Server Communication

How does the server-side tool affect client-side DOM?

| Approach | Flow | Complexity |
|----------|------|------------|
| **SSE event** | Tool → SSE → Client JS → DOM | Medium, fits existing stream |
| **Pending state poll** | Tool sets state → Client polls → DOM | Simple but laggy |
| **WebSocket** | Bidirectional real-time | Overkill for now |

**Recommendation**: Use existing SSE stream with new event type `applet.update`.

---

## Security Considerations

### XSS Risk Analysis

**Scenario**: User asks agent to create an applet for a task. Agent fetches content from external source that contains malicious code.

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Agent generates malicious JS | Low (agent is trusted) | High | None needed |
| Agent includes external content | Medium | High | CSP, sandboxing |
| User pastes malicious content | Medium | Medium | Already localhost risk |

### Content Sources

| Source | Trust Level | Action |
|--------|-------------|--------|
| Agent-generated | High | Allow |
| Agent-fetched from web | Low | Warn user? Sandbox? |
| User-provided | Medium | User's responsibility |

### Potential Mitigations

1. **Content Security Policy (CSP)**
   - Restrict script sources
   - Block inline scripts? (conflicts with applet goal)
   
2. **Sandboxed iframe**
   - Run applet content in sandboxed iframe
   - Communicate via `postMessage`
   - Limits: reduced DOM access, complexity
   
3. **Trust prompt**
   - Warn user when applet content includes external resources
   - Explicit "Execute" button before running JS

4. **No mitigation (current stance)**
   - Agent has shell access anyway
   - Localhost development context
   - User is developer, accepts risk

**Decision**: TBD - lean toward minimal mitigation given context.

---

## Persistence Considerations

### Storage Scope

| Scope | Description | Use Case |
|-------|-------------|----------|
| **Session** | Applet lives only during chat session | One-off tools |
| **App-wide** | Applets persist across sessions | Reusable tools |
| **Exportable** | Save/load as files | Version control, sharing |

### Storage Mechanisms

**Decision**: Files on disk in `.Caco/applets/`

Uses the same storage layer as display tool outputs (see [storage.md](../storage.md)).

```
<program-cwd>/.Caco/
├── sessions/<sessionId>/outputs/   # Display tool outputs (Phase 1 ✅)
└── applets/<slug>/                 # Saved applets (Phase 2)
    ├── meta.json
    ├── content.html
    ├── script.js
    ├── style.css
    └── state.json
```

**Benefits**:
- Git-friendly (version control applets)
- Human-readable
- Unified with output storage
- No database dependency

### File-Based Storage Design

```
applets/
├── _index.json          # Manifest of saved applets
├── calculator/
│   ├── meta.json        # { name, description, created, updated }
│   ├── content.html
│   ├── script.js
│   └── style.css
└── data-viewer/
    ├── meta.json
    ├── content.html
    └── script.js
```

**Benefits**:
- Git-friendly (version control applets)
- Human-readable
- Easy to backup/share
- No database dependency

---

## Codebase Requirements

### New Modules

| Module | Location | Purpose | Status |
|--------|----------|---------|--------|
| `applet-state.ts` | `src/` | In-memory applet state singleton | ✅ Phase 1+2+3 |
| `applet-tools.ts` | `src/` | MCP tool definitions | ✅ Phase 1+2+3 |
| `applet-runtime.ts` | `public/ts/` | Client-side applet execution | ✅ Phase 1+2 |
| `applet-store.ts` | `src/` | Server-side applet persistence | ✅ Phase 3 |
| `routes/applet.ts` | `src/routes/` | File operation endpoints | Phase 4 |

### Encapsulation Goals

```
src/
├── applet-store.ts      # Load/save applets to disk
├── applet-tools.ts      # defineTool() for set/get applet
└── routes/
    └── applet.ts        # HTTP endpoints for file ops + applet CRUD

public/ts/
├── applet-runtime.ts    # Execute applet content, manage lifecycle
├── applet-api.ts        # Client-side file operation wrappers
└── view-controller.ts   # Already handles applet view state
```

### Integration Points

1. **Session Manager** - Register applet tools with session
2. **SSE Stream** - `_applet` payload in `tool.execution_complete` events
3. **View Controller** - Switch to applet view when content set
4. **Main.ts** - Initialize applet runtime

---

## Implementation Plan

### Phase 1: Basic Applet Tool ✅

- [x] Create `applet-tools.ts` with `set_applet_content`
- [x] Register tool in session creation (via `toolFactory` in `server.ts`)
- [x] Create `applet-runtime.ts` for client-side execution
- [x] SSE event with `_applet` payload to push content
- [x] Auto-switch to applet view when content set

**Implementation Notes (Phase 1):**
- `applet-state.ts` - In-memory singleton for current applet content
- `applet-tools.ts` - Defines `set_applet_content` with clear agent-facing description
- `applet-runtime.ts` - Injects HTML, CSS (via `<style>`), executes JS via `<script>` element (global scope for onclick handlers)
- SSE enrichment in `stream.ts` - Adds `_applet` to `tool.execution_complete` events
- `response-streaming.ts` - Calls `executeApplet()` when `_applet` present
- CSP includes `'unsafe-eval'` for dynamic script execution

### Phase 2: State Query ✅

- [x] Add `get_applet_state` tool
- [x] Client exposes `setAppletState(data)` function for applet JS to call
- [x] Server endpoint `/api/applet/state` receives state updates
- [x] Tool reads cached state from server

**Design (Phase 2):**

The challenge: Agent's tool handler runs server-side, but state lives client-side in the DOM.

**Approach: Push-based state sync**

Instead of polling/querying the DOM on demand, the applet JS pushes state updates to the server:

1. **Client-side**: Global `setAppletState(data)` function available to applet JS
2. **Client-side**: Applet calls `setAppletState({...})` on user interaction
3. **Server-side**: `/api/applet/state` POST endpoint caches the state
4. **Server-side**: `get_applet_state` tool reads cached state

**Optimization (batching):**

State updates are batched with message POSTs to minimize HTTP calls:

1. **Client-side**: `setAppletState()` stores locally (no immediate HTTP)
2. **Client-side**: When user sends next message, state included in POST body
3. **Server-side**: `/api/message` extracts `appletState` and stores it

This is efficient for SSH tunnels and high-frequency state updates.

**Agent's responsibility**: Write applet JS that calls `setAppletState()` to expose relevant data.

**Example pattern** (agent generates this):
```javascript
// Calculator applet - expose state on every operation
function updateDisplay(value) {
  document.getElementById('display').value = value;
  setAppletState({ displayValue: value, lastOperation: currentOp });
}
```

**Benefits**:
- No async DOM querying from server
- State always reflects latest user interaction
- Minimal HTTP calls (batched with message)
- Works well over SSH tunnels

**Implementation Notes (Phase 2):**
- `applet-runtime.ts` - `setAppletState()` stores locally, `getAndClearPendingAppletState()` for batching
- `response-streaming.ts` - Includes pending applet state when sending message
- `stream.ts` - Extracts `appletState` from POST body and stores via `setAppletUserState()`
- `applet-state.ts` - `appletUserState` object stores pushed state, cleared on applet change
- `api.ts` - POST `/api/applet/state` fallback endpoint, GET for debugging
- `applet-tools.ts` - `get_applet_state` tool returns cached state with optional key filter
- Tool descriptions teach agent about `setAppletState()` pattern

### Phase 3: Persistence ✅

- [x] Create `applet-store.ts` for file-based storage
- [x] Add `save_applet` / `load_applet` / `list_applets` tools
- [x] `get_applet_state` returns `activeSlug` for context
- [ ] UI for browsing saved applets (deferred to Phase 4)

**Design (Phase 3):**

Applets are stored as separate files for easy agent inspection:

```
.Caco/applets/<slug>/
├── meta.json       # { name, description, created, updated }
├── content.html    # HTML content
├── script.js       # JavaScript (optional)
└── style.css       # CSS (optional)
```

**Agent workflow options:**

1. **Direct load**: Agent calls `load_applet(slug)` to display immediately
2. **Inspect first**: Agent uses `list_applets` to get file paths, reads/edits files with standard tools, then calls `load_applet`
3. **Modify and save**: After loading, agent can modify via `set_applet_content`, then `save_applet` to update

**Key design decisions:**

- Separate files (not bundled) so agent can read/edit with standard file tools
- `list_applets` returns full file paths for inspection
- `load_applet` triggers rendering (no content returned to agent - avoids LLM round-trip)
- `get_applet_state` returns `activeSlug` so agent knows what's loaded

**Implementation Notes (Phase 3):**
- `applet-store.ts` - File-based storage with `saveApplet`, `loadApplet`, `listApplets`, `getAppletPaths`
- `applet-state.ts` - Added `activeSlug` tracking with `getActiveSlug()`, `setActiveSlug()`
- `applet-tools.ts` - Three new tools: `save_applet`, `load_applet`, `list_applets`
- `get_applet_state` - Now returns metadata including `activeSlug`, `appletTitle`, `hasApplet`
- `load_applet` returns `toolTelemetry.appletSet` to trigger SSE push (same as `set_applet_content`)

### Phase 4: Lifecycle API (DEFERRED - See Analysis)

Applet lifecycle hooks were considered for safe polling/cleanup.

**Decision: Deferred** - The complexity isn't justified by current use cases.

See [git-applet.md Phase 6](git-applet.md#phase-6-auto-refresh-analysis-not-recommended) for full analysis.

**Summary:**
- Polling is the main use case, but manual refresh is simpler and already works
- Lifecycle API introduces coupling between runtime ↔ view-controller
- Multiple edge cases (browser sleep, callback throws, race conditions)
- ~100-150 lines of code for marginal benefit

**If needed later**, the design should ensure:
- `onCleanup` can NEVER fail (try/catch each callback)
- Visibility is derived fresh, not cached
- Cleanup is idempotent
- Callbacks are synchronous only

For now, applets should use manual refresh patterns.

### Phase 5: File Operations

- [ ] `GET /api/applet/file?path=` - Read file content
- [ ] `POST /api/applet/file?path=` - Write file content
- [ ] `GET /api/applet/list?path=` - List directory

### Phase 6: Polish

- [ ] Applet library (reusable patterns)
- [ ] Templates for common applets
- [ ] Security review and hardening

---

## Open Questions

1. **Iframe sandboxing**: Worth the complexity? Or trust the agent context?

2. ~~**Applet lifecycle**: When does applet content get cleared?~~ **Resolved**: Applet persists until replaced by another applet or page refresh. Lifecycle hooks (onCleanup, onVisibilityChange) were analyzed and **deferred** - manual refresh is simpler. See [git-applet.md Phase 6](git-applet.md#phase-6-auto-refresh-analysis-not-recommended).

3. **Multiple applets**: Can agent create multiple applets? Tabs?

4. **Applet templates**: Pre-built applets for common tasks?
   - Data table viewer
   - Form builder
   - Chart/visualization
   - Code applet

5. **State sync**: How does agent know when user has interacted?
   - Polling?
   - User triggers "submit" action?
   - Real-time via WebSocket?

---

## Research Notes

### XSS in Agent Context

Traditional XSS concerns:
- Attacker injects script to steal cookies/credentials
- Script exfiltrates data to attacker-controlled server

In our context:
- Agent IS the "attacker" (but trusted)
- No external users to attack
- Localhost means no cookies to steal from other sites
- Agent already has shell access (more powerful than XSS)

**Conclusion**: XSS in traditional sense is not the primary concern. The concern is:
- Agent fetching and executing malicious external content
- Mitigation: trust boundary is the agent's judgment

### MCP Tool Result Flow

From custom-tools.md:
```
AI decides to call tool → CLI server sends JSON-RPC → SDK executes handler → Result → AI response
```

For applet tools, we need:
```
Tool handler → Push to client via SSE → Client updates DOM → User interacts → Tool queries state
```

This is a **push model**, not the typical request/response of other tools.

---

## Use Case: Text Applet

Concrete example of agent-created applet with file operations.

### User Request
> "Create a text applet for `/home/user/project/config.yaml`"

### Agent Actions

1. **Calls `set_applet_content`** with:

```html
<div class="text-applet">
  <div class="toolbar">
    <span class="filename" id="filename"></span>
    <button id="saveBtn">Save</button>
    <span id="status"></span>
  </div>
  <textarea id="content" spellcheck="false"></textarea>
</div>
```

```javascript
const filePath = '/home/user/project/config.yaml';

// Load file content
async function loadFile() {
  const res = await fetch(`/api/applet/file?path=${encodeURIComponent(filePath)}`);
  const { content } = await res.json();
  document.getElementById('content').value = content;
  document.getElementById('filename').textContent = filePath.split('/').pop();
}

// Save file content
document.getElementById('saveBtn').onclick = async () => {
  const content = document.getElementById('content').value;
  const res = await fetch(`/api/applet/file?path=${encodeURIComponent(filePath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  document.getElementById('status').textContent = res.ok ? 'Saved!' : 'Error';
  setTimeout(() => document.getElementById('status').textContent = '', 2000);
};

loadFile();
```

```css
.text-applet { display: flex; flex-direction: column; height: 100%; }
.toolbar { display: flex; gap: 1rem; padding: 0.5rem; background: #1e1e1e; }
.filename { flex: 1; color: #888; }
#content { flex: 1; font-family: monospace; background: #0d0d0d; color: #d4d4d4; 
           border: none; padding: 1rem; resize: none; }
#saveBtn { background: #0e639c; color: white; border: none; padding: 0.25rem 1rem; cursor: pointer; }
#status { color: #4ec9b0; }
```

2. **View auto-switches to applet**
3. **User edits and saves directly** - no agent involvement for file I/O

### Data Flow

```
Agent                    Server                      Client (Applet)
  │                        │                              │
  ├─set_applet_content────►│                              │
  │                        ├──SSE: applet.update─────────►│
  │                        │                              ├─inject HTML/JS/CSS
  │                        │                              ├─execute JS
  │                        │◄─GET /api/applet/file────────┤
  │                        ├──{ content: "..." }─────────►│
  │                        │                              ├─display in textarea
  │                        │        (user edits)          │
  │                        │◄─POST /api/applet/file───────┤
  │                        ├──{ ok: true }───────────────►│
  │                        │                              ├─show "Saved!"
```

---

## References

- [custom-tools.md](custom-tools.md) - In-process tool definition
- [view-controller.ts](../public/ts/view-controller.ts) - Applet view state management
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
