# Session-surface cookbook

Patterns and reference for writing `customScript` / `customStyle` payloads for the session-surface applet. Companion to [`session-surface-applet.md`](./session-surface-applet.md) (the protocol) and [`collab-state-spec.md`](./collab-state-spec.md) (the data model).

Audience: an agent (or human) writing a surface that should feel like a native Caco panel.

---

## API the applet hands you

Your `customScript` is wrapped as `new Function('surface', 'root', 'mutateChange', 'appletAPI', script + 'if (typeof render === "function") return render;')`. So inside your script you have four globals available — and **only** these four:

- **`surface`** — `{ dataToken, style, items: [...], changes: {...}, customScript, customStyle }`. Read-only snapshot.
- **`root`** — the DOM element to render into.
- **`mutateChange(itemId, fullItem)`** — write a human-side change. Takes the item id and the **entire merged item** as second arg. The applet POSTs to the server, handles stale tokens internally, then re-runs `render()` with the fresh snapshot.
- **`appletAPI`** — Caco's general applet API (toasts, etc).

**Do NOT call `surface.putChange(...)`** — that function does not exist. The mutation API is `mutateChange(id, item)` only.

You must define `function render(surface) { ... }` at the top level. The applet calls it on every state change.

---

## Visual conventions

Caco is a dark-themed single-page app. Surfaces look "at home" when they reuse Caco's CSS custom properties, sans-serif body type, and modest visual hierarchy. The applet-browser is a good template: rounded card per item, name + slug on one line, muted description below, gentle hover lift.

### Typeface

Everything is one sans-serif stack. No mixing fonts unless rendering code.

```css
font-family: var(--font-sans);  /* body, labels, slugs */
font-family: var(--font-mono);  /* code blocks, file paths */
```

### Text sizes

Use the scale, not arbitrary px:

```css
font-size: var(--text-xs);   /* 0.75rem — slugs, badges, metadata */
font-size: var(--text-sm);   /* 0.85rem — descriptions, secondary text */
font-size: var(--text-base); /* 1rem — body copy */
font-size: var(--text-lg);   /* 1.1rem — card titles */
font-size: var(--text-xl);   /* 1.25rem — section headings */
```

### Spacing

```css
gap: var(--space-xs);   /* 0.25rem — within a single control */
gap: var(--space-sm);   /* 0.5rem  — between items in a row */
gap: var(--space-md);   /* 0.5rem  — same as sm, used for groups */
gap: var(--space-lg);   /* 0.75rem — between cards */
gap: var(--space-xl);   /* 1.5rem  — major sections */
padding: var(--space-md) var(--space-lg);  /* typical card padding */
```

### Corners

```css
border-radius: var(--radius-sm);  /* 3px — buttons, tiny pills */
border-radius: var(--radius-md);  /* 4px — inputs, badges */
border-radius: var(--radius-lg);  /* 8px — cards, panels */
```

---

## Color palette

Caco computes everything from six accent hues mixed with the base. Use the semantic variables, never the raw hex.

### Backgrounds (depth ladder)

```css
background: var(--bg-base);     /* page */
background: var(--bg-surface);  /* +4% lift — panels */
background: var(--bg-raised);   /* +8% — cards on panels */
background: var(--bg-input);    /* +14% — inputs and pills */
background: var(--bg-hover);    /* +20% — hover states */
```

A surface card on the chat panel should be `--bg-raised`. Its hover state should be `--bg-hover`. Inputs inside the card should be `--bg-input` — one step *up* from the card so they read as interactive.

### Text

```css
color: var(--color-text);         /* primary body */
color: var(--color-text-bright);  /* +60% white — titles, emphasis */
color: var(--color-text-muted);   /* -45% — slugs, descriptions */
color: var(--color-text-dim);     /* -60% — captions, hints */
```

### Status colors (badges, borders, accents)

| Meaning | Background | Bright (text/border) |
| --- | --- | --- |
| Info / active | `--color-info-bg` | `--color-info` |
| Success / done | `--color-success-bg` | `--color-success-bright` |
| Warning | `--color-warn-bg` (if defined; else mix from `--orange`) | `--orange` |
| Error / blocked | `--color-error-bg` | `--color-error` |
| Accent / link | (mix with `--color-accent`) | `--color-accent` |

For status pills on items, this combination is solid:

