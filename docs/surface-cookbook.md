# Session-surface cookbook

Patterns and reference for writing `customScript` / `customStyle` payloads for the session-surface applet. Companion to [`session-surface-applet.md`](./session-surface-applet.md) (the protocol) and [`collab-state-spec.md`](./collab-state-spec.md) (the data model).

Audience: an agent (or human) writing a surface that should feel like a native Caco panel.

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

## Functional patterns

> *Placeholder.* This section will document the JavaScript half of session-surface definitions: render entry points, mutation helpers, retry/stale recovery, polling external sources, optimistic UI, and accessibility hooks. See `session-surface-applet.md` for the protocol primitives.

Topics to cover:

- The `render(surface)` entry point — when it fires, what `surface` contains.
- `mutateChange(itemId, fullItem)` — local PUT helper, optimistic update.
- Stale-token retry loop for direct `fetch` to `/api/sessions/<id>/surface/mutate`.
- `appletAPI.fetchWithRetry` for flaky external sources (Azure DevOps, internal APIs).
- Pulling external data: `fetch('/api/shell', ...)` + parse + mutate.
- Listening to `caco.surface.updated` events vs full re-render.
- Keyboard nav (Alt+↑/↓ for reorder) and ARIA hints.
- DOMPurify for any HTML the agent passes through items (descriptions, tooltips).
- The agent's reading discipline: call `caco_get_surface_changes` at turn start, integrate edits, then mutate.

Add a worked example per topic. Keep snippets short and runnable.

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
