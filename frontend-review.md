# Front-End Code Review

*Review Date: 2026-02-01*
*Scope: `/public/ts/` (23 files, 4,266 lines)*
*Reference: [code-quality.md](code-quality.md)*

---

## Executive Summary

The front-end has good bones—clear module naming, TypeScript, CSS design tokens—but suffers from accumulated technical debt. **~500 lines are dead code or duplication**. The primary issues are:

1. Dead code files that should be deleted
2. Triple source of truth for session state
3. Duplicated functions and interfaces
4. God modules that violate separation of concerns

---

## Priority 1: Delete Dead Code

### 1.1 Delete `applet-ws.ts` (433 lines)

**File:** `public/ts/applet-ws.ts`

**Problem:** This is a near-duplicate of `websocket.ts`. It is **not imported anywhere** in the codebase.

**Evidence:**
```bash
grep -r "applet-ws" public/ts/
# Returns nothing
```

**Action:** Delete the entire file.

```bash
rm public/ts/applet-ws.ts
```

---

### 1.2 Delete `send-message.ts` (36 lines)

**File:** `public/ts/send-message.ts`

**Problem:** Exports `sendMessage()` function but it is **never imported**. The actual message sending is done inline in `message-streaming.ts`.

**Evidence:**
```bash
grep -r "send-message" public/ts/
# Returns nothing
grep -r "sendMessage" public/ts/
# Only finds the definition, no imports
```

**Action:** Delete the entire file.

```bash
rm public/ts/send-message.ts
```

---

## Priority 2: Fix Duplicate Functions

### 2.1 Remove duplicate `removeImage()` in `message-streaming.ts`

**Files:**
- `public/ts/image-paste.ts` (lines 47-56) — correct version
- `public/ts/message-streaming.ts` (lines 391-397) — buggy duplicate

**Problem:** The duplicate in `message-streaming.ts` does NOT call `setHasImage(false)`, causing state desync.

**Duplicate code to remove (message-streaming.ts lines 391-397):**
```typescript
function removeImage(): void {
  const imageData = document.getElementById('imageData') as HTMLInputElement;
  const imagePreview = document.getElementById('imagePreview');
  if (imageData) imageData.value = '';
  if (imagePreview) imagePreview.classList.add('hidden');
}
```

**Action:**
1. Add import at top of `message-streaming.ts`:
   ```typescript
   import { removeImage } from './image-paste.js';
   ```
2. Delete the local `removeImage()` function definition (lines 391-397).

---

### 2.2 Consolidate time formatting functions

**Files:**
- `public/ts/ui-utils.ts` (lines 32-48) — `formatAge()`
- `public/ts/session-panel.ts` (lines 203-217) — `formatCacheDate()`

**Problem:** Both functions do relative time formatting with slightly different outputs.

**Action:**
1. Extend `formatAge()` in `ui-utils.ts` to handle both use cases, or rename to `formatRelativeTime()`.
2. Export and use in `session-panel.ts` instead of the local `formatCacheDate()`.
3. Delete `formatCacheDate()` from `session-panel.ts`.

---

## Priority 3: Single Source of Truth for Session State

### 3.1 Eliminate duplicate `activeSessionId` tracking

**Problem:** Three different places track `activeSessionId`:

| Location | File | Line |
|----------|------|------|
| `state.activeSessionId` | `public/ts/app-state.ts` | 34 |
| `let activeSessionId` | `public/ts/websocket.ts` | 32 |
| `let activeSessionId` | `public/ts/applet-ws.ts` | 33 (dead file) |

**Additionally, three `getActiveSessionId()` functions exist:**
- `public/ts/app-state.ts` line 51
- `public/ts/websocket.ts` line 86
- `public/ts/applet-ws.ts` line 90 (dead file)

**Evidence of confusion in `applet-runtime.ts` lines 11-12:**
```typescript
import { getActiveSessionId as getWsActiveSession } from './websocket.js';
import { getActiveSessionId } from './app-state.js';
```

**Action:**
1. `app-state.ts` should be the ONLY authority for `activeSessionId`.
2. Remove `activeSessionId` variable from `websocket.ts`.
3. Change `websocket.ts` to import and use `getActiveSessionId()` from `app-state.ts`.
4. Update `setActiveSession()` in `websocket.ts` to only handle WebSocket subscription, not state storage.
5. Update all callers to use `app-state.ts` version consistently.