```css
.badge {
  display: inline-block;
  padding: var(--space-xs) var(--space-sm);
  font-size: var(--text-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: var(--radius-sm);
  color: white;
}
.badge.done    { background: var(--color-success-bright); }
.badge.active  { background: var(--color-accent); }
.badge.warn    { background: var(--orange); }
.badge.error   { background: var(--color-error); }
.badge.muted   { background: var(--color-text-muted); }
```

### Source-tinted backgrounds (advanced)

Caco uses these for message bubbles. Useful when the surface needs to show "this came from X":

```css
background: var(--color-user-bg);       /* blue — user */
background: var(--color-applet-bg);     /* orange — applet-sourced */
background: var(--color-agent-bg);      /* purple — agent-to-agent */
background: var(--color-scheduler-bg);  /* cyan — scheduled */
```

---

## Card patterns

### Single-line heading (applet-browser style)

```html
<div class="card">
  <p class="card-heading">
    <span class="card-name">Refactor login route</span>
    <span class="card-slug">auth-route</span>
  </p>
  <p class="card-desc">Extract verifyToken into a helper module.</p>
</div>
```

```css
.card {
  display: block;
  background: var(--bg-raised);
  border-radius: var(--radius-lg);
  padding: var(--space-md) var(--space-lg);
  margin-bottom: var(--space-sm);
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  background: var(--bg-hover);
}
.card-heading {
  margin: 0 0 var(--space-xs) 0;
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
}
.card-name {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--color-text-bright);
}
.card-slug {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.card-desc {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: 1.35;
}
```

### List row with badge + actions

```html
<div class="row">
  <span class="badge done">done</span>
  <span class="row-label">Wire up surface tools</span>
  <button class="row-action">Edit</button>
</div>
```

```css
.row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  margin-bottom: var(--space-xs);
}
.row-label { flex: 1; }
.row-action {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  padding: var(--space-xs) var(--space-sm);
  font-size: var(--text-xs);
  cursor: pointer;
}
.row-action:hover {
  background: var(--bg-hover);
  border-color: var(--color-accent);
}
```

### Empty state

Surfaces should render *something* when items is empty — silence reads as a bug.

```css
.empty {
  text-align: center;
  padding: var(--space-xl);
  color: var(--color-text-muted);
  font-style: italic;
}
```

### Status rail (left border accent)

A colored left stripe indicating item state — used in Caco's session list for busy/unobserved indicators. Good for status-at-a-glance without badges. The transparent default keeps alignment consistent across states.

```css
.item {
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  border-left: 3px solid transparent;
  background: var(--bg-raised);
  margin: var(--space-xs) var(--space-sm);
}
.item.success { border-left-color: var(--color-success-bright); }
.item.active  { border-left-color: var(--color-accent); }
.item.warn    { border-left-color: var(--orange); background: rgba(var(--orange-rgb, 230,162,60), 0.06); }
.item.error   { border-left-color: var(--color-error); background: rgba(var(--color-error-rgb, 245,108,108), 0.06); }
.item.muted   { border-left-color: var(--color-text-dim); }
```

Pair with a tinted background on warn/error for extra emphasis. Don't tint success/active — the stripe alone is enough on dark backgrounds.

For selection (not status), use `--color-accent` as the stripe and `--bg-hover` as the background:

```css
.item.selected {
  border-left-color: var(--color-accent);
  background: var(--bg-hover);
}
```

### Shadow-safe list padding

Cards with hover lift (`translateY` + `box-shadow`) clip at the container edge. Add horizontal padding to the list container so shadows render fully — especially visible on light themes:

```css
.card-list {
  padding: 0 var(--space-sm);
}
```

---

## Layout patterns

### Scrolling container

Caco's applet panel gives you a fixed-height parent. To scroll long content **and** keep a header pinned, the inner scroll region needs `min-height: 0`:

```css
.surface-root {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.surface-header {
  flex-shrink: 0;
}
.surface-items {
  flex: 1;
  min-height: 0;       /* required — defaults to "auto" on flex children */
  overflow-y: auto;
}
```

Forgetting `min-height: 0` makes the inner container grow past the parent and clip instead of scroll — a common Caco applet bug.

### Sticky footer hint

A pinned single-line hint below the items, used by the roadmap style to say "Agent will see your changes":

