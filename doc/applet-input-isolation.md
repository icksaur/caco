# Applet Input Isolation Analysis

## Problem Statement

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

### Option 4: Web Components

**How it works**: Define applets as custom elements.

**Pros**:
- Modern standard
- Can combine with Shadow DOM

**Cons**:
- Still doesn't solve JavaScript isolation
- Significant rewrite of authoring model
- Overkill for the problem

**Verdict**: Adds complexity without solving core issue.

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

**Short term (Option 3)**: Add helper functions to reduce boilerplate in applets.

```javascript
// New helpers exposed to applets
function onAppletKeydown(handler) { ... }
function onAppletVisible(handler) { ... }
function isAppletActive() { ... }
```

Update applet_howto documentation with clear guidance.

**Long term (Option 1)**: Migrate to iframe-based isolation if:
- We want to load untrusted/third-party applets
- Input bugs keep recurring despite conventions
- We add more complex applets (games, editors)

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

| Criterion | Option 1 (iframe) | Option 3 (Helpers) |
|-----------|-------------------|-------------------|
| Input isolation | ✅ Complete | ⚠️ Convention-based |
| Migration effort | ❌ High | ✅ Low |
| Applet simplicity | ⚠️ More ceremony | ✅ Direct DOM |
| Security | ✅ Sandboxed | ❌ Full access |
| Current applets | ❌ Need updates | ✅ Work as-is |

---

## Action Items

### Immediate (Option 3)

1. Add `isAppletActive()` helper that checks visibility
2. Add `onAppletKeydown(handler)` helper with automatic filtering
3. Update applet_howto documentation
4. Refactor calculator to use new helper (as example)

### Future (Option 1, if needed)

1. Design postMessage protocol for all applet APIs
2. Create iframe injection in applet-runtime.ts
3. Create applet preamble script with bridge functions
4. Migrate all applets to work with bridge
5. Test navigation, state sync, agent messaging
