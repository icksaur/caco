# Copilot Instructions: Caco

Caco is a self-extensible web-based chat interface for the GitHub Copilot CLI SDK. The agent can extend the UI at runtime by creating interactive "applets".

## Build, Test, and Lint

```bash
# Main commands
npm run build          # Full build: client bundle + typecheck + lint + knip + test
npm run dev            # Development server with auto-reload (tsx watch)

# Client bundling
npm run build:client   # Bundle public/ts/main.ts → public/bundle.js (esbuild)
npm run watch:client   # Watch mode for client bundle

# Type checking and linting
npm run typecheck      # TypeScript compilation check (tsc --noEmit)
npm run lint           # ESLint with max warnings = 0
npm run lint:fix       # Auto-fix ESLint issues
npm run knip           # Dead code detection

# Testing
npm test               # Run tests once (vitest run)
npm run test:watch     # Watch mode for development
npm run test:coverage  # With coverage report

# Run a single test file
npx vitest tests/unit/oembed.test.ts
```

## Architecture

### Communication Flow
```
Browser (localhost:3000)
    ↓ WebSocket (streaming) + HTTP (API calls)
Express Server (server.ts)
    ↓ JSON-RPC
Copilot SDK → Copilot CLI → AI Models
```

### Key Components

**Session Management** (`src/session-manager.ts`)
- Each chat session = one Copilot SDK session
- Sessions can be active (in-memory client) or cached (metadata only)
- Tool factory creates tools with session context baked in
- Sessions maintain their own working directory (defaults to process.cwd())

**Tool Factory Pattern** (`server.ts`)
- Tools are created per-session with session context (cwd, sessionRef)
- Display tools emit `caco.*` events directly (queued until session.idle)
- Three tool categories: display tools, applet tools, agent tools
- Tools defined with `defineTool()` from `@github/copilot-sdk`

**Event System**
- SDK events flow: Copilot SDK → `sdk-event-parser.ts` → WebSocket clients
- Custom `caco.*` events queued per-session (`caco-event-queue.ts`)
- Events flushed to clients on `session.idle`
- WebSocket protocol documented in `doc/websocket.md`

**Storage Architecture** (`src/storage.ts`, `~/.caco/`)
```
~/.caco/
├── applets/          # User-created interactive components
│   └── <slug>/
│       ├── meta.json
│       ├── content.html
│       ├── script.js
│       └── style.css
├── sessions/         # Session state persistence
│   └── <session-id>/
│       ├── messages/     # Chat messages
│       ├── outputs/      # Tool outputs (embeds, etc.)
│       └── state.json    # Session metadata
└── usage.json        # Token usage tracking
```

**Frontend** (`public/ts/`)
- Single-page app with WebSocket for streaming
- Client state managed in `app-state.ts`
- Markdown rendering: marked.js + DOMPurify + highlight.js + mermaid.js
- Applet runtime: isolated iframes with state management

**Applets**
- Agent-created HTML/JS/CSS components stored in `~/.caco/applets/`
- Loaded via URL: `/?applet=<slug>&param=value`
- Can read/write state via applet tools (`get_applet_state`, `set_applet_state`)
- Agent creates applets using file tools (write meta.json, content.html, etc.)

### Module Responsibilities

| Module | Purpose |
|--------|---------|
| `session-manager.ts` | SDK session lifecycle (create, resume, send) |
| `session-state.ts` | Global session registry (active + cached) |
| `storage.ts` | File I/O for sessions, applets, outputs |
| `caco-event-queue.ts` | Per-session event queuing (flushed on idle) |
| `sdk-event-parser.ts` | Parse SDK events into WebSocket format |
| `applet-state.ts` | Track applet user state (navigation, reload) |
| `schedule-manager.ts` | Cron-based scheduled sessions |

## Key Conventions

### Tool Return Format
Tools return `{ textResultForLlm, resultType?, toolTelemetry? }` per SDK conventions.

### Event Types
- **SDK events**: `session.*`, `agent.*`, `client.*` (from Copilot SDK)
- **Custom events**: `caco.embed` (queued, emitted on session.idle)

### Session Working Directory
- Each session has a `cwd` (defaults to process.cwd())
- Tools operate in session cwd context
- **Warning**: Running parallel sessions that modify files in same cwd is dangerous

### Output Storage
- Display tools store outputs via `storeOutput(data, metadata)`
- Returns `outputId` for reference in tool result
- Stored in `~/.caco/sessions/<session-id>/outputs/<outputId>.{json,html,txt}`

### Test Structure
- Unit tests in `tests/unit/` (Vitest)
- Focus on pure logic extracted from I/O-heavy modules
- See `doc/testing.md` for coverage status and refactoring plan

### Code Quality Principles (from `doc/code-quality.md`)
- **Minimize complexity**: Less code is better code
- **Avoid coupling**: Global state and side effects are bad
- **Strong typing**: Catch issues at compile time
- **Extract pure functions**: Separate logic from I/O for testability
- Before adding features: "Can we get 90% with 10% of the code?"
- After fixing bugs: "What made this bug possible?"

### TypeScript Configuration
- Target: ES2022, Module: NodeNext
- Strict mode enabled
- Backend: `src/**/*.ts`, Frontend: `public/ts/**/*.ts` (excluded from tsconfig)
- Frontend bundled separately with esbuild

### ESLint Rules
- No unused vars (prefix with `_` to ignore)
- Prefer const, no var
- Semi-colons required, single quotes preferred
- Console allowed (server logs)

## Important Constraints

1. **Frontend/Backend Separation**: Frontend TypeScript (`public/ts/`) is bundled with esbuild, not tsc
2. **Applet Creation**: Agents create applets by writing files to `~/.caco/applets/<slug>/`, not through dedicated API
3. **Session Isolation**: Each session is independent; parallel file modifications in same cwd are unsafe
4. **Event Queuing**: `caco.*` events are queued and flushed on `session.idle`, not sent immediately
5. **Tool Context**: Tools must be created with session context (cwd, sessionRef) via tool factory

## Documentation

Primary docs in `doc/`:
- `API.md` - Complete HTTP API reference
- `websocket.md` - WebSocket protocol spec
- `session-management.md` - SDK session patterns
- `testing.md` - Test coverage status
- `code-quality.md` - Code quality principles
- See `doc/index.md` for full documentation index
