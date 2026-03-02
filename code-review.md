# Code Review — Frontend Architecture — 2026-03-02

Reviewed against `doc/code-quality.md`. 6,587 lines across 31 frontend TypeScript files.

---

## Code Quality Violations Summary

The `doc/code-quality.md` principles most violated in the frontend:

| Principle | Violation | Impact |
|-----------|-----------|--------|
| **"only one way to do one thing"** | Busy state set in 3 places during message send; form state set both directly and via tracker | Session state bugs, form stuck disabled |
| **"global state"** | 40+ module-level mutable variables across 31 files | Hard to reason about state transitions |
| **"relying on side effects"** | Tracker change detection skip means subscribers don't fire when setting same value | Form not re-enabled after session switch |
| **"code must be kept in sync"** | DOM classes (`.busy`, `.streaming`) and JS state (tracker, app-state) managed independently | UI diverges from actual state |
| **"classes have one purpose (SRP)"** | `websocket.ts` (528 lines) manages connection, reconnect, heartbeat, subscriptions, request/response, 6 callback sets | Untestable; state scattered |
| **"correct by design"** | Missing timeouts on POST resume, no cancellation of stale history requests | Spinner stuck forever, stale content |

---

## Critical — Must Fix

### C1. No timeout on session resume POST

**File:** `router.ts:279`

`activateSession()` calls `fetch('/api/sessions/:id/resume')` with no timeout. If the server hangs during SDK resume, the loading spinner stays forever. The message POST has a 30s timeout — resume should too.

### C2. Redundant busy state paths create inconsistency

**File:** `message-streaming.ts:220-226`

When sending a message, busy state is set THREE times:
1. Line 223: `sessionTracker.setBusy(currentId, true)` (optimistic)
2. Line 226: `setFormEnabled(false)` (direct DOM)
3. Line 148-151: tracker `onChange` fires → `setFormEnabled(false)` again

If the onChange fires BEFORE the direct call, or if the tracker already has the same value (no-op), the paths diverge. The `code-quality.md` principle "only one way to do one thing" directly addresses this.

**Fix:** Remove the direct `setFormEnabled(false)` call. Let tracker → onChange be the sole path. The optimistic `setBusy(true)` at the top handles it.

### C3. Concurrent history requests not cancelled

**Files:** `websocket.ts:88-91`, `history.ts:46-85`

If the user clicks session A, then quickly clicks session B before A's history loads, two `requestHistory` calls are in-flight. Both `historyComplete` events arrive — the first resolves via the `settled` guard, but the second may be lost or may fire the wrong listener.

**Fix:** Add a history request generation counter. Ignore `historyComplete` events that don't match the latest request.

---

## Significant — Should Fix

### S1. `websocket.ts` is a 528-line god module

14 mutable variables, 6 callback sets, heartbeat timers, reconnect logic, request/response correlation.

**Suggested class:** `WebSocketClient` encapsulating connection, reconnect, heartbeat. Most testability gain.

### S2. `applet-runtime.ts` (595 lines) is a state soup

Module-level variables: `currentApplet`, `_currentStyleElement`, `pendingAppletState`. Manages lifecycle, URL params, popstate, IIFE scripts, window.appletAPI.

**Suggested class:** `AppletManager` owning current instance and lifecycle methods.

### S3. DOM ownership violations on `#chatForm`

Three modules mutate `#chatForm`: `view-controller.ts` (classList), `message-streaming.ts` (querySelector), `multiline-input.ts` (input/button). Per `code-quality.md` encapsulation principle, `view-controller.ts` should own all form mutations, exposing `setFormEnabled()`. Others call through that API.

### S4. `session-panel.ts` (621 lines) mixes data, rendering, and input

Session list fetching, fuzzy search, DOM rendering, schedule/usage display, rename/delete workflows, search input, tracker subscription — all in one file.

**Suggested split:** `session-list-renderer.ts` (DOM creation) + `session-panel.ts` (orchestration).

### S5. Event listeners never removed

`initInputRouter()`, `setupImagePaste()`, `initSessionPanel()` add listeners that are never removed. Tests can't clean up, hot reload accumulates.

**Fix:** Return unsubscribe functions from init, store them.

---

## Moderate — Improvement Opportunities

### M1. `streaming-markdown.ts` module-level Map — should be class owned by ChatRegion
### M2. `multiline-input.ts` 7 module-level popup variables — should be InputPopupManager class
### M3. `view-controller.ts` cached DOM elements in module scope — should be class property
### M4. `history.ts` `historyPending`/`lastHistoryConnectionId` — should be HistoryLoader class properties

---

## Architectural Recommendations

Classes that would most improve correctness, in priority order:

### 1. `WebSocketClient` (from `websocket.ts`)
**Why:** 14 mutable variables, most bugs trace to WS state. Connection lifecycle, reconnect, heartbeat all interleaved.
**Benefit:** Testable reconnect. Clear state reset on disconnect.

### 2. `HistoryLoader` (from `history.ts` + parts of `message-streaming.ts`)
**Why:** History loading is the #1 UI bug source. Currently split between two files. No cancellation of concurrent requests.
**Benefit:** Single place for request cancellation, timeout, and guard logic.

### 3. `AppletManager` (from `applet-runtime.ts`)
**Why:** 595 lines, 3 module-level state variables, complex lifecycle.
**Benefit:** Testable lifecycle. Clear DOM ownership.

### 4. `InputManager` (from `multiline-input.ts` + `input-router.ts`)
**Why:** Two files manage keyboard state with module-level variables. Escape leader key, slash commands, pound providers are all input concerns.
**Benefit:** Single owner of input state.

---

## What's Done Well

- **`SessionStateTracker`** — Clean class, change detection, subscriber pattern, bulk sync. Right design.
- **`dom-regions.ts`** — Scoped DOM access, proxy-based fail-fast. Prevents cross-region corruption.
- **Pure modules** — `terminal-events.ts`, `markdown-builders.ts`, `session-observed.ts`, `hostname-hash.ts`, `ui-utils.ts`. Zero mutable state.
- **Server-side architecture** — Tool factory pattern, SDK normalizer chain, runaway guard, dispatch state. Well-tested pure modules.

---

## Quick Wins (< 30 min each)

1. **C1** — Add timeout to resume POST in `router.ts` (use existing `fetchWithTimeout`)
2. **C2** — Remove redundant `setFormEnabled(false)` in `message-streaming.ts` (let tracker drive)
3. **C3** — Add history request generation counter in `history.ts`
4. **Dead code** — `_currentStyleElement` in `applet-runtime.ts` is unused
