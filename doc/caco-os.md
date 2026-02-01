# Caco OS: Client State Management

Simple client-side view state and navigation.

---

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
| `public/ts/view-controller.ts` | View state management |
| `public/ts/applet-runtime.ts` | Applet stack, Navigation API handler |
| `public/ts/app-state.ts` | Session state, URL session param |
