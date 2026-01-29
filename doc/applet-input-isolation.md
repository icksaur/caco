# Applet Input Isolation Analysis

## Status: IMPLEMENTED ✅

We implemented **Option 4: Centralized Input Router** - a global keyboard dispatcher that routes events only to the active applet based on view state.

### Files Changed

- `public/ts/input-router.ts` - New file: global keyboard routing
- `public/ts/view-controller.ts` - Added `activeAppletSlug` tracking
- `public/ts/applet-runtime.ts` - Exposes `registerKeyHandler()` to applets
- `public/ts/main.ts` - Initializes input router on startup
- `~/.caco/applets/calculator/script.js` - Uses new API (no visibility checks!)

### How It Works

```
view-controller.ts          input-router.ts
┌───────────────────┐      ┌──────────────────────────┐
│ currentState      │      │ document.keydown         │
│ activeAppletSlug  │ ◄─── │                          │
└───────────────────┘      │ if (viewState === 'applet')
                           │   get handler for slug    │
                           │   call handler(event)     │
                           └──────────────────────────┘
```

1. `view-controller` tracks which view is active + which applet slug
2. `input-router` has one global `document.keydown` listener
3. When event fires, router checks active view/applet
4. Routes to registered handler (or ignores if not in applet view)

### Applet API

Before (manual filtering):
```javascript
document.addEventListener('keydown', function(e) {
  var tag = e.target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (!display.offsetParent) return;  // visibility check
  
  // Handle keys...
});
```

After (routed automatically):
```javascript
registerKeyHandler('calculator', function(e) {
  // Only called when calculator is the active applet
  // No visibility check needed!
  if (e.key >= '0' && e.key <= '9') appendNum(e.key);
  // ...
});
```

---

## Original Problem Statement

Applets currently run in the main document context, sharing the DOM with the chat UI. This causes input conflicts:

- **Keyboard events**: Typing in applet inputs may trigger chat form handlers
- **Global event listeners**: Applets that listen to `document.keydown` (like calculator) receive events even when chat is focused
- **Focus confusion**: No clear boundary between applet scope and parent app scope

### Current Workarounds

The calculator applet already implements manual filtering:

```javascript
document.addEventListener('keydown', function(e) {
  // Ignore if user is typing in an input or textarea
  var tag = e.target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  
  // Ignore if calculator is not visible (check offsetParent)
  if (!display.offsetParent) return;
  
  // Handle keys...
});
```

This works but requires every applet to remember these checks. Forgetting creates bugs.

---

## Current Architecture

### What Applets Use

Analysis of existing applets shows they use:

| API | Usage | iframe Impact |
|-----|-------|---------------|
| `setAppletState(obj)` | All applets | Needs postMessage bridge |
| `getAppletUrlParams()` | text-editor, image-viewer | Needs parent.location access |
| `onStateUpdate(cb)` | calculator | Needs postMessage bridge |
| `sendAgentMessage(msg)` | calculator | Needs postMessage bridge |
| `getSessionId()` | calculator | Needs postMessage bridge |
| `listApplets()` | applet-browser | Needs postMessage or fetch |
| `loadApplet(slug)` | applet-browser (via hrefs) | Navigation API issue |
| `fetch('/api/...')` | All applets | Works with same-origin |
| `document.*` | All applets | Works (in iframe context) |
| `window.AudioContext` | drum-machine | Works |

### Current Execution Model

```
main document
├── #chatView (chat UI, form handlers)
├── #appletView 
│   └── .applet-instance (div)
│       ├── [injected HTML]
│       ├── [injected CSS via <style>]
│       └── [injected JS via <script>]
```

JavaScript runs in main window context via `eval`-style script injection.

---

## Options Analysis

### Option 1: iframe with srcdoc

**How it works**: Render applet content into an `<iframe srcdoc="...">` instead of a div.

```html
<iframe 
  sandbox="allow-scripts allow-same-origin allow-forms"
  srcdoc="<!DOCTYPE html><html>...applet content...</html>">
</iframe>
```

