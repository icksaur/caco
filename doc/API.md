# API Reference

Complete catalog of all APIs in Caco.

## HTTP Endpoints

All endpoints are prefixed with `/api/`.

### Sessions & Messages

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session` | GET | Get session info (accepts `?sessionId=`) |
| `/api/sessions` | GET | List all sessions with available models |
| `/api/sessions` | POST | Create new session |
| `/api/sessions/:id/resume` | POST | Resume an existing session |
| `/api/sessions/:id` | DELETE | Delete a session |
| `/api/sessions/:id/state` | GET | Get session state (for agent-to-agent polling) |
| `/api/sessions/:id/messages` | POST | Send message to session |
| `/api/sessions/:id/cancel` | POST | Cancel current streaming |

**Headers:** All session endpoints accept `X-Client-ID` header for multi-client isolation.

**GET /api/session** query params:
- `sessionId` - Optional session ID (defaults to active session)

Returns:
```json
{
  "sessionId": "uuid | null",
  "cwd": "/path/to/workspace",
  "isActive": true,
  "hasMessages": true
}
```

**GET /api/sessions** - List all sessions

Returns:
```json
{
  "activeSessionId": "uuid | null",
  "currentCwd": "/path/to/cwd",
  "grouped": { "/path": [{ "id": "uuid", "cwd": "/path", "hasMessages": true }] },
  "models": [{ "id": "model-id", "name": "Model Name", "cost": 1 }]
}
```

**POST /api/sessions** - Create new session
```json
{
  "cwd": "string (optional, defaults to server cwd)",
  "model": "string (optional)"
}
```
Returns: `{ sessionId: "uuid", cwd: "string", model: "string" }`

**POST /api/sessions/:id/resume** - Resume session

Returns: `{ success: true, sessionId: "uuid", cwd: "string" }`

**DELETE /api/sessions/:id** - Delete session

Returns: `{ success: true, wasActive: true }`

**GET /api/sessions/:id/state** - Get session state (agent-to-agent)

Returns:
```json
{
  "sessionId": "uuid",
  "status": "idle | inactive",
  "cwd": "/path/to/workspace",
  "isActive": true
}
```

**POST /api/sessions/:id/messages** - Send message to session
```json
{
  "prompt": "string (required)",
  "imageData": "data:image/...;base64,... (optional)",
  "appletState": "object (optional, batched state from applet)",
  "appletNavigation": "object (optional, navigation context)",
  "source": "'user' | 'applet' | 'agent' (optional, defaults to 'user')",
  "appletSlug": "string (optional, applet context for agent)",
  "fromSession": "string (optional, for agent-to-agent calls)",
  "correlationId": "string (required for agent calls)"
}
```
Returns: `{ ok: true, sessionId: "uuid" }`

Response streams via WebSocket (not SSE).

**POST /api/sessions/:id/cancel** - Cancel streaming

Returns: `{ ok: true }`

### Preferences & Models

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/preferences` | GET | Get user preferences |
| `/api/preferences` | POST | Update preferences |
| `/api/models` | GET | List available models from SDK |
| `/api/usage` | GET | Get usage statistics |

**GET /api/preferences**

Returns: `{ preferenceKey: value, ... }`

**POST /api/preferences** - Update preferences

Body: `{ preferenceKey: newValue, ... }`
Returns: Updated preferences object

**GET /api/models**

Returns:
```json
{
  "models": [
    { "id": "gpt-4", "name": "GPT-4", "multiplier": 1 }
  ]
}
```

**GET /api/usage**

Returns:
```json
{
  "usage": {
    "totalTokens": 12345,
    "promptTokens": 8000,
    "completionTokens": 4345
  }
}
```

Note: History is streamed via WebSocket on connect, not HTTP.

### Display Outputs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/outputs/:id` | GET | Get display output by ID |
| `/api/tmpfile` | POST | Write temporary file to ~/.caco/tmp/ |

**GET /api/outputs/:id**

