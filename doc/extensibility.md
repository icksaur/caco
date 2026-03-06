# Extensibility

> Status: **Draft spec** — design exploration, not committed to implementation.

## Problem

Every new Caco feature requires modifying core code. Style tweaks, workflow customizations, UI rearrangements, and session-switching shortcuts all live in the same codebase as the chat engine. This couples user preferences to release cycles and makes the project harder for others to adopt without forking.

An extension system would let users customize Caco without touching core, and let us ship a smaller core that's easier to maintain.

## Goals

- **Zero-fork customization** — users override behavior via files in `~/.caco/extensions/`, not patches.
- **Unified FE+BE story** — one extension can contribute CSS, client JS, server routes, and tools.
- **Progressive complexity** — a CSS-only theme is a valid extension. So is a full-stack dashboard.
- **Hot-reload friendly** — extensions reload without full server restart where possible.
- **No new runtime dependencies** — extensions are plain TS/JS/CSS files, loaded by Caco's existing Node + esbuild stack.

## Non-goals

- Package registry or `caco install` (out of scope for v1; file-based discovery is enough).
- Sandboxing extensions (they run with full trust, like the rest of Caco).
- Supporting non-TypeScript extension languages.

## Prior Art: Pi Coding Agent

Pi's extension model is the closest reference. Key ideas worth adopting:

| Pi concept | What it does | Caco applicability |
|---|---|---|
| **Extensions** (`~/.pi/agent/extensions/*.ts`) | TS modules exporting `(pi: ExtensionAPI) => void`. Register tools, commands, event handlers, UI widgets. | Direct inspiration — Caco needs the same `ExtensionAPI` pattern. |
| **Themes** (`~/.pi/agent/themes/`) | Color/style overrides, hot-reloaded. | Caco already has CSS custom properties — theme = CSS override file. |
| **Prompt templates** (`/name` expansion) | Markdown files expanded as slash commands. | Adopted — specced below. `/` as first char triggers command palette. Extensions can register custom commands. |
| **Event interception** | Extensions hook `tool_call`, `agent_start`, etc. Can block, modify, inject. | Caco's WS event system could expose similar hooks on both client and server. |
| **UI widgets** | `ctx.ui.setWidget("name", lines)`, `ctx.ui.setStatus("name", text)` | Caco's footer and header are natural widget slots. |
| **Packages** | npm/git bundles of extensions+skills+themes+prompts. | Future work — file-based discovery first. |

**Key difference**: Pi is a terminal TUI. Caco is a web app with a split FE/BE architecture. Extensions need to contribute to both sides, and the client-side story must handle HTML/CSS/JS — not just text widgets.

## Current Extension Surface

What Caco already has that's extension-like:

| Mechanism | Scope | Limitation |
|---|---|---|
| **Applets** (`~/.caco/applets/`) | FE: HTML/JS/CSS panels. Agent can create them. | Applets are content panels, not layout overrides. Can't modify header, footer, or session list. |
| **CSS custom properties** (`:root` vars) | FE: theming | No file-based override mechanism — must edit `style.css` directly. |
| **Skills** (`.github/skills/`) | BE: prompt injection | Project-scoped, not user-scoped. No FE component. |
| **System prompt** (`src/prompts.ts`) | BE: agent behavior | Hardcoded. No user override file. |
| **MCP tools** | BE: external tool servers | Good for tool extensibility, but no UI or event hooks. |

## Proposed Architecture

### Extension Discovery

```
~/.caco/extensions/
├── my-theme/
│   ├── manifest.json       # { name, description, provides: ["css"] }
│   └── style.css           # CSS overrides (injected after core styles)
│
├── session-shortcuts/
│   ├── manifest.json       # { provides: ["client"] }
│   ├── style.css           # Optional CSS
│   └── client.ts           # Client-side module (compiled to JS)
│
└── deploy-tool/
    ├── manifest.json       # { provides: ["server", "client"] }
    ├── server.ts           # Server-side: routes, tools, WS event handlers
    └── client.ts           # Client-side: WS event reactions, UI mutations
```

**Server-local extensions** in `.caco/extensions/` override user-global ones (same as applets).

### Manifest

```jsonc
{
  "name": "my-extension",
  "description": "What it does",
  "provides": ["css", "client", "server"],
  // Optional: declare which UI slots this extension uses
  "slots": ["footer-left", "header-right", "session-item-badge"]
}
```

