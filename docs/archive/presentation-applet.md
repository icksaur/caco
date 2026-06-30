# Presentation Applet

> Spec for a slide-deck applet that renders markdown slides in the Caco applet panel.

## Overview

A presentation applet that shows one slide at a time in the applet panel. Each slide is a markdown blob rendered using Caco's existing `renderMarkdownElement()` pipeline (supporting mermaid diagrams, syntax highlighting, etc.). Agents create and update presentations via MCP tools; the applet auto-updates on session change and tool execution, following the roadmap applet pattern.

## Goals

- Agent can create a slide deck and update individual slides with simple MCP tools
- User sees a monitor-aspect slide with prev/next navigation
- Applet auto-tracks the active session (like roadmap)
- Expand button fills available applet area
- Works with Caco's CSS theme variables
- Content clipped to slide boundaries (no overflow)

## Storage

**JSON file per session:** `~/.caco/sessions/<sessionId>/presentation.json`

```json
{
  "title": "My Presentation",
  "slides": [
    "# Welcome\n\nThis is slide 1",
    "## Architecture\n\n```mermaid\ngraph LR\n  A-->B\n```",
    "## Summary\n\n- Point 1\n- Point 2"
  ]
}
```

**Rationale:** JSON array of markdown strings is the simplest format for agents to produce. A single `setSessionData(sessionId, 'presentation', ...)` call writes the whole thing. Agents can set the entire deck in one tool call or update individual slides by index. No file-per-slide complexity, no delimiter parsing.

This follows the same pattern as roadmap storage: `getSessionData(sessionId, 'presentation')` / `setSessionData(sessionId, 'presentation', data)`.

## MCP Tools

Two new tools in a new `src/presentation-tool.ts`, following `roadmap-tool.ts` pattern:

### `get_presentation`

```
Parameters:
  sessionId?: string  (optional — read another session's presentation)

Returns:
  { title, slides: string[], slideCount } or { exists: false }
```

### `update_presentation`

```
Parameters:
  title?: string              — Set presentation title
  slides?: string[]           — Replace entire slide list
  addSlide?: string           — Append a slide (or insert at addSlideIndex)
  addSlideIndex?: number      — Insert position for addSlide
  updateSlideIndex?: number   — Index of slide to update
  updateSlide?: string        — New content for slide at updateSlideIndex
  removeSlideIndex?: number   — Remove slide at index
  removeAll?: boolean         — Delete the entire presentation

Returns:
  { title, slides, slideCount }
```

All parameters optional — set whatever you need in one call. Same ergonomics as `update_roadmap`. Max 100 slides enforced.

**Shared mutation logic:** Extract the add/update/remove slide logic into a pure `applyPresentationUpdate(existing, params)` function. Both the MCP tool handler and the PATCH REST route call it. Avoids logic drift.

**Tool description framing** (following session memory pattern):
> "Create or update a visual presentation for the current session. Use slides to explain architecture, show diagrams, present plans, or summarize findings. Each slide is markdown — supports mermaid diagrams, code blocks, lists, and headings."

### Registration

Tools registered in `server.ts` tool factory alongside roadmap tools. Same `SessionIdRef` pattern.

## REST API

### Session Data Index

A new generic endpoint to discover what data keys exist for a session, without fetching each blob:

```
GET  /api/sessions/:sessionId/data         → ["roadmap", "presentation"]  (NEW)
GET  /api/sessions/:sessionId/data/:name   → { ... }  (exists — needs sanitization)
PUT  /api/sessions/:sessionId/data/:name   → write/replace  (exists — needs sanitization)
```

**Security fix (blocking):** The existing `GET/PUT /data/:name` routes pass `:name` directly to `getSessionData` / `setSessionData` which joins it into a file path. A name like `../../foo` could read/write outside the session dir. Add validation to both existing routes and the new index route:

```typescript
const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
// In route handler:
if (!SAFE_NAME.test(name)) { res.status(400).json({ error: 'Invalid data name' }); return; }
```

Implementation in `storage.ts`:

```typescript
export function listSessionData(sessionId: string): string[] {
  const dir = getSessionDir(sessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json') && !RESERVED_NAMES.has(f.replace('.json', ''))
      && f !== 'notes.json')
    .map(f => f.replace('.json', ''));
}
```

