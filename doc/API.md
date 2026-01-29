# API Reference

Complete catalog of all APIs in Caco.

## HTTP Endpoints

All endpoints are prefixed with `/api/`.

### Sessions & Messages (RESTful API)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions` | POST | Create new session |
| `/api/sessions/:id/messages` | POST | Send message to session |

**POST /api/sessions** - Create new session
```json
{
  "cwd": "string (optional, defaults to server cwd)",
  "model": "string (optional)"
}
```
Returns: `{ sessionId: "uuid", cwd: "string", model: "string" }`

**POST /api/sessions/:id/messages** - Send message to session
```json
{
  "prompt": "string",
  "imageData": "data:image/...;base64,... (optional)",
  "appletState": "object (optional, batched state from applet)",
  "appletNavigation": "object (optional, navigation context)",
  "source": "'user' | 'applet' (optional, defaults to 'user')",
  "appletSlug": "string (optional, applet context for agent)"
}
```
Returns: `{ ok: true, sessionId: "uuid" }`

Response streams via WebSocket (not SSE).

### Session Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session` | GET | Get session info (accepts `?sessionId=`) |
| `/api/sessions` | GET | List all sessions with available models |
| `/api/sessions/:id/resume` | POST | Resume an existing session |
| `/api/sessions/:id` | DELETE | Delete a session |

**Headers:** All session endpoints accept `X-Client-ID` header for multi-client isolation.

### Preferences

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/preferences` | GET | Get user preferences |
| `/api/preferences` | POST | Update preferences |
| `/api/models` | GET | List available models from SDK |

Note: History is streamed via WebSocket on connect, not HTTP.

### Display Outputs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/outputs/:id` | GET | Get display output by ID |

Query params:
- `format=json` - Return as JSON with metadata

### Applet State

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/applet/state` | GET | Get current applet state (debug) |
| `/api/applet/state` | POST | Update applet state |

### Saved Applets

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/applets` | GET | List all saved applets |
| `/api/applets/:slug` | GET | Get applet content by slug |
| `/api/applets/:slug/load` | POST | Load applet + update server state |

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
| `/api/files/read` | GET | Read file as JSON (max 100KB, legacy) |
| `/api/files/write` | POST | Write file content (legacy) |

**GET /api/files** query params:
- `path` - Relative path from workspace root

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

**GET /api/files/read** (legacy) query params:
- `path` - Relative path to file
Returns: `{ path, content, size }`

**POST /api/files/write** (legacy) body:
```json
{
  "path": "relative/path/to/file",
  "content": "file content string"
}
```
Returns: `{ ok: true, path, size }`

Security: All file endpoints are locked to workspace root.

### Debug

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/debug/messages` | GET | Raw message structure |

---

## MCP Tools (Agent Tools)

Custom tools available to the Copilot agent.

### Applet Tools

Defined in `src/applet-tools.ts`

| Tool | Description |
|------|-------------|
| `applet_howto` | Get documentation for creating applets |
| `get_applet_state` | Query state pushed by applet JS |
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

**reload_page** - no parameters

**restart_server** parameters:
- `delay` (number, optional) - Seconds to wait before restart (1-30, default: 3)

### Display Tools

Defined in `src/display-tools.ts`

| Tool | Description |
|------|-------------|
| `render_file_contents` | Display file to user without reading into context |
| `run_and_display` | Run command and display output |
| `display_image` | Display image file |
| `embed_media` | Embed YouTube/Vimeo/SoundCloud/Spotify |

**render_file_contents** parameters:
- `path` (string, required) - Absolute file path
- `startLine` (number, optional) - First line (1-indexed)
- `endLine` (number, optional) - Last line (inclusive)
- `highlight` (string, optional) - Language for syntax highlighting

**run_and_display** parameters:
- `command` (string, required) - Shell command
- `cwd` (string, optional) - Working directory

**display_image** parameters:
- `path` (string, required) - Absolute path to image

**embed_media** parameters:
- `url` (string, required) - Media URL

Supported providers: YouTube, Vimeo, SoundCloud, Spotify, Twitter/X

---

## JavaScript APIs (Applet Runtime)

Global functions available to applet JavaScript code.

Defined in `public/ts/applet-runtime.ts`

### setAppletState(state)

Push state to server for agent to query.

```javascript
setAppletState({ 
  inputValue: document.getElementById('input').value,
  selectedOption: currentSelection
});
```

The agent can then query this state with `get_applet_state` tool.

### loadApplet(slug)

Load and display a saved applet.

```javascript
// Load calculator applet
await loadApplet('calculator');
```

Returns a Promise. Use for building applet browsers/launchers.

### listApplets()

Get list of saved applets.

```javascript
const applets = await listApplets();
// Returns: [{ slug, name, description, updatedAt }, ...]

applets.forEach(app => {
  console.log(`${app.name} (${app.slug})`);
});
```

### getSessionId()

Get the active chat session ID (for agent invocation).

```javascript
const sessionId = getSessionId();
// Returns: string | null (null if no active session)

if (sessionId) {
  console.log('Active session:', sessionId);
}
```

### sendAgentMessage(prompt, options?)

Send a message to the agent from applet JS. Creates an "applet" bubble (orange) in the chat.

```javascript
// Send a text message with current applet as context
await sendAgentMessage('Set the calculator value to 42');

// Send with explicit applet slug (legacy signature still works)
await sendAgentMessage('Load file /path/to/image.jpg', 'image-viewer');

// Send with image data (from canvas, file input, etc.)
const canvas = document.getElementById('myCanvas');
const imageData = canvas.toDataURL('image/png');
await sendAgentMessage('What do you see in this image?', { imageData });

// Send with both applet slug and image
await sendAgentMessage('Analyze this', { appletSlug: 'image-viewer', imageData });
```

**Options object:**
- `appletSlug?: string` - Applet context (defaults to current applet)
- `imageData?: string` - Base64 data URL (e.g., `data:image/png;base64,...`)

Returns a Promise that resolves when the message is sent (not when the agent responds).
The agent's response will stream to the chat as usual.

### Global Variables

| Variable | Description |
|----------|-------------|
| `appletContainer` | Reference to `.applet-content` element |

### DOM APIs

Applet JS runs in global scope with full DOM access:

```javascript
// All standard DOM APIs work
document.getElementById('myElement')
document.querySelector('.my-class')
document.querySelectorAll('button')

// Fetch API for HTTP requests
const response = await fetch('/api/applets');
const data = await response.json();

// Event handlers work with onclick
function handleClick() { /* ... */ }
// <button onclick="handleClick()">Click</button>
```

---

## WebSocket Events (Response Streaming)

Messages sent via WebSocket connection at `/ws?sessionId=xxx`.

### Server → Client Messages

| Type | Description |
|------|-------------|
| `message` | Chat message (user, assistant, or streaming update) |
| `activity` | Tool calls, intents, errors |
| `stateUpdate` | Applet state pushed from agent |
| `historyComplete` | History streaming finished |
| `pong` | Response to ping |

**ChatMessage structure:**
```json
{
  "id": "uuid",
  "role": "user | assistant",
  "content": "message text",
  "status": "streaming | complete (optional)",
  "deltaContent": "incremental text (optional)",
  "source": "user | applet (optional)",
  "appletSlug": "calculator (optional)",
  "outputs": ["output-id-1"] 
}
```

### Client → Server Messages

| Type | Description |
|------|-------------|
| `setState` | Push applet state to server |
| `getState` | Request current state |
| `ping` | Keep-alive |

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