`provides` determines what Caco loads:
- `"css"` → `style.css` injected into `<head>` after core styles
- `"client"` → `client.ts` bundled and loaded as ES module
- `"server"` → `server.ts` loaded at startup, receives server extension API

### Tier 1: CSS Overrides (Themes)

**Effort: Low. Value: High.**

Caco already uses CSS custom properties extensively. A theme extension is just a CSS file:

```css
/* ~/.caco/extensions/solarized/style.css */
:root {
  --bg-base: #002b36;
  --bg-surface: #073642;
  --color-text: #839496;
  --color-accent: #268bd2;
  --color-link: #2aa198;
  --color-success: #1a4a2e;
  --color-success-bright: #859900;
}
```

**Implementation**: On server start (and on file change via `fs.watch`), scan extension dirs for `style.css` files, serve them at `/extensions/<slug>/style.css`, inject `<link>` tags into `index.html` after the core stylesheet.

**Hot reload**: `fs.watch` detects changes → broadcast `globalEvent({ type: 'extension.cssChanged', slug })` → client reloads the `<link>` tag.

### Tier 2: Client Extensions

**Effort: Medium. Value: High.**

Client extensions are TypeScript modules that receive a `ClientExtensionAPI`:

```typescript
// ~/.caco/extensions/session-shortcuts/client.ts
import type { ClientExtensionAPI } from 'caco/extension-api';

export default function(caco: ClientExtensionAPI) {
  // Add content to UI slots
  caco.footer.addLeft('quick-switch', () => {
    const el = document.createElement('span');
    el.textContent = '⌘1 ⌘2 ⌘3';
    el.className = 'ext-quick-switch';
    return el;
  });

  // React to WebSocket events (standard or custom)
  caco.on('session.idle', (event) => {
    // Play a sound, show a notification, etc.
  });

  // React to custom WS events from server extensions
  caco.on('ext.deploy.status', (event) => {
    caco.footer.update('deploy-status', event.data.message);
  });

  // Register keyboard shortcuts
  caco.registerShortcut('ctrl+1', () => caco.switchSession(0));
  caco.registerShortcut('ctrl+2', () => caco.switchSession(1));

  // Cleanup on extension unload (hot-reload)
  return () => { /* dispose listeners, remove DOM */ };
}
```

#### Client Extension API Surface

```typescript
interface ClientExtensionAPI {
  // UI slots — each returns a dispose function
  footer: {
    addLeft(id: string, render: () => HTMLElement): () => void;
    addRight(id: string, render: () => HTMLElement): () => void;
    update(id: string, content: string | HTMLElement): void;
  };
  header: {
    addLeft(id: string, render: () => HTMLElement): () => void;
    addRight(id: string, render: () => HTMLElement): () => void;
  };
  sessionItem: {
    addBadge(id: string, render: (session: SessionData) => HTMLElement | null): () => void;
  };

  // Events (SDK events + caco.* + ext.* custom events)
  on(event: string, handler: (event: SessionEvent) => void): () => void;

  // Navigation
  switchSession(index: number): void;   // By position in list
  switchSessionById(id: string): void;

  // WebSocket (send custom events to server extensions)
  send(type: string, data?: unknown): void;

  // Keyboard shortcuts
  registerShortcut(combo: string, handler: () => void): () => void;

  // State (persisted per-extension in localStorage)
  getState<T>(key: string): T | undefined;
  setState<T>(key: string, value: T): void;

  // Toast notifications
  toast(message: string, opts?: { type?: string; autoHideMs?: number }): void;
}
```

**Implementation**: 
- On build, scan extension dirs for `client.ts`, compile each with esbuild to `client.js`.
- Serve at `/extensions/<slug>/client.js`.
- In `index.html` (or via a loader script), dynamically `import()` each extension module.
- Pass a `ClientExtensionAPI` instance scoped to that extension (for namespaced cleanup).