This excludes `meta.json` (reserved) and `notes.json` (NDJSON format, not session data). Returns only data store keys like `roadmap`, `presentation`, etc.

The GET/PUT by name routes provide a generic data API. The typed helpers (`getSessionPresentation`, `getSessionRoadmap`) and typed PATCH routes remain for schema-aware updates. The generic routes are for discovery and simple read/write.

**Use cases:**
- Roadmap applet checks for presentation existence without fetching the full slide content
- Future applets can discover what data a session has
- Agents can list and inspect available session data stores

### Presentation Endpoints

Following the roadmap REST pattern in `src/routes/sessions.ts`:

```
GET    /api/sessions/:sessionId/presentation
PATCH  /api/sessions/:sessionId/presentation
```

GET returns the presentation JSON (or `{}`). PATCH accepts the same parameters as the MCP tool and applies them.

## Applet

### Files

```
applets/presentation/
├── meta.json
├── content.html
├── script.js
└── style.css
```

### meta.json

```json
{
  "slug": "presentation",
  "name": "Presentation",
  "description": "Session slide deck with markdown slides",
  "params": {},
  "stateSchema": {
    "get": {
      "hasPresentation": "boolean",
      "slideCount": "number",
      "currentSlide": "number"
    },
    "set": null
  }
}
```

### Behavior

- **Session tracking:** `appletAPI.onSessionChange()` loads presentation for active session. `appletAPI.onSessionEvent()` reloads on `session.idle` and `tool.execution_complete` where `toolName === 'update_presentation'`.
- **Initial load:** On applet open, reads `appletAPI.getSessionId()` and fetches presentation.
- **Slide rendering:** Each slide's markdown string is set as `textContent` of a container div, then `window.renderMarkdownElement(container)` is called. This gives full marked + DOMPurify + mermaid + hljs support for free.
- **Navigation:** Prev/Next buttons below the slide. Current slide index persisted in applet state. Keyboard: Left/Right arrows for prev/next.
- **Empty state:** "No presentation" message when no presentation exists.

### Layout

```
┌─────────────────────────────────┐
│  Title (if set)                 │
├─────────────────────────────────┤
│                                 │
│                                 │
│         Slide Content           │
│      (16:9 aspect ratio)        │
│      (overflow: hidden)         │
│                                 │
│                                 │
├─────────────────────────────────┤
│  ◀ Prev    3 / 12    Next ▶    │
└─────────────────────────────────┘
```

### Slide Container

- **Aspect ratio:** `aspect-ratio: 16/9` CSS property
- **Sizing:** `width: 100%; max-height: calc(100vh - 120px)` — fills available width, respects applet bounds
- **Overflow:** `overflow: hidden` — content clipped to slide boundaries
- **Background:** Uses `var(--color-bg-secondary)` from Caco theme
- **Text:** Uses `var(--color-text)` and other Caco theme variables
- **Padding:** Internal padding for content breathing room

### Expand / Sizing

The applet panel already has an expand button (Escape+,) that maximizes the panel. The slide container should simply fill 100% of the applet's available area — no custom expand button needed. The git-diff applet demonstrates this pattern: `height: 100%` on the root container fills the panel.

The slide itself uses `aspect-ratio: 16/9` and `max-width: 100%` within the container, centering vertically when the panel is taller than the slide. Content is clipped with `overflow: hidden`.

### Theme Integration

All colors via CSS variables:
- `var(--color-bg)`, `var(--color-bg-secondary)` — backgrounds
- `var(--color-text)`, `var(--color-text-dim)` — text
- `var(--color-border)` — borders
- `var(--color-accent)` — active states, links

No hardcoded colors. Works with any Caco theme or extension-provided theme.

## Roadmap Integration

When a session has a presentation, the roadmap applet shows a link at the top. Uses the data index endpoint to avoid fetching the full slide content:

```javascript
// In roadmap script.js, after loadRoadmap():
async function checkPresentation() {
  if (!sessionId) return;
  try {
    var res = await fetch('/api/sessions/' + sessionId + '/data');
    var keys = await res.json();
    if (keys.indexOf('presentation') !== -1) {
      presentationLink.innerHTML = '<a href="?applet=presentation">📊 Presentation</a>';
      presentationLink.style.display = '';
    } else {
      presentationLink.style.display = 'none';
    }
  } catch { presentationLink.style.display = 'none'; }
}
```

Lightweight — just a link, not a full embed.

## Images from Disk

**Current state:** The markdown renderer (`renderMarkdownElement`) uses `marked.parse()` which produces standard `<img src="...">` tags. DOMPurify does NOT forbid `img` tags or `src` attributes. The `/api/file` endpoint serves images with correct MIME types (jpg, png, gif, webp, svg).

**The gap:** Markdown image references like `![alt](./diagram.png)` produce `<img src="./diagram.png">` — relative to the page URL, not to any file path. Absolute paths like `![alt](C:\Users\...\image.png)` won't work because the browser can't load `file://` URLs.

**Solution (stretch goal):** Add a marked renderer override for images that rewrites `src` to `/api/file?path=<encoded>`:

```javascript
// In presentation applet script.js, before rendering:
// Rewrite image paths to use /api/file endpoint
function rewriteImagePaths(html) {
  return html.replace(/<img\s+src="([^"]+)"/g, function(match, src) {
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/api/')) return match;
    // Resolve relative paths against session CWD
    var resolved = src;
    if (!isAbsPath(src) && sessionCwd) {
      var sep = sessionCwd.indexOf('\\') >= 0 ? '\\' : '/';
      resolved = sessionCwd + sep + src;
    }
    return '<img src="/api/file?path=' + encodeURIComponent(resolved) + '"';
  });
}
```

This is presentation-applet-specific (not a global renderer change) and works for both absolute and CWD-relative image paths.

## Agent Discoverability

Agents learn about the presentation applet through three channels:

1. **MCP tool descriptions.** The `get_presentation` and `update_presentation` tools appear in the tool list with descriptive text. Agents see them alongside `get_roadmap` / `update_roadmap` and will use them when the task involves presenting or explaining visually.

2. **System prompt applet list.** The system prompt includes `Available applets: ..., presentation, ...` and tells agents to call `caco_applet_usage` for details. The `list_applets` tool returns the applet's `agentUsage.purpose` field, which should describe when to use it.

3. **Applet meta.json `agentUsage`.** Set a clear purpose string:
   ```json
   "agentUsage": {
     "purpose": "Display a slide deck for the session. Agents create slides via update_presentation tool. Supports markdown, mermaid diagrams, and code blocks."
   }
   ```

No system prompt changes needed — the existing applet discovery mechanism handles it. The MCP tool descriptions are the primary driver; agents will naturally link the tool output to the applet.

## Implementation Plan

1. **Session data index** — Add `listSessionData()` to `storage.ts`, add `GET /api/sessions/:id/data`, `GET /api/sessions/:id/data/:name`, `PUT /api/sessions/:id/data/:name` routes
2. **Storage + types** — Add `Presentation` interface to `storage.ts`, add `getSessionPresentation()` / `setSessionPresentation()` helpers
3. **MCP tools** — Create `src/presentation-tool.ts` with `get_presentation` and `update_presentation`
4. **REST routes** — Add GET/PATCH `/api/sessions/:id/presentation` to `sessions.ts`
5. **Applet** — Create `applets/presentation/` with meta.json, content.html, script.js, style.css
6. **Roadmap link** — Add presentation link to roadmap applet (uses data index endpoint)
7. **Client build** — No client bundle changes needed (applet is standalone JS)
8. **Stretch: image rewriting** — Add image path rewriting in applet script

## Risks

- **Large slide content:** A slide with a huge mermaid diagram or long code block may not fit in the clipped container. Mitigation: agents should keep slides focused. The expand button helps.
- **Mermaid async rendering:** `renderMarkdownElement` already handles mermaid async rendering. No additional work needed.
- **Theme consistency:** Mermaid diagrams use hardcoded dark theme colors in the renderer. If user has a light theme extension, diagrams may look wrong. This is a pre-existing issue, not presentation-specific.