```css
.surface-footer {
  flex-shrink: 0;
  padding: var(--space-xs) var(--space-sm);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.surface-footer.has-changes { color: var(--color-accent); }
```

### Toast

For transient "Item no longer exists" / "Saved" feedback:

```css
.surface-toast {
  position: absolute;
  bottom: var(--space-lg);
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-input);
  color: var(--color-text);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s;
}
.surface-toast.visible { opacity: 1; }
```

---

## Worked example: draggable priority queue

A complete surface with drag-to-reorder. Items have `priority` (int). User drags to reorder; each affected item gets a `mutateChange` call. Agent reads priority mutations via `caco_get_surface_changes`.

### Items

```json
[
  { "id": "a", "type": "task", "label": "First thing", "priority": 0 },
  { "id": "b", "type": "task", "label": "Second thing", "priority": 1 }
]
```

### customScript

```js
var dragSrc = null;

function render(s) {
  var sorted = s.items.map(function(i) { return s.changes[i.id] || i; })
    .sort(function(a, b) { return (a.priority||0) - (b.priority||0); });
  root.innerHTML = '';
  sorted.forEach(function(item, idx) {
    var el = document.createElement('div');
    el.className = 'card';
    el.draggable = true;
    el.innerHTML = '<span class="handle">☰</span><span class="name">' +
      (item.label||item.id) + '</span><span class="num">#' + idx + '</span>';
    el.addEventListener('dragstart', function(e) {
      dragSrc = item.id; el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', function() {
      el.classList.remove('dragging'); dragSrc = null;
      root.querySelectorAll('.over').forEach(function(x){x.classList.remove('over');});
    });
    el.addEventListener('dragover', function(e) { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', function() { el.classList.remove('over'); });
    el.addEventListener('drop', function(e) {
      e.preventDefault(); el.classList.remove('over');
      if (!dragSrc || dragSrc === item.id) return;
      var si = sorted.findIndex(function(x){return x.id===dragSrc;});
      var ti = sorted.findIndex(function(x){return x.id===item.id;});
      if (si<0||ti<0) return;
      sorted.splice(ti, 0, sorted.splice(si, 1)[0]);
      sorted.forEach(function(it, i) {
        if (it.priority !== i) mutateChange(it.id, Object.assign({}, it, {priority:i}));
      });
    });
    root.appendChild(el);
  });
}
```

### customStyle

```css
.card {
  display: flex; align-items: center; gap: var(--space-sm);
  background: var(--bg-raised); border-radius: var(--radius-lg);
  padding: var(--space-md) var(--space-lg); cursor: grab; user-select: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); background: var(--bg-hover); }
.card.dragging { opacity: 0.4; }
.card.over { box-shadow: 0 0 0 2px var(--color-accent); }
.handle { color: var(--color-text-dim); }
.card:hover .handle { color: var(--color-text-muted); }
.name { flex: 1; font-weight: 600; color: var(--color-text-bright); font-size: var(--text-lg); }
.num { font-size: var(--text-xs); color: var(--color-text-muted); font-weight: 700; }
```

---

## Functional patterns

### External data fetch (shell → surface)

Pattern for surfaces backed by external data (APIs, CLI tools). The agent writes the `customScript` once; the user clicks refresh to pull fresh data. No agent involvement after setup.

**Architecture:**
```
User clicks Refresh → customScript calls /api/shell → parses output → mutateChange → render
```

**Key decisions:**
- Store all external data in a **single surface item** (e.g., `id: "data"`, `type: "data-store"`). The `render()` function reads from this item and builds the UI. This keeps the surface item list clean — one data blob, not N items per external record.
- Track `_isRefreshing` and `_error` as **module-level variables**, not surface state. They're ephemeral UI state that shouldn't persist or trigger agent reads.
- `mutateChange` after the fetch triggers `render()` automatically — no manual re-render needed.
- Disable the refresh button immediately (optimistic) so the user can't double-fire.

**Skeleton:**