**Hot reload**: File watcher detects change → recompile → broadcast `extension.reload` event → client re-imports module (old one's dispose function called first).

### Tier 3: Server Extensions

**Effort: Medium-High. Value: High for power users.**

Server extensions are TypeScript modules loaded at startup:

```typescript
// ~/.caco/extensions/deploy-tool/server.ts
import type { ServerExtensionAPI } from 'caco/extension-api';

export default function(caco: ServerExtensionAPI) {
  // Register Express routes
  caco.router.post('/deploy', async (req, res) => {
    const result = await deploy(req.body.target);
    // Broadcast to subscribed clients
    caco.broadcast('ext.deploy.status', { message: result });
    res.json({ ok: true });
  });

  // Register agent tools (available to the LLM)
  caco.registerTool({
    name: 'deploy',
    description: 'Deploy the current project',
    parameters: { target: { type: 'string' } },
    execute: async (params) => {
      return { content: `Deployed to ${params.target}` };
    }
  });

  // Hook into session lifecycle
  caco.on('session.idle', (sessionId, event) => {
    // Post-completion automation
  });

  // Custom WS message handler (from client extensions)
  caco.onClientMessage('ext.deploy.trigger', (ws, data) => {
    // Handle custom client→server messages
  });
}
```

#### Server Extension API Surface

```typescript
interface ServerExtensionAPI {
  // Express router mounted at /ext/<slug>/
  router: express.Router;

  // Agent tools
  registerTool(tool: ToolDefinition): void;

  // WebSocket
  broadcast(type: string, data?: unknown): void;                    // To all clients
  broadcastToSession(sessionId: string, type: string, data?: unknown): void;
  onClientMessage(type: string, handler: (ws: WebSocket, data: unknown) => void): void;

  // Session lifecycle hooks
  on(event: string, handler: (...args: unknown[]) => void): () => void;

  // Extension metadata (exposed to agent via caco_extensions introspection tool)
  setDescription(description: string): void;

  // Storage (persisted per-extension in ~/.caco/extensions/<slug>/state.json)
  getState<T>(key: string): T | undefined;
  setState<T>(key: string, value: T): void;
}
```

**Implementation**:
- At startup, scan extension dirs for `server.ts`, load via `tsx` / `jiti` (already available in the Node ecosystem, no compile step needed).
- Mount each extension's router at `/ext/<slug>/`.
- Extension tools are merged into the tool factory passed to the SDK.

**Hot reload**: Harder for server-side. Options:
1. **Full restart** (current approach — `restart_server` tool).
2. **Module invalidation** — unload old module, re-require. Feasible if extensions are stateless or manage their own cleanup.

### Agent Introspection: `caco_extensions` Tool

The agent discovers extensions via a tool, not system prompt injection. This follows the same pattern as `caco_applet_usage` and `caco_dev_docs`.

**Tool**: `caco_extensions` — returns a summary of all loaded extensions.

```json
{
  "extensions": [
    {
      "slug": "deploy",
      "description": "One-click deploy to staging/prod",
      "tools": ["deploy_trigger", "deploy_status"],
      "commands": ["/deploy"],
      "hasCSS": true,
      "hasClient": true,
      "hasServer": true
    }
  ]
}
```

**System message** gets one static line (in `buildSystemMessage()`):
```
Extensions may be loaded. Call caco_extensions to discover capabilities.
```

**Why tool-based instead of prompt injection**:
- System message is set at session creation (SDK limitation) — can't be updated when extensions hot-reload
- Tool responses are always current and reliable
- Agent pulls when relevant, doesn't burn tokens on every message
- Works across session resume

Extensions call `api.setDescription(text)` to register their description. The `caco_extensions` tool aggregates slug, description, registered tools, and commands from the extension store.

### Tier 4: Custom WebSocket Events

**Effort: Low (builds on Tier 2+3). Value: Medium.**

Custom events use the `ext.*` namespace to avoid collisions:

```
Client → Server:  { type: 'ext.deploy.trigger', data: { target: 'prod' } }
Server → Client:  { type: 'ext.deploy.status', data: { message: 'Deploying...' } }
```

The existing WS infrastructure already supports arbitrary message types. The only work is:
1. Server: route `ext.*` messages to the registered extension handler.
2. Client: route `ext.*` events to extension `on()` callbacks.
3. Don't filter custom events by sessionId (they're extension-scoped, not session-scoped).

## UI Slot Map

Where extensions can inject content:

