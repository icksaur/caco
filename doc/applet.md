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
2. **Expand button** - Full-window mode for applet
3. **Preset widths** - Toggle between 33%/50%/67%

### Multiple Applets

Not currently supported. Options:
- Tabs within applet panel
- Applet browser for switching