Query params:
- `format=json` - Return as JSON with metadata

Returns raw content with appropriate Content-Type, or JSON:
```json
{
  "id": "output-id",
  "data": "base64 or string",
  "metadata": { "type": "embed", "mimeType": "text/html" },
  "createdAt": "2026-01-27T12:00:00.000Z"
}
```

**POST /api/tmpfile** - Write temporary file

Body:
```json
{
  "data": "data:image/png;base64,... or raw base64",
  "mimeType": "image/png (optional, required if raw base64)",
  "filename": "custom.png (optional, auto-generated if omitted)"
}
```

Returns:
```json
{
  "ok": true,
  "path": "/home/user/.caco/tmp/abc123.png",
  "filename": "abc123.png",
  "size": 12345,
  "mimeType": "image/png"
}
```

### Applet State

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/applet/state` | GET | Get current applet state (debug) |
| `/api/applet/state` | POST | Update applet state |

### Saved Applets

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/applets` | GET | List all saved applets |
| `/api/applets/:slug/load` | POST | Load applet + clear server state |

**GET /api/applets** response:
```json
{
  "applets": [
    {
      "slug": "calculator",
      "name": "Calculator",
      "description": "iOS-style calculator",
      "updatedAt": "2026-01-27T...",
      "paths": {
        "html": ".Caco/applets/calculator/content.html",
        "js": ".Caco/applets/calculator/script.js",
        "css": ".Caco/applets/calculator/style.css",
        "meta": ".Caco/applets/calculator/meta.json"
      }
    }
  ]
}
```