```js
var _refreshing = false;
var _error = null;

function render(s) {
  var di = s.items.find(function(i) { return i.id === 'data'; });
  var merged = (s.changes && s.changes['data']) || di;
  var records = merged ? (merged.records || []) : null;
  root.innerHTML = '';

  // Header with refresh button
  var hdr = document.createElement('div');
  hdr.className = 'hdr';
  var btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = _refreshing ? 'Loading…' : '↻ Refresh';
  btn.disabled = _refreshing;
  btn.onclick = doRefresh;
  hdr.appendChild(btn);
  root.appendChild(hdr);

  if (_error) {
    var err = document.createElement('div');
    err.className = 'error';
    err.textContent = _error;
    root.appendChild(err);
  }

  if (!records) { root.insertAdjacentHTML('beforeend', '<div class="empty">Click Refresh to load.</div>'); return; }
  if (records.length === 0) { root.insertAdjacentHTML('beforeend', '<div class="empty">No items.</div>'); return; }

  records.forEach(function(r) {
    // render each record
  });
}

async function doRefresh() {
  if (_refreshing) return;
  _refreshing = true; _error = null;
  // Optimistic button update
  var btn = root.querySelector('.btn');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }

  try {
    var res = await fetch('/api/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'my-cli', args: ['list', '-o', 'json'] })
    });
    var out = await res.json();
    if (out.code !== 0) throw new Error((out.stderr || '').split('\n')[0]);
    var data = JSON.parse(out.stdout);
    await mutateChange('data', {
      id: 'data', type: 'data-store',
      records: data.items || data,
      lastRefresh: new Date().toISOString()
    });
  } catch(e) {
    _error = 'Refresh failed: ' + (e.message || e);
  }
  _refreshing = false;
  // Force button reset (render may not fire on error)
  var btn2 = root.querySelector('.btn');
  if (btn2) { btn2.textContent = '↻ Refresh'; btn2.disabled = false; }
  if (_error) render(surface); // re-render to show error
}
```

**Why a single data item?** The agent reads `caco_get_surface_changes` and sees one structured blob — not N individual item mutations. The data item acts as a cache; the `render()` function owns the visual decomposition into cards/rows.

**Why module-level `_refreshing`?** It's transient UI state. If the user switches sessions and comes back, it resets (script re-evaluates). Putting it in the surface would create noise for the agent.

**Error recovery:** After a failed fetch, `_error` is shown inline. The next refresh clears it. No toast needed — the error persists until the user acts.

### Stale-token retry

When `customScript` writes to the surface via REST (not `mutateChange`), the `dataToken` may be stale if the agent wrote concurrently. Retry once with the fresh token from the error response:

```js
async function postMutate(payload) {
  var sid = appletAPI.getSessionId();
  for (var attempt = 0; attempt < 2; attempt++) {
    var res = await fetch('/api/sessions/' + sid + '/surface/mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataToken: surface.dataToken, ...payload })
    });
    var body = await res.json();
    if (body.ok) { surface.dataToken = body.dataToken; return body; }
    if (body.reason === 'stale' && body.currentDataToken) {
      surface.dataToken = body.currentDataToken;
      continue;
    }
    throw new Error('mutate failed: ' + (body.reason || 'unknown'));
  }
}
```

`mutateChange` (the binding from the shell) handles stale internally. This pattern is only needed when calling the REST API directly.

### render() contract

- Called on mount and after every state change (agent push, user PUT, `caco.surface.updated` event).
- Receives a snapshot: `{ items, changes, dataToken, style }`. The snapshot is read-only.
- Can mutate `root` directly or return an HTML string (shell catches the return value).
- Must merge `changes` over `items` for the current view: `var item = s.changes[id] || s.items.find(...)`.
- Must not call `fetch` for the surface itself — data is already in the snapshot.
- May call `fetch` for external resources (images, shell commands, etc.).

### Additional topics

---

## Anti-patterns

- **Hard-coded hex colors.** Breaks if Caco theme changes; obvious visual mismatch.
- **px font sizes.** Use the rem-based scale; respects user zoom and the chat font setting.
- **`max-width: 500px` margin-auto centering.** Caco panels are narrow; let content fill the width.
- **`overflow-y: auto` without `min-height: 0` on a flex child.** See "Scrolling container".
- **Re-fetching the surface in `render()`.** `render` is called *because* state changed; the snapshot is already current.
- **Calling `appletAPI` at top-level of the IIFE.** It may not be wired yet. Use inside callbacks.
- **Unsanitized agent HTML in `description` fields.** Always pipe through `window.DOMPurify.sanitize(html, {...})` with a tight allow-list.
- **Posting a chat message on every user click.** Cluttering. Let the agent poll at turn start; only message-on-submit for batched changes.
