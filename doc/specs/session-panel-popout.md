# Session Panel Popout

## Problem

The session panel is a full-screen overlay. Opening it hides the chat and applet entirely. This makes session management a context switch — you can't glance at sessions while working, and switching back requires restoring the previous view state. The `/sessions` slash command popup partially solved this for quick switching, but the full session panel (with search, rename, delete, schedules) still takes over the screen.

## Design

Convert the session panel from a fixed overlay to a left-side flex panel inside `.work-area`, mirroring the applet panel's architecture on the right side.

### Layout

```
┌─────────────────────────────────────────────────────┐
│ header (menu btn, applet btn, expand btn)            │
├───────────┬─┬───────────────────┬─┬─────────────────┤
│ sessions  │R│     chat          │R│    applet        │
│ panel     │ │                   │ │    panel         │
│ (left)    │ │                   │ │    (right)       │
│           │ │                   │ │                  │
├───────────┴─┴───────────────────┴─┴─────────────────┤
│ footer                                               │
└─────────────────────────────────────────────────────┘
R = resizer handle
```

- Session panel on the LEFT of chat, applet panel on the RIGHT
- Both panels are independently togglable
- Chat takes remaining flex space in the middle
- Each panel has its own resizer handle
- All three can be visible simultaneously on desktop

### Behavior

- **Toggle:** Escape+L or menu button click toggles the session panel
- **Session click:** Activates session AND closes the panel (quick switch)
- **Search/rename/delete:** Same functionality, just in a side panel
- **Mobile:** Full-screen toggle (same as applet panel on mobile)
- **Default hidden:** Panel starts hidden, toggled on demand
- **Width:** Default 300px, resizable via drag handle, persisted in localStorage
- **No view state change:** Opening/closing the session panel does NOT change the main view state (chatting/newChat). It's orthogonal, like the applet panel.

### Architecture Changes

**Current:** `setViewState('sessions')` is a modal state that hides everything else.

**New:** Session panel visibility is managed via a CSS class (`.hidden`), independent of view state. `setViewState` no longer has a `'sessions'` value — it only manages `'chatting'` | `'newChat'`.

The session panel's content (search, list, schedules) stays the same. Only the container changes from overlay to flex panel.

### Toggle Behavior

The menu button currently:
- Shows session panel (full-screen) when not in sessions view
- Hides session panel when in sessions view

New behavior:
- Toggles the `.hidden` class on the session panel
- Does NOT change view state
- If both session and applet panels are visible, that's fine (three-column layout)
- The Escape+L shortcut does the same

## Considerations

- **Three-column on narrow screens:** If both panels are open on a small desktop, the chat column gets squeezed. The min-width constraints on each panel prevent it from getting too small, but we should hide the session panel below a breakpoint (e.g., 1200px).
- **Session panel width:** 300px default is narrower than the applet panel (40%). Session items are compact enough.
- **Mobile:** Session panel becomes full-screen toggle, same as today. The fixed overlay approach works well on mobile.
- **Keyboard shortcuts:** Escape+L toggles session panel, Escape+. toggles applet panel. Both independent.
- **Initial load with ?session= param:** Activating a session from URL no longer opens the session panel. It just loads the session into the chat view.