### File Browser

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/files` | GET | List files in directory |
| `/api/file` | GET | Serve raw file content (max 10MB) |
| `/api/files/*` | PUT | Write file content (path in URL) |

**GET /api/files** query params:
- `path` - Relative path from workspace root

Returns:
```json
{
  "path": "src",
  "cwd": "/path/to/workspace",
  "files": [
    { "name": "app.ts", "type": "file", "size": 1234 },
    { "name": "lib", "type": "directory", "size": 0 }
  ]
}
```

**GET /api/file** query params:
- `path` - Relative path to file

Returns raw content with appropriate Content-Type header.

**PUT /api/files/\*** - Write file content
- URL path contains file path: `PUT /api/files/src/app.ts`
- Body: raw file content (text/plain)
- Creates parent directories automatically
- Returns: `{ ok: true, path, size }`

Example:
```bash
curl -X PUT http://localhost:3000/api/files/src/hello.txt \
  -H "Content-Type: text/plain" \
  -d "Hello, world!"
```

Security: All file endpoints are locked to workspace root.

### Scheduled Tasks

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/schedule` | GET | List all schedules |
| `/api/schedule/:slug` | GET | Get specific schedule |
| `/api/schedule/:slug` | PUT | Create or update schedule |
| `/api/schedule/:slug` | DELETE | Delete schedule |
| `/api/schedule/:slug/run` | POST | Manually trigger schedule |

**GET /api/schedule** - List all schedules

Returns:
```json
{
  "schedules": [
    {
      "slug": "daily-backup",
      "prompt": "Backup important files",
      "enabled": true,
      "schedule": { "type": "cron", "expression": "0 0 * * *" },
      "sessionConfig": { "model": "gpt-4", "persistSession": true },
      "lastRun": "2026-01-27T00:00:00.000Z",
      "lastResult": "success",
      "lastError": null,
      "nextRun": "2026-01-28T00:00:00.000Z",
      "sessionId": "uuid",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-27T00:00:00.000Z"
    }
  ]
}
```

**GET /api/schedule/:slug** - Get specific schedule

Returns: Same structure as single schedule in list above

**PUT /api/schedule/:slug** - Create or update schedule

Body:
```json
{
  "prompt": "string (required)",
  "enabled": true,
  "schedule": {
    "type": "cron | interval",
    "expression": "0 0 * * * (for cron)",
    "intervalMinutes": 60
  },
  "sessionConfig": {
    "model": "string (optional)",
    "persistSession": true
  }
}
```

Returns: `{ slug: "daily-backup", nextRun: "2026-01-28T00:00:00.000Z", created: true }`

**DELETE /api/schedule/:slug** - Delete schedule

Returns: `{ success: true }`

**POST /api/schedule/:slug/run** - Manually trigger

Returns: `{ slug: "daily-backup", status: "executed", sessionId: "uuid" }`

### MCP Tools (HTTP Proxy)

HTTP endpoints for applet JS to call MCP tools directly.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mcp/tools` | GET | List available MCP tools |
| `/api/mcp/read_file` | POST | Read file contents |
| `/api/mcp/write_file` | POST | Write file contents |
| `/api/mcp/list_directory` | POST | List directory contents |

**Allowed directories:** Current workspace, `~/.caco/`, `/tmp/`

**GET /api/mcp/tools** - List available tools

Returns:
```json
{
  "tools": [
    { "name": "read_file", "description": "Read file contents", "parameters": { "path": "string" } },
    { "name": "write_file", "description": "Write file contents", "parameters": { "path": "string", "content": "string" } },
    { "name": "list_directory", "description": "List directory contents", "parameters": { "path": "string" } }
  ],
  "allowedDirectories": ["/current/cwd", "/home/user/.caco", "/tmp"]
}
```

**POST /api/mcp/read_file** - Read file

Body: `{ "path": "/path/to/file.txt" }`
Returns: `{ ok: true, content: "file contents" }`

**POST /api/mcp/write_file** - Write file

Body: `{ "path": "/path/to/file.txt", "content": "new content" }`
Returns: `{ ok: true, path: "/path/to/file.txt" }`

**POST /api/mcp/list_directory** - List directory

Body: `{ "path": "/path/to/dir" }`
Returns:
```json
{
  "ok": true,
  "files": [
    { "name": "file.txt", "path": "/path/to/dir/file.txt", "isDirectory": false, "size": 123, "modified": "2026-01-27T12:00:00.000Z" }
  ]
}
```

### Shell Execution

Execute allowlisted shell commands for applets and developer tools.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/shell` | POST | Execute shell command |

**POST /api/shell** - Execute command

Body:
```json
{
  "command": "git",
  "args": ["status", "--porcelain=v2"],
  "cwd": "/optional/working/directory"
}
```

Returns (success):
```json
{
  "stdout": "1 M. N... 100644 src/file.ts\n",
  "stderr": "",
  "code": 0
}
```

Returns (command error, e.g., not a git repo):
```json
{
  "stdout": "",
  "stderr": "fatal: not a git repository\n",
  "code": 128
}
```

**Security:**
- Uses `execFile` with args array (no shell metacharacter interpretation)
- Working directory must be absolute path and exist
- Timeout: 60s, max output: 10MB

**Output sanitization:**
- ANSI escape codes stripped
- CRLF normalized to LF
- Carriage returns removed

See [shell-api.md](shell-api.md) for full specification.

### Debug

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/debug/messages` | GET | Raw message structure |

Returns:
```json
{
  "count": 5,
  "messages": [
    { "type": "user.message", "content": "Hello", "hasToolRequests": false }
  ]
}
```

---

## Agent Tools (Custom MCP Tools)

Custom tools available to the Copilot agent via SDK.

### Applet Tools

Defined in `src/applet-tools.ts`

| Tool | Description |
|------|-------------|
| `applet_howto` | Get documentation for creating applets |
| `get_applet_state` | Query state pushed by applet JS |
| `set_applet_state` | Push state to running applet via WebSocket |
| `reload_page` | Trigger browser page refresh |
| `restart_server` | Schedule server restart after delay |

**applet_howto** - no parameters

Returns comprehensive documentation on:
- File structure (`.Caco/applets/<slug>/`)
- Required files (meta.json, content.html) and optional (script.js, style.css)
- JavaScript APIs available (setAppletState, loadApplet, listApplets)
- How to share applets via URL (`?applet=slug`)

**get_applet_state** parameters:
- `key` (string, optional) - Get specific key instead of full state

Returns: State object + navigation context (stack, urlParams)

**set_applet_state** parameters:
- `data` (object, required) - State object to push to applet
- `sessionId` (string, optional) - Target session (broadcasts to all if omitted)

Pushes state via WebSocket to running applet. Applet receives via `onStateUpdate()` callback.

**reload_page** - no parameters

Sends reload signal to browser.

**restart_server** parameters:
- `delay` (number, optional) - Seconds to wait before restart (1-30, default: 3)

Schedules graceful restart, waiting for active sessions to complete.

### Display Tools

Defined in `src/display-tools.ts`

| Tool | Description |
|------|-------------|
| `embed_media` | Embed YouTube/Vimeo/SoundCloud/Spotify |

**embed_media** parameters:
- `url` (string, required) - Media URL

Supported providers: YouTube, Vimeo, SoundCloud, Spotify, Twitter/X

Note: Embedding happens client-side. The tool returns confirmation that the embed was queued, but cannot confirm successful rendering.

---

## JavaScript APIs (Applet Runtime)

Global functions available to applet JavaScript code via `window.appletAPI` or legacy globals.

Defined in `public/ts/applet-runtime.ts`

### API Access

All APIs are available on `window.appletAPI`:
```javascript
const { setAppletState, sendAgentMessage, listApplets } = window.appletAPI;
```

Legacy globals also work for backward compatibility:
```javascript
setAppletState({ key: 'value' });  // window.setAppletState
expose('myFunc', myFunc);           // window.expose
```

### State Management

#### setAppletState(state)

Push state to server for agent to query via `get_applet_state` tool.

```javascript
setAppletState({ 
  inputValue: document.getElementById('input').value,
  selectedOption: currentSelection
});
```

Uses WebSocket when connected for real-time sync.

#### onStateUpdate(callback)

Receive state updates pushed by agent via `set_applet_state` tool.

```javascript
onStateUpdate((state) => {
  console.log('Agent pushed state:', state);
  document.getElementById('result').textContent = state.result;
});
```

### Navigation

#### loadApplet(slug)

Load and display a saved applet.

```javascript
await loadApplet('calculator');
```

#### listApplets()

Get list of saved applets.

```javascript
const applets = await listApplets();
// Returns: [{ slug, name, description, updatedAt }, ...]
```

#### getAppletSlug()

Get current applet slug from URL.

```javascript
const slug = getAppletSlug();
// Returns: string | null ('calculator' if URL is /?applet=calculator)
```

#### getAppletUrlParams()

Get URL query params (excluding 'applet' slug).

```javascript
const params = getAppletUrlParams();
// { file: '/path/to/file.jpg', mode: 'edit' }
```

#### updateAppletUrlParam(key, value)

Update URL query param (uses replaceState, no history entry).

```javascript
updateAppletUrlParam('page', '2');
// URL becomes /?applet=my-app&page=2
```

### Agent Communication

#### sendAgentMessage(prompt, appletSlug?)

Send a message to the agent from applet JS. Creates an "applet" bubble (orange) in the chat.

```javascript
// Send a message with current applet as context
await sendAgentMessage('Set the calculator value to 42');

// Send with explicit applet slug
await sendAgentMessage('Load file /path/to/image.jpg', 'image-viewer');
```

Returns a Promise that resolves when message is sent (not when agent responds).

#### getSessionId()

Get the active chat session ID.

```javascript
const sessionId = getSessionId();
// Returns: string | null
```

### File Operations

#### saveTempFile(dataUrl, options?)

Save image data to `~/.caco/tmp/` for agent viewing.

```javascript
const canvas = document.getElementById('myCanvas');
const { path } = await saveTempFile(canvas.toDataURL('image/png'));
await sendAgentMessage(`Analyze image at ${path}`);
```

Options:
- `filename` (string, optional) - Custom filename
- `mimeType` (string, optional) - MIME type if using raw base64

#### callMCPTool(toolName, params)

Call MCP tools directly from applet JavaScript.

```javascript
// Read a file
const result = await callMCPTool('read_file', { path: '/path/to/file.txt' });

// Write a file
await callMCPTool('write_file', { 
  path: '/path/to/output.txt', 
  content: 'Hello world' 
});

// List directory
const files = await callMCPTool('list_directory', { path: '/home/user' });
```

### Function Exposure

#### expose(name, fn) / expose({ fn1, fn2 })

Expose functions to global scope for onclick handlers.

```javascript
// Scripts are wrapped in IIFE, so functions aren't automatically global
function handleClick() { /* ... */ }
expose('handleClick', handleClick);  // Now onclick="handleClick()" works