```
┌─────────────────────────────────────────────────────┐
│ [header-left]                        [header-right] │  ← menu btn, applet btn area
├─────────────────────────────────────────────────────┤
│                                                     │
│  Chat messages                                      │
│                                                     │
├─────────────────────────────────────────────────────┤
│ [footer-left]                        [footer-right] │  ← context footer area
├─────────────────────────────────────────────────────┤
│ [input-above]                                       │  ← above the chat input
│ [ chat input                                      ] │
│ [input-below]                                       │  ← below the chat input
└─────────────────────────────────────────────────────┘

Session panel:
┌─────────────────────────────────────────────────────┐
│ [session-header]                                    │  ← above session list
│ ┌─ session item ──────────────────────────────────┐ │
│ │ title                              [badges] / × │ │  ← session-item-badge slot
│ │ model · cwd/                                    │ │
│ └─────────────────────────────────────────────────┘ │
│ [session-footer]                                    │  ← below session list
└─────────────────────────────────────────────────────┘
```

## Use Cases Enabled

| Use case | Tier | Example |
|---|---|---|
| Dark/light/solarized themes | 1 (CSS) | Override `:root` variables |
| Session keyboard shortcuts (⌘1, ⌘2...) | 2 (Client) | `registerShortcut` + `switchSession` |
| Footer quick-switch buttons | 2 (Client) | `footer.addLeft` with session buttons |
| Sound on completion | 2 (Client) | `on('session.idle', playSound)` |
| Custom slash commands | 2 (Client) | `registerCommand('deploy', ...)` |
| Deploy button in footer | 2+3 (Client+Server) | Footer widget + server route + agent tool |
| Custom session badges (cost, token count) | 2 (Client) | `sessionItem.addBadge` |
| Project-specific agent tools | 3 (Server) | `registerTool` + `caco_extensions` introspection |
| Git auto-checkpoint | 3 (Server) | Hook `session.idle` → `git stash` |
| CI/CD integration | 3 (Server) | Custom tool + WS status broadcasts |
| Custom session list ordering | 2 (Client) | Override session rendering (advanced) |

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Extension errors crash Caco | Wrap all extension calls in try/catch. Log errors, disable misbehaving extensions. |
| DOM manipulation conflicts | Scoped UI slots with namespaced IDs. Extensions can only add to designated slots, not modify core DOM. |
| WS message flooding from extensions | Rate-limit `ext.*` messages. |
| Breaking API changes | Version the extension API. Start with `v1`, keep it small, expand based on demand. |
| Client bundle size bloat | Extensions are separate `<script>` tags, not bundled into core `bundle.js`. |
| Security (untrusted extensions) | Out of scope — extensions are local files with full trust, same as the rest of Caco. Document this clearly. |

## Implementation Plan

### Phase 1: CSS Themes
- Extension directory scanning (`~/.caco/extensions/` + `.caco/extensions/`)
- `manifest.json` parsing and validation
- CSS injection into `index.html` (served at `/extensions/<slug>/style.css`)
- Hot-reload via `fs.watch` + WS broadcast → client reloads `<link>` tag

### Phase 2: Client Extensions
- esbuild compilation of `client.ts` → `client.js` (per-extension, not bundled into core)
- Extension loader in frontend (`/api/extensions` list → dynamic `import()` for each)
- `ClientExtensionAPI` implementation:
  - UI slot system (footer, header, session badges, input-above/below)
  - Event subscription (`on()` for SDK + caco.* + ext.* events)
  - Keyboard shortcut registration
  - Session navigation helpers
  - Per-extension localStorage state
  - Toast notifications
- Dispose/reload lifecycle (cleanup on hot-reload)

### Phase 3: Slash Commands + Pound References
- `InputPopup` reusable component (floating list above input, keyboard nav, fuzzy filter)
- Slash command registry (built-in commands + extension-registered + prompt template files)
- `#` file picker (project file listing API, gitignore-aware)
- Textarea keydown interception (delegate to popup when active)
- Prompt template loading from `~/.caco/prompts/*.md`

### Phase 4: Server Extensions
- `server.ts` loading via jiti (no compile step)
- `ServerExtensionAPI` implementation:
  - Express router mounted at `/ext/<slug>/`
  - Tool registration (merged into SDK tool factory)
  - WS broadcast helpers
  - Custom client message handlers (`ext.*` namespace)
  - Extension metadata registration (description, exposed via `caco_extensions` tool)
  - Per-extension persistent state (`~/.caco/extensions/<slug>/state.json`)
- Route mounting and tool merging

