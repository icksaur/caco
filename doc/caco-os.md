# Caco OS: UI revamp

## Requirements

One specification doc for UI states including applet.
Minimize UI state code, ideally single file.
URL can encode work state (session id + applet)
Rationalize non-visible but active state (applet and chat)
Applets and chat can co-exist with UI to switch without losing applet nor chat state.

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
   - **Decision: NO** - iOS won't fit
   - Keep current toggle approach

2. **Should chat and applet be viewable simultaneously?**
   - **Decision: YES on desktop** - useful for agent-applet workflows
   - Collapse to single panel on mobile

3. **Who owns URL state?**
   - **Decision: Single owner** - consolidate into one module
   - No more split between app-state.ts and applet-runtime.ts

4. **What about mobile?**
   - **Target: iOS Safari**
   - Single panel, no split views
   - Session list as overlay/drawer

5. **History behavior for applet stack?**
   - **Decision: SIMPLIFY** - get rid of breadcrumb history!
   - Just show current applet, browser back = close applet
   - No stack, no complexity

---

# Recommendation

**Revised approach based on decisions:**

1. **Single URL router** - one module owns all URL params
2. **Desktop split view** - chat + applet side by side (optional)
3. **Mobile single panel** - toggle between chat/applet, iOS Safari first
4. **No applet stack** - just current applet, back = close
5. **Session toggle overlay** - not always-visible sidebar

This is simpler than any of Options A-D. Call it **Option E: Minimal SPA**.

```
Desktop:                          Mobile:
┌────────────────┬───────────┐    ┌─────────────────┐
│                │           │    │                 │
│     Chat       │  Applet   │    │  Chat OR Applet │
│                │  (opt)    │    │                 │
│                │           │    │  [input]        │
│  [input]       │           │    └─────────────────┘
└────────────────┴───────────┘
```

---

## URL Philosophy: Bookmark, Not Controller

**Key insight:** URL is for sharing/bookmarking, not for controlling app state destruction.

**URL format:** `?session=abc&applet=browser`

**Rules:**
1. Navigating TO `?applet=X` → loads/shows applet X
2. Navigating AWAY from `?applet=` → hides applet, does NOT destroy it
3. Session is NEVER closed by URL changes
4. Chat state persists regardless of URL

**Result:** Both chat and applet co-exist in memory. URL just controls visibility/focus.

```
URL: ?session=abc                → show chat, applet hidden but alive
URL: ?session=abc&applet=browser → show applet (or split view), chat alive
URL: ?session=abc&applet=files   → switch to different applet, browser preserved? (TBD)
```

**Open question:** Do we preserve multiple applets in memory, or just one?
- Simple: Only one applet at a time (switching destroys previous)
- Complex: Keep N applets alive (like browser tabs)

For now: **One applet at a time, but chat always persists.**

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