// Or expose multiple at once:
expose({ handleClick, handleSubmit, handleCancel });
```

**Alternative (recommended):** Use addEventListener instead:
```javascript
document.getElementById('btn').addEventListener('click', handleClick);
```

### Global Variables

| Variable | Description |
|----------|-------------|
| `appletContainer` | Reference to `.applet-content` element |

### DOM APIs

Applet JS runs in global scope with full DOM access:

```javascript
document.getElementById('myElement')
document.querySelector('.my-class')
document.querySelectorAll('button')

// Fetch API for HTTP requests
const response = await fetch('/api/applets');
const data = await response.json();
```

---

## WebSocket Events (Response Streaming)

WebSocket connection at `/ws?sessionId=xxx&clientId=yyy`.

### Connection

Connect with session ID and optional client ID:
```javascript
const ws = new WebSocket(`ws://localhost:3000/ws?sessionId=${sessionId}&clientId=${clientId}`);
```

On connect, server streams conversation history automatically.

### Server → Client Messages

| Type | Description |
|------|-------------|
| `message` | Chat message (user, assistant, or streaming update) |
| `activity` | Tool calls, intents, errors |
| `stateUpdate` | Applet state pushed from agent |
| `historyComplete` | History streaming finished |
| `reload` | Browser should refresh |
| `pong` | Response to ping |

**ChatMessage structure:**
```json
{
  "type": "message",
  "data": {
    "id": "uuid",
    "role": "user | assistant",
    "content": "message text",
    "status": "streaming | complete",
    "deltaContent": "incremental text (streaming only)",
    "source": "user | applet | agent",
    "appletSlug": "calculator",
    "fromSession": "uuid (agent-to-agent)",
    "outputs": ["output-id-1"]
  }
}
```

**Activity structure:**
```json
{
  "type": "activity",
  "data": {
    "type": "tool_start | tool_complete | intent | error",
    "toolName": "embed_media",
    "toolInput": { "url": "..." },
    "toolOutput": "...",
    "intentText": "Thinking about..."
  }
}
```

**StateUpdate structure:**
```json
{
  "type": "stateUpdate",
  "data": {
    "key": "value"
  }
}
```

### Client → Server Messages

| Type | Description |
|------|-------------|
| `setState` | Push applet state to server |
| `getState` | Request current state |
| `ping` | Keep-alive |

**setState:**
```json
{
  "type": "setState",
  "data": { "key": "value" }
}
```

**getState:**
```json
{
  "type": "getState"
}
```

---

## URL Parameters

| Parameter | Description |
|-----------|-------------|
| `?applet=slug` | Load applet on page load |

Example: `http://localhost:3000/?applet=calculator`

---

## File Storage

### Applet Storage Structure

Location: `.Caco/applets/<slug>/`

```
.Caco/
└── applets/
    └── calculator/
        ├── meta.json      # { slug, name, description, createdAt, updatedAt }
        ├── content.html   # HTML content
        ├── script.js      # JavaScript
        └── style.css      # CSS styles
```

The `.Caco/` directory has its own git repository, separate from the main project.
