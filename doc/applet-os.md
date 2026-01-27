# Applet OS: Navigation and State

**Proposal for applet navigation history, breadcrumbs, and state persistence.**

See [applet.md](applet.md) for core applet architecture.

---

## Goal

Make applets feel like a tiny OS with navigation history:
- Breadcrumb trail showing navigation path
- Back button support (browser native)
- State restoration when returning to previous applet

---

## Breadcrumb Navigation

### Visual Design

```
┌─────────────────────────────────────────────────────┐
│ Applet Browser > File Browser > config.yaml        │
├─────────────────────────────────────────────────────┤
│                                                     │
│              (applet content)                       │
│                                                     │
└─────────────────────────────────────────────────────┘
```

Each segment is clickable, navigating back to that applet with its preserved state.

### Breadcrumb Data Structure

```typescript
interface BreadcrumbEntry {
  slug: string;           // Applet identifier (e.g., "file-browser")
  label: string;          // Display name (e.g., "File Browser")
  state: unknown;         // Applet-specific state to restore
}

// Example navigation:
const breadcrumbs: BreadcrumbEntry[] = [
  { slug: "applet-browser", label: "Applet Browser", state: null },
  { slug: "file-browser", label: "File Browser", state: { path: "/home/carl/project" } },
  { slug: "file-viewer", label: "config.yaml", state: { file: "/home/carl/project/config.yaml" } }
];
```

### Deduplication Logic

When navigating to an applet already in the stack, collapse to that point. **Always checked** (even with just 2 applets) to prevent navigation loops.

```
Before: Applet Browser > File Browser > File Viewer > File Browser
After:  Applet Browser > File Browser

Before: File Browser > File Browser  (immediate dupe)
After:  File Browser  (no-op, just update state)

// Algorithm:
function pushApplet(slug: string, label: string, content: AppletContent) {
  // Always check for existing - prevents loops like A > B > A > B > ...
  const existingIndex = appletStack.findIndex(a => a.slug === slug);
  if (existingIndex >= 0) {
    // Truncate: destroy all instances after the existing one
    while (appletStack.length > existingIndex + 1) {
      const popped = appletStack.pop()!;
      popped.element.remove();
    }
    // Show the existing instance (already in stack)
    appletStack[existingIndex].element.style.display = 'block';
    updateBreadcrumbUI();
    syncToUrl();
    return;  // Don't create new instance
  }
  
  // No dupe - create new instance
  // ... rest of push logic ...
}
```

---

## URL Integration

### Query Parameter Approach

Encode navigation state in URL for back button support:

```
/?applet=file-browser&nav=applet-browser,file-browser
```

Or with full state (base64 encoded):

```
/?applet=file-viewer&state=eyJmaWxlIjoiL2hvbWUvY2FybC9jb25maWcueWFtbCJ9
```

### Browser History API

Modern SPAs use `history.pushState()` and `popstate` event:

```javascript
// When applet changes, push to history
function navigateToApplet(slug: string, state: unknown) {
  const url = new URL(window.location.href);
  url.searchParams.set('applet', slug);
  
  // Store state in history (not URL - can be large)
  history.pushState(
    { slug, state, breadcrumbs: [...currentBreadcrumbs] },
    '',
    url.toString()
  );
  
  loadApplet(slug, state);
}

// Handle back/forward buttons
window.addEventListener('popstate', (event) => {
  if (event.state?.slug) {
    // Restore from history state
    currentBreadcrumbs = event.state.breadcrumbs || [];
    loadApplet(event.state.slug, event.state.state);
    updateBreadcrumbUI();
  }
});
```

### URL Considerations

| Approach | Pros | Cons |
|----------|------|------|
| **Query params only** | Simple, shareable URLs | State size limits (~2KB) |
| **History state object** | Large state OK, native back button | State lost on page refresh |
| **Hybrid** | Best of both | More complex |

**Recommendation**: Hybrid approach
- URL contains `?applet=slug` for shareability and basic back button
- `history.state` contains full state object for restoration
- On page load, if URL has `?applet=` but no history state, load applet fresh

