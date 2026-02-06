# Applet UI/UX Specification

The applet view is a panel for custom DOM interfaces created by agents or loaded from saved applets.

## Layout Behavior

### Desktop (≥768px)

- **Minimum width**: 320px
- **Default**: 50% of viewport when visible
- **Position**: Right side of screen, shares space with chat panel
- **Visibility**: Toggle via applet button in header

### Mobile (<768px)

- **Width**: 100% of viewport
- **Behavior**: Applet replaces chat view when open
- **Navigation**: Back gesture or button returns to chat

## Visibility Control

### UI Controls

| Control | Location | Action |
|---------|----------|--------|
| Applet button | Header | Toggle applet panel visibility |
| Close button | Applet header | Hide applet panel |

### URL Query Parameters

| Parameter | Example | Effect |
|-----------|---------|--------|
| `?applet=calculator` | Load and show saved applet by slug |
| `?view=applet` | Open applet panel (with current/last content) |

### Programmatic

- `setViewState('applet', true)` - Show applet panel
- `setViewState('applet', false)` - Hide applet panel
- Agent calling `load_applet` or `set_applet_content` auto-shows panel

## Content Sources

| Source | Trigger |
|--------|---------|
| Agent-generated | `set_applet_content` tool |
| Saved applet | `load_applet` tool or URL param |
| Applet browser | User selection from saved applets |

## Future Considerations

### Panel Resizing

Options under consideration:
1. **Draggable separator** - User drags to resize chat/applet split
2. **Expand button** - Full-window mode for applet ← **Selected approach**
3. **Preset widths** - Toggle between 33%/50%/67%

---

## Expand Button Specification

### Behavior

| State | Applet Panel | Chat Panel |
|-------|--------------|------------|
| Collapsed (default) | 40% width | 60% width |
| Expanded | 100% width, z-index above chat | Hidden |

### Icon Design

- **Style**: Match applet button (floating, same size, same border-radius)
- **Position**: Inside applet panel, top-right corner[^1]
- **Glyph options**:
  - `⤢` (U+2922) expand / `⤡` (U+2921) collapse
  - `◀▶` chevrons
  - SVG arrows (more control over sizing)
- **Color**: Same orange theme as applet button (`--color-applet`)

### State Management

| Requirement | Implementation |
|-------------|----------------|
| Expanded state persists when hiding/showing panel | Store in `view-controller.ts` separate from panel visibility |
| Query param `?applet=slug` does NOT assume expanded | Default to collapsed, respect user's in-session choice |
| Page reload resets expanded state | No localStorage persistence (session-only) |
| Mobile: expanded is irrelevant | Already full-screen, hide expand button |

### Button Visibility

| Condition | Expand Button |
|-----------|---------------|
| Applet panel hidden | Hidden |
| Applet panel visible (desktop) | Visible |
| Applet panel visible (mobile) | Hidden (already full-screen) |
| Sessions overlay active | Hidden |

### View Controller Changes

```typescript
// New state (session-only, not persisted)
let appletExpanded = false;

export function toggleAppletExpanded(): void { ... }
export function isAppletExpanded(): boolean { ... }

// showAppletPanel() respects existing expanded state
// hideAppletPanel() does NOT reset expanded state
```

### CSS Classes

```css
.applet-panel.expanded {
  width: 100%;
  max-width: none;
  z-index: 51;  /* Above chat panel */
}

.expand-btn {
  /* Same style as applet button */
  position: absolute;
  top: var(--space-sm);
  right: var(--space-sm);
  z-index: 52;  /* Above applet content */
}

/* Hide on mobile */
@media (max-width: 768px) {
  .expand-btn { display: none; }
}
```

### Z-Index Stack

| Layer | Z-Index | Element |
|-------|---------|---------|
| Base | 0 | Chat panel, applet panel |
| Expanded applet | 51 | `.applet-panel.expanded` |
| Expand button | 52 | `.expand-btn` |
| Applet button | 200 | `#appletBtn` (always on top) |
| Sessions overlay | 200 | `#sessionView` |

---

## Implementation Plan

### Pre-Implementation Quality Review

Per code-quality.md, before adding this feature:

**Q: Can we get 90% of the requirement with 10% of the code?**
A: Yes. Minimal approach: CSS class toggle + one state variable + button in HTML.
No new modules needed. Extend existing view-controller.ts (~15 lines).

**Q: Should we refactor before adding behavior?**
A: No major refactoring needed. Current view-controller separation is clean.
One consideration: button visibility logic could become complex - keep it in CSS via `:has()` selector.

### Phase 1: CSS + State (~20 lines)

**Files:** `style.css`, `view-controller.ts`

1. Add `.expand-btn` styles (0.7x size of applet button = 28px)
2. Add `.applet-panel.expanded` styles
3. Add `appletExpanded` state variable
4. Export `toggleAppletExpanded()`, `isAppletExpanded()`
5. Update `showAppletPanel()` to apply expanded class if state is true

### Phase 2: HTML + Wiring (~10 lines)

**Files:** `index.html`, `main.ts`

1. Add expand button element inside `#appletPanel`
2. Wire click handler to `toggleAppletExpanded()`
3. Use CSS `:has()` or class to show/hide button based on panel visibility

### Phase 3: Polish (optional, deferred)

- Animation transition
- Keyboard shortcut
- Resize event for applet content

---

## Keyboard Input Routing

Keyboard events are routed to the active applet only when the applet view has focus.

### How It Works

1. `view-controller.ts` tracks active view state and applet slug
2. `input-router.ts` has one global `document.keydown` listener
3. Router checks active view/applet and routes to registered handler
4. Applets never receive keyboard events when hidden or when chat is focused

### Applet API

```javascript
// Applet registers a key handler (no visibility checks needed)
registerKeyHandler('calculator', function(e) {
  // Only called when calculator is the active applet
  if (e.key >= '0' && e.key <= '9') appendNum(e.key);
});
```

### Input Element Handling

- Events targeting `<input>` or `<textarea>` are not routed (handled normally)
- Applets can focus their own inputs without interference

---

## Applet Toggle Button

| Property | Value |
|----------|-------|
| Position | Fixed, upper-right |
| Color | Orange theme |
| Size | 40px × 40px |
| Active state | Brighter orange when applet visible |
| Click | Toggle applet panel visibility |
| Long-press (1s) | Open applet browser |

---

## Footnotes

[^1]: **Button position within applet panel**: The expand button must have higher z-index than applet content to prevent applets from obscuring it. Consider `pointer-events: none` on applet during button hover to prevent interference.

[^2]: **Keyboard shortcut**: Consider `Cmd/Ctrl+Shift+E` to toggle expanded state when applet is focused.

[^3]: **Animation**: Transition width smoothly (`transition: width 0.2s ease`) to avoid jarring state changes.

[^4]: **Applet content reflow**: Some applets may need to respond to resize. Consider dispatching a `resize` event or providing `window.onAppletResize` callback.

[^5]: **Chat scroll position**: When collapsing from expanded, chat panel reappears. Should preserve scroll position (already in `view-controller.ts` scroll handling).

[^6]: **Double-click to expand**: Alternative/additional trigger - double-click applet header to toggle expanded.
