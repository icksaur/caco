# Keyboard Shortcuts

Global keyboard shortcuts for navigation.

## Current Input Handling

Two scoped inputs (each handles Enter/Escape locally):
- **Chat input** - `Shift+Enter` newline, `Enter` send
- **Session search** - `Enter` action, `Escape` clear/close

One global router:
- `input-router.ts` - Routes events to active view/applet, skips native inputs

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Escape` | start leader timer |
| `Escape` `l` | Toggle session panel |
| `Escape` `.` | Toggle applet panel |
| `Escape` `,` | Expand applet panel |

### Leader Key Pattern

Escape acts as a **leader key** - press Escape, then a follow-up key within 500ms.

**Behavior:**
1. Press `Escape` → blur any focused input, start 500ms timer
2. Press `s`, `.`, or `,` within timer → execute action
3. Timer expires or invalid key → nothing

**ESC does one thing:** blur + start leader. No special cases for different inputs.

**Why this works:**
- Escape is not printable → works even in text inputs
- All inputs in same document (applets are injected HTML, not iframes)
- Uniform behavior everywhere: session search, chat, applets

## Implementation

### State: Leader Key Timer

```typescript
let escapeTime: number | null = null;
const LEADER_TIMEOUT = 500;
```

### Where: Extend `input-router.ts`

```typescript
document.addEventListener('keydown', (e: KeyboardEvent) => {
  // Leader key follow-ups (checked first, works from anywhere)
  if (escapeTime && Date.now() - escapeTime < LEADER_TIMEOUT) {
    escapeTime = null;
    if (e.key === 's') { toggleSessions(); e.preventDefault(); return; }
    if (e.key === '.') { toggleApplet(); e.preventDefault(); return; }
    if (e.key === ',') { 
      if (isAppletPanelVisible()) toggleAppletExpanded(); 
      e.preventDefault(); 
      return; 
    }
    // Invalid follow-up key - fall through to normal handling
  }
  
  // Escape - blur any input, start leader
  if (e.key === 'Escape') {
    const active = document.activeElement as HTMLElement;
    if (active && active !== document.body) {
      active.blur();
    }
    escapeTime = Date.now();
    e.preventDefault();
    return;
  }
  
  // ... existing view-specific routing
});
```

### Remove Local ESC Handler

In `session-panel.ts`, remove the Escape handling from the keydown listener:

```typescript
// Before
if (e.key === 'Escape') {
  if (searchQuery) {
    searchInput.value = '';
    searchQuery = '';
    renderFilteredSessions();
    e.stopPropagation();
  }
}

// After: Remove entire Escape block
```

### Escape Key Behavior

ESC does exactly one thing: **blur + start leader**.

| Press | Result |
|-------|--------|
| `ESC` | Blur input, start 500ms leader timer |
| `ESC l` | Toggle session panel |
| `ESC .` | Toggle applet panel |
| `ESC ,` | Expand applet (if visible) |
| `ESC` (timeout) | Nothing else happens |

No special cases. Query in session search is preserved on blur.

### Browser Reservations

These shortcuts are safe - browsers don't intercept:
- `Escape` - May close dialogs, but web can preventDefault
- `.` - No browser binding
- `,` - No browser binding

**Avoided shortcuts:**
- `Ctrl+*` - Browser shortcuts (Ctrl+T, Ctrl+W, etc.)
- `Alt+*` - Menu bar access (Windows/Linux)
- `F*` keys - Refresh, dev tools, etc.
- `/` - Already used as command prefix in chat

### Browser Compatibility

| Feature | Chrome/Edge | Firefox | Safari |
|---------|-------------|---------|--------|
| `KeyboardEvent.key` | ✓ | ✓ | ✓ |
| `preventDefault()` on Escape | ✓ | ✓ | ✓ |
| Single-char keys | ✓ | ✓ | ✓ |

No compatibility concerns. All use standard DOM Level 3 KeyboardEvent.

## Complexity Assessment

| Aspect | Notes |
|--------|-------|
| New state | 2 lines: `escapeTime` + timeout const |
| New imports | `toggleSessions`, `toggleApplet`, `isAppletPanelVisible`, `toggleAppletExpanded` |
| Add to input-router.ts | ~20 lines |
| Remove from session-panel.ts | ~8 lines (ESC handler) |
| **Net change** | ~12 lines |
| Unknowns | None |

## Future Considerations

### Arrow Key Navigation (Not Yet)

Session list could support:
- `↑`/`↓` - Navigate sessions
- `Enter` - Select highlighted

Requires adding selection state to session list. Defer until needed.

### Applet-Specific Shortcuts

Applets already register handlers via `registerKeyHandler()`. Global shortcuts should not conflict with:
- Arrow keys (game controls, navigation)
- Space (play/pause, selection)
- Letters (typing in applet inputs)

The chosen shortcuts (`.`, `,`) are unlikely to conflict.