---

## State Persistence

### The Challenge

User navigates: File Browser (in `/project/src`) → File Viewer → back to File Browser

**Goal**: File Browser should still be in `/project/src`, not reset to root.

### Chosen Approach: Keep-Alive DOM with Stack Cleanup

Instead of serializing state, keep applet DOM alive when navigating forward. Destroy on pop (back navigation).

```html
<div id="appletView">
  <div class="applet-instance" data-slug="applet-browser" style="display: none">
    <!-- preserved DOM, hidden -->
  </div>
  <div class="applet-instance" data-slug="file-browser" style="display: none">
    <!-- preserved DOM, hidden -->
  </div>
  <div class="applet-instance" data-slug="file-viewer" style="display: block">
    <!-- active applet, visible -->
  </div>
</div>
```

**Stack behavior:**

| Action | DOM Effect |
|--------|------------|
| Navigate forward | Hide current, create new instance |
| Navigate back (pop) | Destroy current, show previous |
| Click breadcrumb | Destroy all after target, show target |

**Benefits:**
- Perfect state preservation (DOM is untouched)
- No serialization contract needed
- Applets don't need to know about navigation
- Instant switching (no re-render)

**Memory bounded:**
- Typical depth: 2-3 applets (browser → file browser → editor)
- Pop always destroys, so stack can't grow unbounded
- Optional: cap at N instances, destroy oldest if exceeded

### Implementation

```typescript
interface AppletInstance {
  slug: string;
  label: string;
  element: HTMLElement;  // The .applet-instance div
}

const appletStack: AppletInstance[] = [];

function pushApplet(slug: string, label: string, content: AppletContent): void {
  // Hide current (don't destroy)
  const current = appletStack[appletStack.length - 1];
  if (current) {
    current.element.style.display = 'none';
  }
  
  // Create new instance
  const instance = document.createElement('div');
  instance.className = 'applet-instance';
  instance.dataset.slug = slug;
  appletView.appendChild(instance);
  
  // Render content into instance
  renderAppletContent(instance, content);
  
  // Dedupe: if slug already in stack, pop everything above it first
  const existingIndex = appletStack.findIndex(a => a.slug === slug);
  if (existingIndex >= 0) {
    // Destroy all instances after the existing one
    while (appletStack.length > existingIndex) {
      const popped = appletStack.pop()!;
      popped.element.remove();
    }
  }
  
  appletStack.push({ slug, label, element: instance });
  updateBreadcrumbUI();
  syncToUrl();
}

function popApplet(): void {
  if (appletStack.length <= 1) return;  // Can't pop last applet
  
  // Destroy current
  const current = appletStack.pop()!;
  current.element.remove();
  
  // Show previous
  const previous = appletStack[appletStack.length - 1];
  previous.element.style.display = 'block';
  
  updateBreadcrumbUI();
  syncToUrl();
}

function navigateToBreadcrumb(index: number): void {
  // Destroy all instances after target
  while (appletStack.length > index + 1) {
    const popped = appletStack.pop()!;
    popped.element.remove();
  }
  
  // Show target
  const target = appletStack[index];
  target.element.style.display = 'block';
  
  updateBreadcrumbUI();
  syncToUrl();
}
```

### Stack Depth Limit (Optional)

If worried about memory with deep stacks:

```typescript
const MAX_STACK_DEPTH = 5;

function pushApplet(slug: string, label: string, content: AppletContent): void {
  // ... create new instance ...
  
  // Enforce max depth - destroy oldest (bottom of stack)
  while (appletStack.length >= MAX_STACK_DEPTH) {
    const oldest = appletStack.shift()!;  // Remove from bottom
    oldest.element.remove();
  }
  
  appletStack.push({ slug, label, element: instance });
}
```

### URL Parameters for Applet State

Applets can receive initial state via URL query parameters:

```
/?applet=file-browser&path=/project/src&view=list
```