**Files to modify:**
- `public/ts/websocket.ts` — remove local state, import from app-state
- `public/ts/applet-runtime.ts` — remove the aliased import, use only app-state
- `public/ts/app-state.ts` — ensure it doesn't import from websocket.ts (currently does at line 13, creating circular risk)

---

### 3.2 Break circular dependency: app-state.ts → websocket.ts

**File:** `public/ts/app-state.ts` line 13

**Problem:**
```typescript
import { setActiveSession as setWsActiveSession } from './websocket.js';
```

State module should NOT depend on transport module. This creates:
- Circular dependency risk
- Inverted responsibility

**Action:**
1. Remove the import from `app-state.ts`.
2. Have `setActiveSession()` in `app-state.ts` be pure state mutation only.
3. Move the WebSocket subscription call to the caller (likely `router.ts` or `main.ts`).

---

## Priority 4: Extract Classes to Own Files

### 4.1 Extract `ElementInserter` class from `message-streaming.ts`

**File:** `public/ts/message-streaming.ts` (lines 136-221)

**Problem:** This file is 460 lines and contains a reusable class. The class even has a JSDoc reference to unit tests:
```typescript
 * @remarks Unit test all changes - see tests/unit/element-inserter.test.ts
```

**Action:**
1. Create new file `public/ts/element-inserter.ts`.
2. Move `ElementInserter` class (lines 136-221) to the new file.
3. Move the constant maps it uses:
   - `EVENT_TO_OUTER` (lines 43-68)
   - `EVENT_TO_INNER` (lines 74-99)
   - `EVENT_KEY_PROPERTY` (lines 105-116)
   - `PRE_COLLAPSED_EVENTS` (lines 122-124)
4. Export the class and maps.
5. Import in `message-streaming.ts`.

---

### 4.2 Consolidate `SessionEvent` interface

**Problem:** `SessionEvent` is defined in two places:
- `public/ts/websocket.ts` lines 23-26
- `public/ts/event-inserter.ts` lines 177-180

**Action:**
1. Keep the definition in `public/ts/types.ts` (add if not present).
2. Export from `types.ts`.
3. Remove duplicate definitions from both files.
4. Import from `types.ts` everywhere.

---

## Priority 5: Centralize DOM Element Access

### 5.1 Use `view-controller.ts` cached elements everywhere

**Problem:** `document.getElementById('chat')` appears 8+ times across files:
- `history.ts` lines 21, 30
- `main.ts` line 121
- `router.ts` lines 138, 157, 238
- `message-streaming.ts` lines 237, 337

**Solution exists:** `view-controller.ts` already caches elements (lines 40-53):
```typescript
cachedElements = {
  chatView: document.getElementById('chatScroll'),
  chat: document.getElementById('chat'),
  // ...
};
```

**Action:**
1. Export a `getElement(name)` function from `view-controller.ts`.
2. Replace all `document.getElementById('chat')` calls with `getElement('chat')`.
3. Repeat for other commonly accessed elements: `chatForm`, `imageData`, `imagePreview`, etc.

---

## Priority 6: Fix Dead Code Paths

### 6.1 Remove unreachable `'applet'` case in `input-router.ts`

**File:** `public/ts/input-router.ts` line 64

**Problem:** The switch statement has a case for `'applet'`:
```typescript
case 'applet': {
  const slug = getActiveAppletSlug();
  // ...
}
```

But `ViewState` type (defined in `view-controller.ts` line 17) is:
```typescript
export type ViewState = 'sessions' | 'newChat' | 'chatting';
```

The `'applet'` case can **never match** because it's not a valid `ViewState`.

**Action:** Either:
- A) Add `'applet'` to the `ViewState` type if applet is a valid main panel state.
- B) Remove the dead `case 'applet'` block from `input-router.ts`.

---

## Priority 7: Remove Debug Code

### 7.1 Remove hardcoded console.log in ElementInserter

**File:** `public/ts/message-streaming.ts` line 225

**Problem:**
```typescript
const inserterDebug: (msg: string) => void = console.log;
```

This logs every DOM insertion to console in production.

**Action:** Change to no-op:
```typescript
const inserterDebug: (msg: string) => void = () => {};
```

Or remove the debug parameter entirely and delete all `this.debug()` calls in the class.

---

## Priority 8: Reduce Window Global Pollution

### 8.1 Review globals exposed in `main.ts`

