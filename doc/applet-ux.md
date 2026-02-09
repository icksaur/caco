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

### Button Clearance

Fixed navigation buttons (menu top-left, applet top-right) float at z-index 200 over the applet panel. The `.applet-instance` container has `padding-top: 48px` to prevent content from being obscured.

The clearance zone displays the applet's **friendly name** (label, not slug) centered in muted text. This is injected automatically by `pushApplet()` as a `.applet-label` element — applets don't need to account for it.

| Layer | Element | Z-Index |
|-------|---------|---------|
| Applet content | `.applet-instance` | 0 (scrollable) |
| Applet label | `.applet-label` | auto (absolute, pointer-events: none) |
| Nav buttons | `.menu-btn`, `.applet-btn` | 200 (fixed) |

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

## Expand Button

### Behavior

| State | Applet Panel | Chat Panel |
|-------|--------------|------------|
| Collapsed (default) | 40% width | 60% width |
| Expanded | 100% width, z-index above chat | Hidden |

### State Management

| Requirement | Implementation |
|-------------|----------------|
| Expanded state persists when hiding/showing panel | Store in `view-controller.ts` separate from panel visibility |
| Query param `?applet=slug` does NOT assume expanded | Default to collapsed |
| Page reload resets expanded state | No localStorage persistence (session-only) |
| Mobile: expanded is irrelevant | Already full-screen, hide expand button |

### Z-Index Stack

| Layer | Z-Index | Element |
|-------|---------|---------|
| Base | 0 | Chat panel, applet panel |
| Expanded applet | 51 | `.applet-panel.expanded` |
| Expand button | 52 | `.expand-btn` |
| Applet button | 200 | `#appletBtn` (always on top) |
| Sessions overlay | 200 | `#sessionView` |

## Keyboard Input Routing

Keyboard events are routed to the active applet only when the applet view has focus.

1. `view-controller.ts` tracks active view state and applet slug
2. `input-router.ts` has one global `document.keydown` listener
3. Router checks active view/applet and routes to registered handler
4. Applets never receive keyboard events when hidden or when chat is focused
5. Events targeting `<input>` or `<textarea>` are not routed (handled normally)

## Applet Toggle Button

| Property | Value |
|----------|-------|
| Position | Fixed, upper-right |
| Color | Orange theme |
| Size | 40px × 40px |
| Active state | Brighter orange when applet visible |
| Click | Toggle applet panel visibility |
| Long-press (1s) | Open applet browser |