**Runtime provides** `getAppletUrlParams()` for applet JS:

```javascript
// In applet JS
const params = getAppletUrlParams();
if (params.path) {
  navigateToPath(params.path);
}
```

**Agent awareness**: When generating applet JS, agent should:
1. Check for URL params on load
2. Apply them as initial state
3. Optionally update URL when state changes (for shareability)

```javascript
// Pattern for agent-generated applets:
(function() {
  const params = getAppletUrlParams();
  
  // Initialize with URL state if present
  const initialPath = params.path || '/';
  loadDirectory(initialPath);
  
  // Update URL when user navigates (optional)
  function navigateTo(path) {
    loadDirectory(path);
    updateAppletUrlParam('path', path);
  }
})();
```

### Comparison with Alternatives

| Approach | State Fidelity | Memory | Complexity | Applet Changes |
|----------|---------------|--------|------------|----------------|
| **Keep-Alive + Pop Destroy** | Perfect | Bounded by depth | Low | None |
| Serialize/Restore | Partial | Minimal | Medium | Must implement contract |
| Always Destroy | None | Minimal | Low | None |

**Decision**: Keep-Alive with Pop Destroy. Stack depth is naturally shallow (3-4 max), and destroying on pop ensures cleanup.

---

## Implementation Plan

### Current State Analysis (applet-runtime.ts)

**What exists:**
- ✅ Single applet execution (`executeApplet()`)
- ✅ Applet cleanup (`clearApplet()`)
- ✅ URL param loading (`loadAppletFromUrl()`)
- ✅ Applet state push (`setAppletState()`)
- ✅ Global functions exposed (`loadApplet`, `listApplets`)
- ✅ CSS/JS injection with `data-applet` markers

**What's missing for stack-based navigation:**

| Gap | Current | Needed |
|-----|---------|--------|
| DOM structure | Single `.applet-content` | Multiple `.applet-instance` divs |
| Stack tracking | None | `AppletInstance[]` array |
| Style isolation | Global `<style>` in `<head>` | Style per instance (or scoped) |
| Script isolation | Global `<script>` | Script per instance (needs cleanup strategy) |
| Breadcrumb UI | None | Header breadcrumb trail |
| Navigation API | `loadApplet(slug)` only | `pushApplet()`, `popApplet()`, `navigateBack()` |
| URL sync | Read-only on load | `history.pushState()` + `popstate` handler |
| URL params | Slug only | `getAppletUrlParams()`, `updateAppletUrlParam()` |

---

### Phase 1: Stack-Based DOM Management

**Goal**: Multiple applet instances with hide/show instead of destroy/create.

#### 1.1 Add stack state to applet-runtime.ts

```typescript
// New types and state
interface AppletInstance {
  slug: string;
  label: string;
  element: HTMLElement;
  styleElement: HTMLStyleElement | null;
}

const MAX_STACK_DEPTH = 5;
const appletStack: AppletInstance[] = [];
```

#### 1.2 Refactor executeApplet → pushApplet