**Pros**:
- Complete input isolation - iframe has own event loop
- Applet can't accidentally break parent UI
- Browser back/forward navigation works (iframe doesn't affect parent history)
- Natural focus boundary

**Cons**:
- Need postMessage bridge for all parent APIs
- Slightly more complex communication
- Can't easily share CSS variables with parent
- Navigation links need special handling

**Migration Effort**: HIGH
- Rewrite applet-runtime.ts injection logic
- Create postMessage API bridge
- Update all applet global APIs to use postMessage
- Test all 6 existing applets

### Option 2: Shadow DOM

**How it works**: Render applet inside a Shadow Root for style isolation.

```javascript
const shadow = container.attachShadow({ mode: 'open' });
shadow.innerHTML = appletContent.html;
```

**Pros**:
- Style isolation
- Familiar DOM APIs still work

**Cons**:
- **Does NOT isolate JavaScript execution** - still runs in main window
- **Does NOT isolate keyboard/mouse events** - events still bubble to document
- Only solves CSS conflicts, not input conflicts

**Verdict**: Does not solve the actual problem.

### Option 3: Keep Current + Stricter Conventions (Recommended for Now)

**How it works**: Improve the applet writing guidelines and helpers.

Add a helper to applet runtime:
```javascript
// Applet JS gets this helper
function onAppletKeydown(handler) {
  document.addEventListener('keydown', (e) => {
    if (!isAppletFocused()) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    handler(e);
  });
}
```

**Pros**:
- Minimal changes
- Current applets keep working
- Easy to understand

**Cons**:
- Applet authors can still make mistakes
- No true isolation - security implications if loading untrusted applets
- Global state pollution possible

**Migration Effort**: LOW

### Option 4: Centralized Input Router ✅ IMPLEMENTED

**How it works**: Single global keyboard listener in `input-router.ts`, routes to registered handlers based on view state.

**Pros**:
- Zero applet boilerplate - just register handler with slug
- View-controller already tracks active view
- Easy debugging - log which handler receives events
- Handlers auto-unregister when applet destroyed
- Native text inputs still work (router skips INPUT/TEXTAREA)

**Cons**:
- Applets must call `registerKeyHandler(slug, fn)` 
- Not full isolation (applets could still add global listeners)

**Migration Effort**: LOW
- Add input-router.ts (~60 lines)
- Extend view-controller to track applet slug
- Expose `registerKeyHandler` to applets
- Update one applet as example

**Verdict**: Best balance of isolation and simplicity. Implemented.

---

## What Breaks with iframe?

### Navigation

The applet-browser uses `<a href="?applet=slug">` links. Inside an iframe:
- Link clicks navigate the iframe, not the parent
- Need to use `target="_parent"` or postMessage

**Solution**: Add `target="_parent"` to applet links, or intercept clicks.

### WebSocket State Updates

`onStateUpdate()` subscribes to parent's WebSocket. In iframe:
- No access to parent's WebSocket
- Need postMessage bridge

**Solution**: 
```javascript
// In iframe
window.parent.postMessage({ type: 'subscribe-state' }, '*');
window.addEventListener('message', (e) => {
  if (e.data.type === 'state-update') callback(e.data.state);
});
```

### Session ID & Agent Messages

`getSessionId()` and `sendAgentMessage()` need parent context.

**Solution**: postMessage bridge for these too.

### URL Parameters

`getAppletUrlParams()` reads from parent's URL.

**Solution**: Parent passes params when creating iframe, or postMessage.

---

## Recommendation

**Implemented (Option 4)**: Centralized input router with `registerKeyHandler()`.

This gives us:
- Clean applet API - no visibility checks in applet code
- Single source of truth via view-controller
- Works with existing applet loading/navigation
- Easy migration path - update applets one at a time

**Long term (Option 1)**: Migrate to iframe-based isolation if:
- We want to load untrusted/third-party applets
- Need full JavaScript sandboxing
- Add complex applets that might pollute global state

### Why Not iframe Now?

1. **6 existing applets work fine** with current model + workarounds
2. **Migration is significant** - all APIs need postMessage bridges
3. **Simple applets stay simple** - current model is easy to write
4. **No security requirement yet** - all applets are self-authored

### If We Do iframe Later

The postMessage bridge pattern:

```javascript
// Parent (applet-runtime.ts)
const iframe = document.createElement('iframe');
iframe.srcdoc = buildAppletDocument(content);

window.addEventListener('message', (e) => {
  if (e.source !== iframe.contentWindow) return;
  
  switch (e.data.type) {
    case 'setAppletState':
      wsSetState(e.data.state);
      break;
    case 'sendAgentMessage':
      postAgentMessage(e.data.message);
      break;
    // etc.
  }
});

// In applet (injected preamble)
function setAppletState(state) {
  window.parent.postMessage({ type: 'setAppletState', state }, '*');
}
```

---

## Decision Matrix

| Criterion | Option 1 (iframe) | Option 3 (Helpers) | Option 4 (Router) ✅ |
|-----------|-------------------|-------------------|---------------------|
| Input isolation | ✅ Complete | ⚠️ Convention-based | ✅ Automatic routing |
| Migration effort | ❌ High | ✅ Low | ✅ Low |
| Applet simplicity | ⚠️ More ceremony | ⚠️ Manual checks | ✅ Just register |
| Security | ✅ Sandboxed | ❌ Full access | ❌ Full access |
| Current applets | ❌ Need updates | ✅ Work as-is | ✅ Work (can migrate) |

---

## Action Items

### Done ✅

1. Created `input-router.ts` with centralized keyboard routing
2. Extended `view-controller.ts` to track active applet slug  
3. Exposed `registerKeyHandler(slug, handler)` to applets
4. Exposed `getAppletSlug()` so applets know their slug
5. Updated calculator applet to use new API
6. Handlers auto-unregister when applet destroyed

### Remaining

1. Update other applets (drum-machine, etc.) if they use keyboard
2. Update applet_howto documentation with new pattern
3. Consider adding `registerMouseHandler()` if needed later

### Future (Option 1, if needed)

1. Design postMessage protocol for all applet APIs
2. Create iframe injection in applet-runtime.ts
3. Create applet preamble script with bridge functions
4. Migrate all applets to work with bridge
5. Test navigation, state sync, agent messaging