### Phase 5: Custom WS Events
- `ext.*` routing on both client and server
- Extension-scoped message handling (not session-filtered)
- Rate limiting for extension WS messages

## Design Decisions

Resolved from initial review:

1. **Applets stay separate from extensions.** Applets are agent-created content panels. Extensions are user-installed behavior overrides. Different purposes, though they share file-based discovery infrastructure. Worth unifying discovery/loading code internally, but the user-facing concepts remain distinct.

2. **Extension ordering is alphabetical by slug.** If two extensions both add footer-left content, they render in alphabetical order. No explicit priority — keep it simple.

3. **Extensions are isolated.** No extension-to-extension communication in v1. Each extension only sees the `ExtensionAPI` and its own state.

4. **Slash commands and pound-references specced here** as related features. They're orthogonal to extensions but synergistic — extensions can register custom slash commands.

---

## Slash Commands (`/`)

> To be specced in detail in a separate document. Summary here for context.

Slash commands trigger when `/` is the first character in the input. A space before `/` causes it to be treated as a literal character — this matches user mental models from Discord, Slack, etc.

**Behavior:**
- Typing `/` as the first character opens a **command palette** — a popup list above the input area.
- The palette filters as the user types (fuzzy match on command name).
- Arrow keys navigate, Enter selects, Escape dismisses.
- Selected command either expands inline (prompt templates) or executes immediately (built-in commands).

**Built-in commands** (examples):
- `/model` — open model selector
- `/sessions` — open session panel
- `/new` — new chat
- `/clear` — clear chat display
- `/help` — show available commands

**Extension-registered commands:**
```typescript
// In a client extension:
caco.registerCommand('deploy', {
  description: 'Deploy to production',
  handler: async (args) => { /* ... */ }
});
```

**Prompt templates** (markdown files in `~/.caco/prompts/`):
- `/review` expands to contents of `~/.caco/prompts/review.md`
- Templates can have `{{placeholders}}` filled via follow-up prompts or args

### Command Palette UI

The palette is a floating panel that:
- Appears **above the input area**, outside the footer, covering chat content.
- Matches the width of the input well (or slightly narrower).
- Shows filtered command list with name, description, and source (built-in / extension / template).
- Dismisses on Escape, click-outside, or backspace past `/`.

```
┌─────────────────────────────────────────┐
│  Chat messages                          │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ /deploy    Deploy to production   │  │  ← command palette
│  │ /dev       Start dev server       │  │     (floating above input)
│  │ /diff      Show git diff          │  │
│  └───────────────────────────────────┘  │
├─────────────────────────────────────────┤
│ [/de|                               ]  │  ← input with cursor
│ context-links          model · cwd/    │
└─────────────────────────────────────────┘
```

---

## Pound References (`#`)

> To be specced in detail in a separate document. Summary here for context.

Pound references (`#`) provide file-name completion inline in messages, inspired by VS Code's `#file` pattern. Unlike slash commands, `#` works at any position in the input — it's a mention, not a command.

**Behavior:**
- Typing `#` opens a **file picker** popup (same position/style as the command palette).
- The picker fuzzy-matches against project files (respecting `.gitignore`).
- Selecting a file inserts the path and may attach the file's content as context.
- Multiple `#` references can appear in a single message.

**What `#` resolves to:**
- `#filename` → inserts the full relative path and adds the file content to the message context (so the agent sees it without needing to `read` it).
- This is particularly useful for ensuring the agent works with a specific file when names are ambiguous.

### File Picker UI

Same visual pattern as the command palette:
- Floating panel above input, same width.
- Filters as user types after `#`.
- Shows file path + type icon (if available).
- Dismisses on Escape, click-outside, space (commits selection), or Tab (commits selection).

```
┌─────────────────────────────────────────┐
│  ┌───────────────────────────────────┐  │
│  │ src/session-manager.ts            │  │  ← file picker
│  │ src/session-state.ts              │  │
│  │ tests/session-manager.test.ts     │  │
│  └───────────────────────────────────┘  │
├─────────────────────────────────────────┤
│ [Fix the bug in #session-|           ]  │  ← input with cursor
│ context-links          model · cwd/    │
└─────────────────────────────────────────┘
```

### Implementation Considerations

