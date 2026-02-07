# Session UX

User experience for session management, listing, and scheduling.

## Session Panel

### Layout

- **Trigger**: Hamburger button (☰) in upper-left
- **Overlay**: Full-screen overlay above chat content
- **Structure**: New Chat button → Schedules section → Session list

### Session List

**No CWD grouping** - sessions displayed as flat MRU list.

**Sessions without CWD are omitted** - these are likely incomplete or corrupted sessions.

**Sort order**: `updatedAt` descending (most recently updated first).

**Each session item** shows:
- State indicator (busy cursor, unobserved dot, or none)
- Session summary/name
- Age (e.g., "2m ago")
- CWD path below (small text)

```
┌────────────────────────────────────────────────────┐
│ ▌ Analyzing code...                    2m ago     │
│   /home/carl/project-a                            │
├────────────────────────────────────────────────────┤
│ ● Refactored auth module               5m ago     │
│   /home/carl/project-b                            │
├────────────────────────────────────────────────────┤
│   Fixed login bug                      1h ago     │
│   /home/carl/project-a                            │
└────────────────────────────────────────────────────┘
```

### Visual Indicators

#### Menu Button Badge (Priority Order)

1. **Unobserved sessions exist**: Solid red circle with count (e.g., "3")
2. **ELSE IF other busy sessions exist**: Blinking colorful cursor (matching chat streaming cursor)
3. **Otherwise**: No badge

**Important**: The busy indicator only shows for sessions OTHER than the one currently being viewed.

```
┌──────┐      ┌──────┐      ┌──────┐
│ ☰  3 │  OR  │ ☰  ▌│  OR  │ ☰    │
└──────┘      └──────┘      └──────┘
 unobserved    busy (other)  all idle
```

#### Session List Items

| State | Indicator |
|-------|-----------|
| Busy | Blinking colorful cursor (4-corner gradient) + accent left border |
| Unobserved | Red dot + red left border |
| Active (current) | Blue border |

### Actions

| Action | Trigger | Behavior |
|--------|---------|----------|
| Select session | Click session item | Load history, switch to chat view |
| New chat | Click "+ New Chat" button | Show model selector |
| Edit name | Click edit button (✎) | Inline edit, enter to save |
| Delete session | Click delete (×), confirm | Remove session (blocked if busy) |
| Close panel | Click hamburger or outside | Return to previous view |

## Unobserved State

### Definition

Session is **unobserved** when:
1. Session completed work (`session.idle` received) AND
2. User has not viewed that session since idle

### State Transitions

```
busy → idle: session becomes "unobserved" 
             (unless currently viewing it)
user views session: session becomes "observed"
user is viewing when idle: stays observed
```

### Observation Triggers

Session is marked observed when:
- **Live streaming ends**: User is viewing session AND `session.idle` event arrives
- **History loaded**: User switches to session AND `historyComplete` event arrives

## Schedule Section

### Layout

Schedules appear below New Chat, above session list. Both sections have headings:

```
┌─────────────────────────────────────────────────┐
│ + New Chat                                      │
├─────────────────────────────────────────────────┤
│ schedules                                       │
│  ▶ daily-standup    next: 9:00 AM   ✓ enabled  │
│  ▶ nightly-backup   next: 2:00 AM   ○ disabled │
├─────────────────────────────────────────────────┤
│ sessions                                        │
│  ● Refactored auth module              5m ago  │
│    /home/carl/project-b                        │
│    Fixed login bug                     1h ago  │
│    /home/carl/project-a                        │
└─────────────────────────────────────────────────┘
```

### Section Headings

| Heading | Style | Content |
|---------|-------|---------|
| `schedules` | Lowercase, muted text | Scheduled sessions (cron-triggered) |
| `sessions` | Lowercase, muted text | Manual/interactive sessions |

### Schedule Item Display

| Element | Description |
|---------|-------------|
| Run button (▶) | Green play icon, triggers immediate execution |
| Slug | Schedule name/identifier |
| Next run | Relative time ("5m", "2h") or date if > 24h |
| Toggle | ✓ enabled / ○ disabled |

### Actions

| Action | Trigger | Behavior |
|--------|---------|----------|
| Run now | Click ▶ button | POST /api/schedule/:slug/run |
| Toggle | Click toggle button | PATCH /api/schedule/:slug { enabled } |

### Empty State

If no schedules: "no scheduled sessions" (muted text)

### Design Philosophy

Schedules are **created/edited by the agent**, not manually by users. Users interact through:
1. Natural language requests to the agent ("schedule daily at 9am")
2. Simple enable/disable toggle in UI
3. View-only display of next run time

## Custom Session Names

- Store in `~/.caco/sessions/<id>/meta.json` as `name` field
- Display custom name if set, fall back to SDK summary
- Edit via inline edit button (✎) in session list
- Also settable on session creation via `description` parameter

## Usage Display

- **Location**: Top of session panel
- **Content**: Token usage statistics from SDK
- **Source**: Cached to `~/.caco/usage.json`

## URL State

| Parameter | Effect |
|-----------|--------|
| `?session=<id>` | Load and display session |
| (no session param) | Stay on current view |

**Philosophy**: URL is for bookmarking. Removing `?session=` does NOT destroy loaded content.

## Mobile Behavior

- Session panel is full-screen overlay
- Tap session to switch
- Back gesture returns to chat

## Menu Button

| Property | Value |
|----------|-------|
| Position | Fixed, upper-left |
| Color | Blue theme |
| Size | 40px × 40px |
| Active state | Brighter blue when sessions visible |
| Badge | Red circle with unobserved count, or colorful cursor if busy |

## Intent Display (Planned)

When session is busy, show what it's doing:

```
┌────────────────────────────────────────────────────┐
│ ▌ Analyzing git commits for standup    5m ago    │
│    /home/carl/project                             │
└────────────────────────────────────────────────────┘
```

Capture from `report_intent` tool result, display in session list.
