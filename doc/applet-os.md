# Applet OS: Navigation and State

Applet navigation history, breadcrumbs, and state persistence.

See [applet.md](applet.md) for core applet architecture.

---

## Overview

Applets have a tiny OS-like navigation system:
- **Breadcrumb trail** showing navigation path
- **Browser back/forward** button support
- **State preservation** when returning to previous applet
- **URL deep linking** with query parameters

```
┌─────────────────────────────────────────────────────┐
│ Applet Browser > File Browser > config.yaml        │
├─────────────────────────────────────────────────────┤
│                                                     │
│              (applet content)                       │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## Navigation Stack

Applets use a **keep-alive DOM with stack cleanup** approach:
- Navigate forward → hide current, create new instance
- Navigate back → destroy current, show previous (state preserved)
- Click breadcrumb → destroy all after target, show target

**Benefits:**
- Perfect state preservation (DOM untouched)
- No serialization needed
- Applets don't need to know about navigation
- Instant switching (no re-render)

**Stack limits:**
- Max depth: 5 applets
- When exceeded, oldest is destroyed
- Typical depth: 2-3 (browser → file browser → editor)

---

## Deduplication

When navigating to an applet already in the stack, the stack truncates to that point:

```
Before: Applet Browser > File Browser > File Viewer > File Browser
After:  Applet Browser > File Browser
```

This prevents navigation loops (A → B → A → B → ...).

---

## URL Integration

### Query Parameters

URL reflects current applet: `/?applet=file-browser`

Applets can use additional params for state: `/?applet=file-browser&path=/project/src`

### Navigation API (Current Implementation)

We use the modern Navigation API for SPA routing:

```javascript
navigation.addEventListener('navigate', (event) => {
  const url = new URL(event.destination.url);
  const slug = url.searchParams.get('applet');
  
  if (slug && event.canIntercept) {
    event.intercept({
      handler: async () => {
        await loadApplet(slug);
      }
    });
  }
});
```

**Benefits:**
- Single handler catches ALL navigation types (links, back/forward, programmatic)
- `navigation.navigate()` for programmatic navigation
- Clean state management with `updateCurrentEntry()`

---

## SPA URL Navigation Reference

### History API (Legacy)

Older approach, kept for reference:

```javascript
// Change URL without reload
history.pushState({ page: 1 }, '', '?applet=calculator');

// Listen for back/forward only
window.addEventListener('popstate', (event) => {
  const slug = new URLSearchParams(window.location.search).get('applet');
});
```

**Key points:**
- `pushState(state, unused, url)` - adds history entry
- `replaceState(state, unused, url)` - replaces current entry
- `popstate` fires only on back/forward, not on pushState
- State object available via `event.state` or `history.state`

### Navigation API (Modern Alternative)

Newer API (Chrome 102+, Firefox 147+, Safari 26.2+) designed for SPAs.

```javascript
// Navigate programmatically
navigation.navigate('?applet=calculator');

// Intercept all navigations (links, back/forward, programmatic)
navigation.addEventListener('navigate', (event) => {
  if (!event.canIntercept) return;
  
  event.intercept({
    async handler() {
      const url = new URL(event.destination.url);
      const slug = url.searchParams.get('applet');
      await loadApplet(slug);
    }
  });
});

// Access history entries
navigation.entries();
navigation.currentEntry;

// Update state without navigation
navigation.updateCurrentEntry({ state: newState });
```

**Advantages over History API:**
- Single `navigate` event catches ALL navigation types
- Better state management (`getState()`, `updateCurrentEntry()`)
- Cleaner API for SPA routing
- `traverseTo(key)` for jumping to specific entries

**Considerations:**
- Browser support: Not in older browsers
- Our current implementation uses History API for compatibility
- Could migrate to Navigation API when support is broader

### Fragment Identifiers (Hash)

Alternative for client-only state:

```javascript
// URL: /?applet=browser#/project/src
window.location.hash = '/project/src';

window.addEventListener('hashchange', (event) => {
  const path = window.location.hash.slice(1);
  // Update view based on path
});
```

**Trade-offs:**
- No server round-trip
- Works in all browsers
- Fragment not sent to server
- Less semantic than query params

---

## JavaScript API (for Applet JS)

```javascript
// Navigate to another applet (pushes to stack)
navigateToApplet(slug)

// Navigate back one step (pops current)
navigateBack()

// Get current breadcrumb trail
getBreadcrumbs()  // → [{ slug, label }, ...]

// Get URL params for current applet
getAppletUrlParams()  // → { path: '/foo', ... }

// Update a URL param (for state sharing)
updateAppletUrlParam(key, value)
```

---

## Agent Integration

The `get_applet_state` tool returns navigation context:

```json
{
  "hasApplet": true,
  "appletTitle": "File Browser",
  "activeSlug": "file-browser",
  "userState": { "selectedFile": "/path/to/file" },
  "stack": [
    { "slug": "applet-browser", "label": "Applet Browser" },
    { "slug": "file-browser", "label": "File Browser" }
  ],
  "urlParams": { "path": "/project/src" }
}
```

This lets the agent understand the user's navigation context.

---

## Design Decisions

| Question | Decision |
|----------|----------|
| Max stack depth | 5 applets. Oldest destroyed when exceeded. |
| Breadcrumb display | Up to 5 items. Collapse middle beyond that. |
| Dupe detection | Always check. Prevents navigation loops. |
| Cross-session | No. Stack lost on refresh. URL loads fresh. |
| Agent awareness | Yes. `get_applet_state` returns stack. |
| Deep links | Yes. URL params passed to applets. |
| Timers in hidden | Let them run. No pausing. |

---

## Files

Implementation in `public/ts/applet-runtime.ts`:
- `pushApplet()` / `popApplet()` - stack management
- `syncToUrl()` / Navigation API handler - URL sync
- `updateBreadcrumbUI()` - renders `<a href="?applet=slug">` links
- `getAppletUrlParams()` / `updateAppletUrlParam()`

Server-side in `src/applet-state.ts`:
- `getAppletNavigation()` - returns stack and URL params
- Included in message POST body for agent queries
