# Caco OS: UI revamp

## Requirements

One specification doc for UI states including applets.
Minimize UI state code, ideally single file.
URL can encode work state (session id + apps)
Rationalize non-visible but active state (applets and chat)

## ideas

? complete rewrite of consolidated NavigationAPI + viewController + applet
? combine newChat and chatting views into one logical view that manages its own state
? session view decoupled from chat view
? applet stack decoupled from chat view
? centralized URL modification management

## challenge

can views be decoupled while simultaneously encoding state in URL

---

# Proposals

## Option A: Two-Panel Always-Visible Layout

Instead of switching between mutually exclusive views, use a persistent layout:

```
┌─────────────┬──────────────────────────────────────┐
│             │                                      │
│  Sessions   │    Chat / Applet (swappable)         │
│  (sidebar)  │                                      │
│             │                                      │
│  - sess 1   │    [chat input]                      │
│  - sess 2   │                                      │
└─────────────┴──────────────────────────────────────┘
```

**Pros:**
- Sessions always visible (quick switching)
- Only one toggle: chat ↔ applet
- Simpler mental model

**Cons:**
- Less screen space for main content
- Mobile layout needs thought

**URL encoding:** `?session=abc&applet=browser` (both can coexist)

---

## Option B: Chat+Applet Split View

Main content area splits between chat and applet when both active:

```
┌──────────────────────┬───────────────────────────┐
│                      │                           │
│      Chat            │        Applet             │
│      (scrollable)    │        (interactive)      │
│                      │                           │
│  [chat input]        │                           │
└──────────────────────┴───────────────────────────┘
```

**Pros:**
- See chat and applet simultaneously
- Agent can update applet while chatting
- No context switching

**Cons:**
- Complexity: resizable panels, responsive breakpoints
- May be overkill for simple applets

**URL encoding:** `?session=abc&applet=browser&split=50`

---

## Option C: Unified URL Router (Minimal Rewrite)

Keep current layout but unify URL handling in one place:

```typescript
// Single source of truth for URL → state
type AppRoute = {
  session?: string;      // Active session
  applet?: string;       // Active applet (if any)
  appletParams?: Record<string, string>;  // Applet-specific state
};

// Navigation API handles ALL routing
navigation.addEventListener('navigate', (event) => {
  const route = parseUrl(event.destination.url);
  applyRoute(route);  // Updates both view-controller and app-state
});
```

**Pros:**
- Minimal UI change
- Consolidates URL logic
- Clear data flow

**Cons:**
- Still have exclusive view switching
- Doesn't solve chat+applet visibility

---

## Option D: Layered Architecture

Applets as overlays/modals on top of chat:

```
┌─────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────┐    │
│  │                                         │    │
│  │            Applet (modal)               │ X  │
│  │                                         │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│                 Chat (dimmed)                   │
│                                                 │
│  [chat input]                                   │
└─────────────────────────────────────────────────┘
```

**Pros:**
- Chat always there (context preserved)
- Applets feel transient
- Simple dismiss action

**Cons:**
- Limited applet visibility
- No side-by-side work

---

# Open Questions

1. **Should session sidebar always be visible?** 
   - Current: No, it's a toggle
   - Alternative: Yes, like Slack/Discord/ChatGPT

2. **Should chat and applet be viewable simultaneously?**
   - Current: No, exclusive toggle
   - Alternative: Split view or applet-as-sidebar

3. **Who owns URL state?**
   - Current: app-state.ts manages `session`, applet-runtime.ts manages `applet`
   - Alternative: Single URL router module

4. **What about mobile?**
   - Split views collapse to single panel
   - Swipe gestures for switching?

5. **History behavior for applet stack?**
   - Current: Navigation API + pushState for breadcrumbs
   - Is this worth the complexity?

---

# Recommendation

**Short-term:** Option C (Unified URL Router)
- Consolidate URL handling into single module
- Keep current UI layout
- Reduce bugs like the `?applet=` clearing issue

**Medium-term:** Option A (Two-Panel)
- Sessions sidebar always visible
- Main content toggles chat/applet
- Simpler state model

**Long-term exploration:** Option B (Split View)
- When user feedback demands simultaneous visibility
- Requires more design work

---

# current UI management

## Client UI State Management

Three mutually exclusive views:

| View | Element | Purpose |
|------|---------|---------|
| `sessions` | `#sessionView` | Session list (sidebar) |
| `chatting` | `#chatScroll` | Chat history + footer input |
| `newChat` | `#chatScroll` | Model selector + footer input |
| `applet` | `#appletView` | Applet stack with breadcrumbs |

Only ONE view is `.active` at a time. CSS handles visibility.

---

## view-controller.ts

Single source of truth for view state.

```typescript
type ViewState = 'sessions' | 'newChat' | 'chatting' | 'applet';

setViewState(state: ViewState)  // Atomically updates all DOM elements
getViewState(): ViewState       // Returns current state
isViewState(state): boolean     // Check current state
```

**What it does:**
- Toggles `.active` on view containers
- Toggles `.hidden` on chat/newChat/footer
- Toggles menu/applet button states
- Updates browser tab title

**Key principle:** All view transitions go through `setViewState()`. No direct DOM manipulation elsewhere.

---

## Applet Navigation

Applets use a stack model with breadcrumb trail:

```
Applet Browser > File Browser > config.yaml
```

### Navigation API

Modern browsers have a Navigation API that intercepts ALL navigation types in one handler:

```typescript
navigation.addEventListener('navigate', (event) => {
  const url = new URL(event.destination.url);
  const slug = url.searchParams.get('applet');
  
  if (slug) {
    event.intercept({
      handler: async () => {
        await loadAppletBySlug(slug);
        setViewState('applet');
      }
    });
  }
});
```

**Benefits:**
- Single handler catches links, back/forward, programmatic navigation
- URL stays in sync: `/?applet=file-browser`
- Browser history works naturally

### Breadcrumb Links

Breadcrumbs are simple `<a>` tags:

```html
<a href="?applet=applet-browser">Applet Browser</a> > 
<a href="?applet=file-browser">File Browser</a>
```

Navigation API intercepts the click, loads the applet, no page reload.

### Stack Management

- Navigate forward → hide current, push new to stack
- Navigate back → pop current, show previous (DOM preserved)
- Click breadcrumb → truncate stack to that point

**Limits:**
- Max depth: 5 applets
- Oldest destroyed when exceeded

---

## URL Parameters

| Param | Purpose |
|-------|---------|
| `session` | Active session ID |
| `applet` | Current applet slug |

Applet-specific params also allowed: `?applet=file-browser&path=/src`

---

## Files

| File | Purpose |
|------|---------|
| `public/ts/view-controller.ts` | **View state** - which view is active (sessions/newChat/chatting/applet) + DOM updates |
| `public/ts/app-state.ts` | **App state** - session ID, model, cwd, UI flags (isStreaming, loadingHistory) |
| `public/ts/applet-runtime.ts` | Applet stack, Navigation API handler, breadcrumbs |

**Separation of concerns:**
- `view-controller.ts` = what's visible (DOM classes)
- `app-state.ts` = data state (no DOM manipulation)