**File:** `public/ts/main.ts` lines 22-45

**Problem:** 10 functions dumped onto `window`:
```typescript
window.removeImage = removeImage;
window.scrollToBottom = scrollToBottom;
window.toggleSessions = toggleSessions;
// ... 7 more
```

**Rationale check:** These are needed for `onclick` handlers in HTML.

**Action:**
1. Audit which are actually used in HTML onclick handlers.
2. Consider using `addEventListener` in JS instead of inline onclick.
3. For those that must remain global, document why.

---

### 8.2 Review globals exposed in `applet-runtime.ts`

**File:** `public/ts/applet-runtime.ts` lines 53-77

**Problem:** 10+ functions exposed with ugly casting:
```typescript
(window as unknown as { setAppletState: typeof setAppletState }).setAppletState = setAppletState;
```

**Rationale:** Applet JS needs to call these.

**Action:**
1. Create a single `window.appletAPI` object instead of individual globals.
2. Type it properly once.
3. Applets call `window.appletAPI.setAppletState()` instead.

---

## Priority 9: Consistent Error Handling

### 9.1 Establish error handling pattern

**Problem:** Inconsistent approaches:

| File | Pattern |
|------|---------|
| `model-selector.ts` line 130 | `.catch(() => {})` — silent swallow |
| `session-panel.ts` line 129-132 | `console.error` + `alert()` |
| `message-streaming.ts` | `showToast()` for user-facing errors |

**Action:**
1. Define standard: Use `showToast()` for user-facing errors.
2. Use `console.error()` for developer-facing errors.
3. Never silently swallow errors (`.catch(() => {})`).
4. Find and fix all `.catch(() => {})` patterns.

```bash
grep -n "catch(() => {})" public/ts/*.ts
```

---

## Priority 10: Minor Cleanup

### 10.1 Remove unused imports

Run TypeScript compiler with `noUnusedLocals`:
```bash
npx tsc --noUnusedLocals --noEmit
```

### 10.2 Add missing type exports to `types.ts`

Types that should be centralized:
- `SessionEvent` (currently duplicated)
- `ViewState` (currently only in view-controller.ts)
- `ToastType`, `ToastOptions` (currently only in toast.ts)

### 10.3 Rename confusing alias in `applet-runtime.ts`

**Line 11:**
```typescript
import { getActiveSessionId as getWsActiveSession } from './websocket.js';
```

After Priority 3 is complete, this import should be removed entirely.

---

## Verification Checklist

After completing all actions, verify:

- [ ] `grep -r "applet-ws" public/ts/` returns nothing
- [ ] `grep -r "send-message" public/ts/` returns nothing
- [ ] `grep "activeSessionId" public/ts/*.ts` only shows `app-state.ts`
- [ ] `grep "console.log" public/ts/*.ts` shows no debug logging
- [ ] `npx tsc --noEmit` passes with no errors
- [ ] All existing unit tests pass: `npm test`
- [ ] Application loads and functions correctly in browser

---

## Summary Table

| # | Priority | File(s) | Action | Lines Affected |
|---|----------|---------|--------|----------------|
| 1.1 | P1 | applet-ws.ts | DELETE | -433 |
| 1.2 | P1 | send-message.ts | DELETE | -36 |
| 2.1 | P2 | message-streaming.ts | Remove duplicate function | -7 |
| 2.2 | P2 | session-panel.ts, ui-utils.ts | Consolidate formatAge | -15 |
| 3.1 | P3 | websocket.ts, app-state.ts, applet-runtime.ts | Single source of truth | ~50 |
| 3.2 | P3 | app-state.ts | Break circular dep | ~10 |
| 4.1 | P4 | message-streaming.ts | Extract ElementInserter | ~100 moved |
| 4.2 | P4 | websocket.ts, event-inserter.ts, types.ts | Consolidate SessionEvent | ~10 |
| 5.1 | P5 | Multiple files | Centralize getElementById | ~30 |
| 6.1 | P6 | input-router.ts | Fix/remove applet case | ~10 |
| 7.1 | P7 | message-streaming.ts | Remove debug logging | ~1 |
| 8.1 | P8 | main.ts | Document/reduce globals | ~20 |
| 8.2 | P8 | applet-runtime.ts | Create appletAPI object | ~30 |
| 9.1 | P9 | Multiple files | Consistent error handling | ~10 |

**Estimated net line reduction: ~500 lines**
