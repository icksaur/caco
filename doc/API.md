# API Reference

Complete catalog of all APIs in copilot-web.

## HTTP Endpoints

All endpoints are prefixed with `/api/`.

### Streaming & Messages

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/message` | POST | Send a message, get a streamId for SSE |
| `/api/stream/:streamId` | GET | SSE connection for response streaming |

**POST /api/message**
```json
{
  "prompt": "string",
  "model": "string (optional)",
  "imageData": "data:image/...;base64,... (optional)",
  "newChat": "boolean (optional)",
  "cwd": "string (optional, for new chats)",
  "appletState": "object (optional, batched state from applet)"
}
```
Returns: `{ streamId: "uuid" }`

### Sessions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session` | GET | Get current active session info |
| `/api/sessions` | GET | List all sessions with available models |
| `/api/sessions/new` | POST | Create a new session |
| `/api/sessions/:sessionId/resume` | POST | Resume an existing session |
| `/api/sessions/:sessionId` | DELETE | Delete a session |

### Preferences & History

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/preferences` | GET | Get user preferences |
| `/api/preferences` | POST | Update preferences |
| `/api/history` | GET | Get conversation history as HTML |
| `/api/models` | GET | List available models from SDK |

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
        "html": ".copilot-web/applets/calculator/content.html",
        "js": ".copilot-web/applets/calculator/script.js",
        "css": ".copilot-web/applets/calculator/style.css",
        "meta": ".copilot-web/applets/calculator/meta.json"
      }
    }
  ]
}
```

### File Browser

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/files` | GET | List files in directory |
| `/api/files/read` | GET | Read file content (max 100KB) |

**GET /api/files** query params:
- `path` - Relative path from workspace root

**GET /api/files/read** query params:
- `path` - Relative path to file

Security: Both endpoints are locked to workspace root.

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
| `set_applet_content` | Create interactive UI with HTML/JS/CSS |
| `get_applet_state` | Query state pushed by applet JS |
| `save_applet` | Save current applet to disk |
| `load_applet` | Load saved applet by slug |
| `list_applets` | List all saved applets with file paths |
| `reload_page` | Trigger browser page refresh |

**set_applet_content** parameters:
- `html` (string, required) - HTML content
- `js` (string, optional) - JavaScript to execute
- `css` (string, optional) - CSS styles
- `title` (string, optional) - Applet title

**get_applet_state** parameters:
- `key` (string, optional) - Get specific key instead of full state

**save_applet** parameters:
- `slug` (string, required) - URL-safe identifier
- `name` (string, required) - Display name
- `description` (string, optional) - Brief description

**load_applet** parameters:
- `slug` (string, required) - Applet to load

**list_applets** - no parameters

**reload_page** - no parameters

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

## SSE Events (Response Streaming)

Events sent from `/api/stream/:streamId`.

| Event | Description |
|-------|-------------|
| `assistant.message_delta` | Incremental text content |
| `assistant.message` | Final message content |
| `assistant.turn_start` | New turn beginning |
| `assistant.intent` | Agent's stated intent |
| `tool.execution_start` | Tool call starting |
| `tool.execution_complete` | Tool call finished |
| `session.error` | Error occurred |
| `session.idle` | Session ready for next message |
| `done` | Stream complete |

**Special data in tool.execution_complete:**
- `_output` - Display output reference
- `_applet` - Applet content to execute
- `_reload` - Signal to reload page

---

## URL Parameters

| Parameter | Description |
|-----------|-------------|
| `?applet=slug` | Load applet on page load |

Example: `http://localhost:3000/?applet=calculator`

---

## File Storage

### Applet Storage Structure

Location: `.copilot-web/applets/<slug>/`

```
.copilot-web/
└── applets/
    └── calculator/
        ├── meta.json      # { slug, name, description, createdAt, updatedAt }
        ├── content.html   # HTML content
        ├── script.js      # JavaScript
        └── style.css      # CSS styles
```

The `.copilot-web/` directory has its own git repository, separate from the main project.