| Task | Description |
|------|-------------|
| Rename function | `executeApplet()` → internal `renderAppletToInstance()` |
| New `pushApplet()` | Wraps render, manages stack |
| Hide current | Before push, hide top of stack (don't destroy) |
| Create instance div | `<div class="applet-instance" data-slug="...">` |
| Dupe check | If slug exists in stack, truncate and show existing |
| Depth limit | If stack ≥ 5, `shift()` oldest from bottom |

#### 1.3 Add popApplet and navigateToBreadcrumb

```typescript
export function popApplet(): void {
  if (appletStack.length <= 1) return;
  const current = appletStack.pop()!;
  destroyInstance(current);
  showInstance(appletStack[appletStack.length - 1]);
  updateBreadcrumbUI();
  syncToUrl();
}

export function navigateToBreadcrumb(index: number): void {
  while (appletStack.length > index + 1) {
    destroyInstance(appletStack.pop()!);
  }
  showInstance(appletStack[index]);
  updateBreadcrumbUI();
  syncToUrl();
}
```

#### 1.4 Instance cleanup helper

```typescript
function destroyInstance(instance: AppletInstance): void {
  instance.element.remove();
  instance.styleElement?.remove();
  // Scripts with data-applet-slug="${slug}" also removed
  document.querySelectorAll(`script[data-applet-slug="${instance.slug}"]`)
    .forEach(el => el.remove());
}
```

#### 1.5 Update index.html structure

```html
<!-- Before -->
<div id="appletView" class="view">
  <div class="applet-header">Applet</div>
  <div class="applet-content"></div>
</div>

<!-- After -->
<div id="appletView" class="view">
  <div class="applet-header">
    <div class="applet-breadcrumbs"></div>
  </div>
  <!-- .applet-instance divs created dynamically -->
</div>
```

#### 1.6 Expose globals

```typescript
// In initAppletRuntime()
window.navigateToApplet = (slug: string) => loadApplet(slug);
window.navigateBack = popApplet;
window.getBreadcrumbs = () => appletStack.map(a => ({ slug: a.slug, label: a.label }));
```

**Files changed**: `applet-runtime.ts`, `index.html`

---

### Phase 2: Breadcrumb UI

**Goal**: Clickable breadcrumb trail in applet header.

#### 2.1 Render breadcrumbs from stack

```typescript
function updateBreadcrumbUI(): void {
  const container = document.querySelector('.applet-breadcrumbs');
  if (!container) return;
  
  const crumbs = appletStack.map((item, index) => {
    const isLast = index === appletStack.length - 1;
    const crumb = document.createElement('span');
    crumb.className = 'breadcrumb-item' + (isLast ? ' active' : '');
    crumb.textContent = item.label;
    if (!isLast) {
      crumb.onclick = () => navigateToBreadcrumb(index);
    }
    return crumb;
  });
  
  container.innerHTML = '';
  crumbs.forEach((crumb, i) => {
    container.appendChild(crumb);
    if (i < crumbs.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = ' > ';
      container.appendChild(sep);
    }
  });
}
```

#### 2.2 Breadcrumb overflow (5+ items)

```typescript
// If > 5 items: show first, "...", last 3
function renderCollapsedBreadcrumbs(): void {
  if (appletStack.length <= 5) {
    renderFullBreadcrumbs();
    return;
  }
  // A > ... > X > Y > Z
  const first = appletStack[0];
  const lastThree = appletStack.slice(-3);
  // Render: first, ellipsis, lastThree
}
```

#### 2.3 CSS for breadcrumbs

```css
.applet-breadcrumbs {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  color: #888;
}

.breadcrumb-item {
  cursor: pointer;
  color: #0e639c;
}
.breadcrumb-item:hover {
  text-decoration: underline;
}
.breadcrumb-item.active {
  cursor: default;
  color: #d4d4d4;
}

.breadcrumb-sep {
  color: #555;
}
```

**Files changed**: `applet-runtime.ts`, `style.css`, `index.html`

---

### Phase 3: URL Integration

**Goal**: Browser back button works, URLs are shareable.

#### 3.1 Sync URL on navigation

```typescript
function syncToUrl(): void {
  const current = appletStack[appletStack.length - 1];
  if (!current) return;
  
  const url = new URL(window.location.href);
  url.searchParams.set('applet', current.slug);
  
  // Don't create duplicate history entries
  if (url.toString() !== window.location.href) {
    history.pushState(
      { stack: appletStack.map(a => ({ slug: a.slug, label: a.label })) },
      '',
      url.toString()
    );
  }
}
```

#### 3.2 Handle popstate (back button)

```typescript
// In initAppletRuntime()
window.addEventListener('popstate', (event) => {
  const slug = new URLSearchParams(window.location.search).get('applet');
  if (slug) {
    // Check if it's in our current stack
    const index = appletStack.findIndex(a => a.slug === slug);
    if (index >= 0) {
      // Navigate to existing
      navigateToBreadcrumb(index);
    } else {
      // Load fresh (came from external link or refresh)
      loadAppletBySlug(slug);
    }
  }
});
```

#### 3.3 URL param helpers for applets

```typescript
export function getAppletUrlParams(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key !== 'applet') {  // Exclude the applet slug itself
      result[key] = value;
    }
  });
  return result;
}

export function updateAppletUrlParam(key: string, value: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  history.replaceState(history.state, '', url.toString());
}

// Expose globally
window.getAppletUrlParams = getAppletUrlParams;
window.updateAppletUrlParam = updateAppletUrlParam;
```

**Files changed**: `applet-runtime.ts`

---

### Phase 4: Server-Side Integration

**Goal**: Agent can query navigation state.

#### 4.1 Client sends stack with applet state

```typescript
// In getAndClearPendingAppletState or separate
export function getNavigationContext(): {
  stack: Array<{ slug: string; label: string }>;
  urlParams: Record<string, string>;
} {
  return {
    stack: appletStack.map(a => ({ slug: a.slug, label: a.label })),
    urlParams: getAppletUrlParams()
  };
}
```

#### 4.2 Update message POST to include navigation

```typescript
// In response-streaming.ts sendMessage
const body = {
  message,
  appletState: getAndClearPendingAppletState(),
  appletNavigation: getNavigationContext()  // NEW
};
```

#### 4.3 Update get_applet_state tool response

```typescript
// In applet-tools.ts
return {
  hasApplet: true,
  appletTitle: currentContent?.title,
  activeSlug: getActiveSlug(),
  userState: getAppletUserState(),
  stack: appletNavigation?.stack || [],      // NEW
  urlParams: appletNavigation?.urlParams || {} // NEW
};
```

**Files changed**: `applet-runtime.ts`, `response-streaming.ts`, `stream.ts`, `applet-tools.ts`, `applet-state.ts`

---

### Task Checklist

| # | Task | Phase | Est. |
|---|------|-------|------|
| 1 | Add `AppletInstance` interface and `appletStack` array | 1 | 10m |
| 2 | Refactor `executeApplet` → `pushApplet` with stack logic | 1 | 30m |
| 3 | Implement `popApplet()` and `destroyInstance()` | 1 | 15m |
| 4 | Implement `navigateToBreadcrumb(index)` | 1 | 10m |
| 5 | Add dupe detection (always check, truncate on match) | 1 | 10m |
| 6 | Add max depth limit (5, destroy oldest) | 1 | 5m |
| 7 | Update `index.html` with breadcrumb container | 2 | 5m |
| 8 | Implement `updateBreadcrumbUI()` | 2 | 20m |
| 9 | Add breadcrumb overflow (collapse middle) | 2 | 15m |
| 10 | Add breadcrumb CSS | 2 | 10m |
| 11 | Implement `syncToUrl()` with history.pushState | 3 | 15m |
| 12 | Add `popstate` event handler | 3 | 15m |
| 13 | Implement `getAppletUrlParams()` | 3 | 5m |
| 14 | Implement `updateAppletUrlParam()` | 3 | 5m |
| 15 | Expose navigation globals in `initAppletRuntime()` | 3 | 5m |
| 16 | Add `getNavigationContext()` export | 4 | 5m |
| 17 | Update message POST body with navigation | 4 | 10m |
| 18 | Update `get_applet_state` tool response | 4 | 10m |
| 19 | Update server to store navigation context | 4 | 10m |
| 20 | Test end-to-end flow | - | 30m |

**Total estimate**: ~4 hours

---

### Testing Plan

1. **Stack basics**: Push 3 applets, verify breadcrumbs show correctly
2. **Pop**: Click back on breadcrumb, verify previous applet shows with state intact
3. **Dupe prevention**: Navigate A → B → A, verify stack is just A (no B→A→B loops)
4. **Depth limit**: Push 6 applets, verify first one is destroyed
5. **Browser back**: Use browser back button, verify navigation works
6. **URL refresh**: Refresh page with `?applet=file-browser`, verify loads fresh
7. **URL params**: Verify `getAppletUrlParams()` returns non-applet params
8. **Agent query**: Send message, verify `get_applet_state` includes stack

---

## API Surface

### Navigation API (for applet JS)

```typescript
// Navigate to another applet (pushes to stack)
declare function navigateToApplet(slug: string): void;

// Navigate back one step (pops current, destroys it)
declare function navigateBack(): void;

// Get current breadcrumb trail (read-only)
declare function getBreadcrumbs(): Array<{ slug: string; label: string }>;

// Get URL params for current applet (e.g., ?applet=x&path=/foo → { path: '/foo' })
declare function getAppletUrlParams(): Record<string, string>;

// Update a URL param (for state sharing/bookmarking)
declare function updateAppletUrlParam(key: string, value: string): void;
```

### Runtime Functions (applet-runtime.ts)

```typescript
export function pushApplet(slug: string, label: string, content: AppletContent): void;
export function popApplet(): void;
export function navigateToBreadcrumb(index: number): void;
export function getAppletStack(): ReadonlyArray<{ slug: string; label: string }>;
export function getAppletUrlParams(): Record<string, string>;
export function updateAppletUrlParam(key: string, value: string): void;
```

**Note**: Applets don't need to implement any state management. DOM is preserved automatically.

### Agent-Queryable State

The `get_applet_state` tool will include navigation context:

```typescript
// Response from get_applet_state tool
{
  // Existing fields
  hasApplet: true,
  appletTitle: "File Browser",
  activeSlug: "file-browser",
  userState: { /* from setAppletState() */ },
  
  // New: navigation stack
  stack: [
    { slug: "applet-browser", label: "Applet Browser" },
    { slug: "file-browser", label: "File Browser" }
  ],
  
  // New: URL params
  urlParams: { path: "/project/src" }
}
```

This lets the agent understand what the user is looking at and how they got there.

---

## Example Flow

### User Journey

1. **Opens Applet Browser** (`?applet=applet-browser`)
   - Breadcrumbs: `Applet Browser`
   
2. **Clicks "File Browser"** → loads file-browser applet
   - Breadcrumbs: `Applet Browser > File Browser`
   - URL: `?applet=file-browser`
   - File Browser shows root `/`
   
3. **Navigates to `/project/src`** in File Browser
   - Breadcrumbs unchanged (same applet)
   - File Browser state: `{ path: "/project/src" }`
   
4. **Clicks `main.ts`** → loads file-viewer applet
   - Captures File Browser state before leaving
   - Breadcrumbs: `Applet Browser > File Browser > main.ts`
   - URL: `?applet=file-viewer`
   
5. **Clicks "File Browser" breadcrumb**
   - Truncates breadcrumbs: `Applet Browser > File Browser`
   - Restores state: navigates to `/project/src`
   - URL: `?applet=file-browser`
   
6. **Presses browser Back button**
   - `popstate` fires with file-viewer state
   - Loads file-viewer with `main.ts`
   - Breadcrumbs restored from history.state

---

## Design Decisions

| Question | Decision |
|----------|----------|
| **Max stack depth** | 5 applets. When exceeded, destroy oldest (bottom of stack). |
| **Breadcrumb display** | Show up to 5 items. Beyond that, collapse middle: `A > B > ... > Y > Z`. |
| **Dupe detection** | Always check (even at 2 applets). Prevents navigation loops. |
| **Cross-session** | No. Stack lost on refresh. URL param loads fresh. |
| **Agent awareness** | Yes. `get_applet_state` returns stack/breadcrumbs. |
| **Deep links** | Yes. URL params like `&path=/project/src` passed to applets. |
| **Timers in hidden** | Let them run. No pausing. |

---

## Open Questions

None currently.

---

## References

- [applet.md](applet.md) - Core applet architecture
- [History API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/History_API)
- [SPA Navigation Patterns](https://developer.chrome.com/docs/web-platform/navigation-api/)