Both slash and pound share UI infrastructure:
- **Popup component**: Reusable floating list anchored above the input.
- **Fuzzy matcher**: Shared filtering logic.
- **Keyboard handling**: Intercept in the textarea keydown handler; delegate to popup when active.
- **Data sources**: Slash pulls from a command registry (built-in + extensions + templates). Pound pulls from a file listing API.

The popup should be a single reusable component (`InputPopup`) parameterized by data source and selection behavior. This avoids duplicating popup positioning, keyboard nav, and dismiss logic.

---

## Extension Loading Details

### Discovery Algorithm

On startup (and on `fs.watch` trigger for hot-reload):

```
1. Scan ~/.caco/extensions/*/manifest.json
2. Scan .caco/extensions/*/manifest.json (server-local)
3. Server-local wins on slug collision (same as applets)
4. Sort by slug alphabetically
5. For each extension:
   a. If provides "css" → register style.css for injection
   b. If provides "client" → compile client.ts → serve client.js
   c. If provides "server" → load server.ts via jiti
```

### Client Extension Lifecycle

```
Page load
  │
  ├─► Core bundle.js loads
  ├─► Fetch /api/extensions → list of enabled extensions
  │
  └─► For each extension with "client":
      ├─► import('/extensions/<slug>/client.js')
      ├─► Call default export with ClientExtensionAPI
      └─► Store dispose function (returned by default export)

Hot reload (extension.reload WS event)
  │
  ├─► Call dispose() on old instance
  ├─► Remove old DOM contributions (slots track ownership by extension slug)
  ├─► Re-import module with cache-busting query param
  └─► Call default export again
```

### Server Extension Lifecycle

```
Server start
  │
  ├─► Scan extension dirs
  └─► For each extension with "server":
      ├─► Load server.ts via jiti
      ├─► Call default export with ServerExtensionAPI
      ├─► Mount router at /ext/<slug>/
      └─► Merge registered tools into tool factory

Server restart (required for server extension changes)
  │
  ├─► All extensions unloaded
  └─► Full re-scan and re-load
```

### Error Isolation

Every call into extension code is wrapped:

```typescript
function safeCall(slug: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[EXT:${slug}] Error:`, err);
    // Don't disable — log and continue. User can fix and hot-reload.
  }
}
```

Client-side: uncaught errors in extension modules are caught by the dynamic import wrapper. A toast notification shows which extension errored.

Server-side: route handlers are wrapped in try/catch. Tool execution failures are reported as tool errors to the SDK (same as built-in tool failures).

---

## Relationship to Existing Systems

### Extensions vs Applets

| | Applets | Extensions |
|---|---|---|
| **Created by** | Agent (via `write_file`) | User (manually or via package install) |
| **Scope** | Content panel (right side) | Layout overrides, shortcuts, tools, behavior |
| **Discovery** | `~/.caco/applets/<slug>/` | `~/.caco/extensions/<slug>/` |
| **Runtime** | Sandboxed iframe-like (limited `appletAPI`) | Full trust (direct DOM access via slots, full WS) |
| **Has server component** | No (FE only) | Yes (optional `server.ts`) |

**Shared infrastructure to unify**: File scanning logic, `manifest.json` parsing, CSS injection, JS serving. The internal `loadExtension()` / `loadApplet()` code should share a common `discoverPackages(dir, schema)` utility.

### Extensions vs MCP

MCP tools add agent capabilities. Extensions can also register tools via `ServerExtensionAPI.registerTool()`. The difference:

- **MCP**: External tool servers, discovered via configuration, protocol-level integration.
- **Extension tools**: In-process, loaded from local TS files, can access Caco internals (sessions, WS, storage).

They coexist. An extension might wrap an MCP server with custom UI, or provide tools that don't warrant a separate MCP server.

### Extensions vs Skills

Skills (`.github/copilot-instructions.md`, `.github/skills/`) are prompt-injection mechanisms — they add text to the system message. Extensions expose their capabilities via the `caco_extensions` introspection tool instead.

Why a tool instead of system prompt injection: The Copilot SDK sets the system message at session creation — it can't be reliably updated later. Tool responses are always reliable and always current. The agent calls `caco_extensions` on demand to discover what's loaded, what tools are available, and what each extension does. This avoids burning tokens on every message and eliminates stale-cache problems.

Skills remain the right choice for static prompt text (project conventions, coding guidelines). Extensions are for dynamic capabilities (tools, UI, WS events) that the agent discovers via introspection.

