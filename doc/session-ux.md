# Session UX

User experience for session management, listing, and scheduling.

## Session List

### Layout

- **Trigger**: Hamburger button (☰) in upper-left
- **Overlay**: Full-screen overlay above chat content
- **Grouping**: Sessions grouped by working directory (cwd)

### Session Item Display

| Element | Description |
|---------|-------------|
| Summary | SDK-generated or custom name (ellipsis if long) |
| Age | Time since last activity (fixed right) |
| Busy indicator | Throbber when session is streaming |
| Delete button | Available when session is not busy |

### Actions

| Action | Trigger | Behavior |
|--------|---------|----------|
| Select session | Click session item | Load history, switch to chat view |
| New chat | Click "+ New Chat" button | Show model selector |
| Delete session | Click delete, confirm | Remove session (blocked if busy) |
| Close panel | Click hamburger or outside | Return to previous view |

## Usage Display

- **Location**: Top of session panel
- **Content**: Token usage statistics from SDK
- **Source**: Cached to `~/.caco/usage.json`, updated from `assistant.usage` events

## URL State

| Parameter | Effect |
|-----------|--------|
| `?session=<id>` | Load and display session |
| (no session param) | Stay on current view, no destruction |

**Philosophy**: URL is for bookmarking. Removing `?session=` does NOT destroy loaded content.

## Custom Session Names

> Status: Planned, not implemented

- Store in `~/.caco/session-names.json` by sessionId
- Display custom name if set, fall back to SDK summary
- Inline edit UI (click to edit, enter to save)

## Scheduling

> Status: Designed, see [scheduler.md](scheduler.md)

- Scheduled sessions run automatically at specified times
- Schedule status visible in session list (badge or icon)
- Scheduled jobs appear in session panel when due

## Mobile Behavior

- Session panel is full-screen overlay
- Tap session to switch
- Back gesture returns to chat

## Toggle Button

| Property | Value |
|----------|-------|
| Position | Fixed, upper-left |
| Color | Blue theme |
| Size | 40px × 40px |
| Active state | Brighter blue when sessions visible |
