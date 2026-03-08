# plan

This document must only contain the next actions, no cut or deferred work.
The items in this plan must be actionable by another agent without guesswork.
When all items are complete, remove all items.

legend:

[ ] incomplete
[*] complete
[>] in progress

---

## Session Panel Popout (doc/specs/session-panel-popout.md)

### Step 1: HTML — move sessionView into .work-area

[ ] `public/index.html`:
  - Move `<div id="sessionView">` from before `<main>` to INSIDE `.work-area` as the FIRST child (before chatPanel)
  - Add a resizer div: `<div id="sessionResizer" class="panel-resizer"></div>` between sessionView and chatPanel
  - Change class from `session-overlay` to `session-panel hidden`

### Step 2: CSS — convert from overlay to flex panel

[ ] `public/style.css`:
  - Remove `.session-overlay` fixed positioning (position:fixed, top/left/right/bottom, z-index:100)
  - Add `.session-panel`: flex child, `width: 300px`, `min-width: 250px`, `border-right: 1px solid var(--color-border)`, `overflow-y: auto`, `background: var(--bg-surface)`
  - `.session-panel.hidden { display: none; }`
  - Desktop: show resizer when session panel visible (`.work-area:has(.session-panel:not(.hidden)) > #sessionResizer { display: block; }`)
  - Mobile: session panel stays full-screen overlay behavior (media query override)
  - Remove `.session-overlay.active { display: block; }` rule

### Step 3: View controller — decouple sessions from ViewState

[ ] `public/ts/view-controller.ts`:
  - Remove `'sessions'` from `ViewState` type → becomes `'newChat' | 'chatting'`
  - Remove `case 'sessions':` from `setViewState()`
  - Add `showSessionPanel()` / `hideSessionPanel()` / `toggleSessionPanel()` / `isSessionPanelVisible()` (mirror applet panel functions)
  - Default `currentState` to `'newChat'` instead of `'sessions'`

### Step 4: Router + session-panel — use new toggle

[ ] `public/ts/router.ts`:
  - Rewrite `toggleSessions()` to call `toggleSessionPanel()` instead of `setViewState`
  - Remove `previousMainPanel` tracking (no longer needed — session panel is orthogonal)

[ ] `public/ts/session-panel.ts`:
  - `showSessionManager()` → call `showSessionPanel()` + `loadSessions()` (no `setViewState`)
  - Session click → close panel via `hideSessionPanel()` then activate session

### Step 5: Resizer — reuse panel-resizer pattern

[ ] `public/ts/panel-resizer.ts`:
  - Add a second resizer for the session panel (LEFT side, drag right to widen)
  - Separate localStorage key: `caco:sessionPanelWidth`

### Step 6: Build and test

[ ] All tests pass
[ ] Typecheck clean
[ ] Build client
[ ] Verify: Escape+L toggles side panel, session click switches and closes panel
[ ] Verify: applet panel and session panel can both be open simultaneously
[ ] Verify: resizer works for both panels independently
