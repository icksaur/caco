# File Edits V2.1 — Implementation Review

Reviewed: branch `file-edits-v2`, commit range `67f7be1..0b3a997`

Context: `docs/file-edits-v2.1.md`, `docs/file-edits-v2.1-review.md`

---

## [BLOCKER]

### BLOCKER-1: sendBeacon sends POST, not PUT

**File:** `applets/file-edits/script.js:111-114`

```js
navigator.sendBeacon(
  '/api/sessions/' + encodeURIComponent(sessionId) + '/file-edits/cards',
  blob
);
```

`navigator.sendBeacon` only sends **POST** requests; it cannot send PUT. The route is defined as `router.put(...)` at `src/routes/file-edits.ts:81`. The beforeunload beacon will 404 or 405, failing silently (caught in the `try/catch` at line 115).

**Impact:** Any dismiss or collapse gesture within 250ms of browser close is lost. The spec's "honors 'X is permanent' across browser-close-within-250ms" claim (line 261) is false.

**Fix:** Add a parallel POST route at the same path that internally calls the PUT handler, or change the route to accept both methods.

**Evidence:** sendBeacon spec (https://w3c.github.io/beacon/) states "The user agent MUST use the HTTP POST method". No option to override.

---

## [IMPORTANT]

### IMPORTANT-1: Snapshot cap math allows zero clean entries when edits.length = 50

**File:** `src/git-edit-poller.ts:526`

```ts
const slots = Math.max(0, 50 - edits.length);
```

When the dirty set is exactly 50, `slots = 0`, so **no** persisted-clean cards are included in the snapshot. A session with 50 dirty files and 5 persisted-clean cards sees only the 50 dirty on applet reopen. The 5 clean cards are rendered as header-only placeholders (line 1275-1284 of script.js) with empty bodies.

**Expected:** the spec says "prefer the most-recently-touched persisted entries" but does not explicitly bound by the 50-card cap at snapshot time. The client's `enforceCap` runs **after** snapshot merge (line 1208 in applyAll), so the snapshot could return 50 dirty + N clean, then the client evicts the oldest clean until total ≤ 50.

**Current behavior is conservative** (server-side cap enforcement) but breaks the "clean files keep their full content visible" goal for this edge case. Confirm intentional or adjust to allow overage, relying on client-side cap.

---

### IMPORTANT-2: persistedCleanPaths.slice(-slots) takes the tail, but the spec says "newest at end"

**File:** `src/git-edit-poller.ts:529`

```ts
const cleanCandidates = persistedCleanPaths
  .filter((p) => !current.has(p))
  .slice(-slots); // tail = most-recently-touched per spec
```

The comment says "tail = most-recently-touched", but the persisted cards array is in **insertion order** (oldest first, per Map iteration order in the client at line 55-62 of script.js). The tail is the **most-recently-appended** cards, which are the **newest** dirty-to-clean transitions or newly-touched files.

However, if a user dismisses a card and it's removed from the persisted list, then the user re-opens a file, that file is **appended** to the persisted list (it's new to the DOM). The "tail" logic works correctly for this case.

**Edge case:** a session with 100 persisted cards and 10 dirty → snapshot selects the last 40 (50-10) persisted. If the user opened cards in order A, B, C, ..., the tail is the most-recent. But if the user has been working in the same session for hours and the card list reflects historical order, the tail might be stale files from an old commit.

**Spec ambiguity:** "most-recently-touched" is not defined. Does it mean most-recent `updatedAt` in the persistence file (not tracked per-card), or insertion order? The implementation uses insertion order. Acceptable if documented.

---

### IMPORTANT-3: Missing check for sessionId before scheduling persistence

**File:** `applets/file-edits/script.js:43-54`

The `schedulePersist()` function checks `if (!sessionId) return;` at line 44. However, **other call sites** that mutate state and should persist do NOT guard on sessionId:

- Line 1004: `dismissCard` calls `schedulePersist()` after `dismissed.add(path)`. If called before `sessionId` is set (applet open pre-session-attach), the dismiss is recorded in-memory but never persisted.
- Line 1087: `enforceCap` calls `schedulePersist()` if paths were evicted. Same issue.
- Line 1337: `resetBtn` click calls `schedulePersist()` after `dismissed.clear()`. Same.

The guard inside `schedulePersist` prevents a fetch when `sessionId` is null, so the mutation is lost.

**In practice:** the applet only mounts when a session is active (onSessionChange fires immediately on attach), so `sessionId` is always set before any user gesture. However, the code is fragile to future changes (e.g. a "no session" mode that shows stale cards from a last-used session). Add a comment or hoist the guard to call sites.

**Not a current bug** but worth noting.

---

### IMPORTANT-4: setSessionData is synchronous inside setTimeout; uncaught exceptions kill the process

**File:** `src/file-edits-store.ts:84-91`

```ts
const timer = setTimeout(() => {
  pending.delete(sessionId);
  try {
    setSessionData(sessionId, STORE_NAME, merged as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn(`[FILE-EDITS-STORE] write failed for ${sessionId.slice(0, 8)}:`, (err as Error).message);
  }
}, DEBOUNCE_MS);
```

The `setSessionData` call is wrapped in try/catch, so failures are logged and ignored per spec. ✓

However, **`pending.delete(sessionId)` fires before the write**. If `setSessionData` throws (disk full, permission error), the pending entry is already deleted. A subsequent `flushSession(sessionId)` no-ops (line 98: `if (!p) return`), and the mutation is lost.

**Fix:** move `pending.delete(sessionId)` **after** the try/catch, or only delete on success. The flush path (line 97-106) has the same issue.

**Current behavior:** a failed write is logged, the timer fires, the pending entry is removed, and the next mutation schedules a fresh timer. The failed mutation is not retried. Acceptable for V2.1 per spec ("log + ignore"), but the early delete makes flush inert.

---

### ~~IMPORTANT-5: enforceCap walks cards.forEach but reads dataset.status which may be stale~~ ✓ RESOLVED

**File:** `applets/file-edits/script.js:1066-1088`

```js
cards.forEach(function(card, path) {
  var st = card.dataset.status;
  if (st === 'clean') cleanPaths.push(path);
  else dirtyPaths.push(path);
});
```

**Verification:** `_renderDiff` **does** update `card.dataset.status = newEdit.status` at line 980. When `markClean(path, entry)` calls `card._renderDiff(nextEdit)` where `nextEdit.status = 'clean'`, the dataset is updated. ✓ Eviction order is correct.

---

### IMPORTANT-6: flushPersist captures persistPendingSid at schedule time, not flush time

**File:** `applets/file-edits/script.js:69-76`

```js
function flushPersist() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  var sid = persistPendingSid;
  persistTimer = null;
  persistPendingSid = null;
  if (!sid) return;
  var body = buildPersistBody();
  void doPersistPut(sid, body);
}
```

**Scenario:** user dismisses a card (session A), then switches to session B within 250ms. `onSessionChange` calls `flushPersist()` (line 1352). The flush fires a PUT against `persistPendingSid`, which was set to session A's ID at line 46 when the timer was scheduled.

**However**, `buildPersistBody()` reads the **current** DOM state (line 54-62), which has already been cleared by `onSessionChange` at line 1358 (`streamEl.innerHTML = ''`; line 1359 `cards.clear()`). The body sent to session A reflects session B's (empty) state.

**Fix:** capture the body at schedule time alongside the session ID:

```js
var persistPendingBody = null;

function schedulePersist() {
  if (!sessionId) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistPendingSid = sessionId;
  persistPendingBody = buildPersistBody(); // capture now
  persistTimer = setTimeout(function() {
    var sid = persistPendingSid;
    var body = persistPendingBody;
    persistTimer = null;
    persistPendingSid = null;
    persistPendingBody = null;
    if (!sid || !body) return;
    void doPersistPut(sid, body);
  }, PERSIST_DEBOUNCE_MS);
}

function flushPersist() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  var sid = persistPendingSid;
  var body = persistPendingBody;
  persistTimer = null;
  persistPendingSid = null;
  persistPendingBody = null;
  if (!sid || !body) return;
  void doPersistPut(sid, body);
}
```

This ensures the flush sends the state **as of the last mutation**, not the cleared state.

**Current bug:** every session switch within 250ms of a mutation writes an empty card list back to the old session.

---

## [NICE]

### NICE-1: initFromPersistence pre-seeds cards but applyEdits may double-create

**File:** `applets/file-edits/script.js:1275-1285`

```js
persistedOrder.forEach(function(p) {
  if (cards.has(p)) return;
  var placeholder = {
    relativePath: p,
    status: 'clean',
    timestamp: new Date().toISOString(),
  };
  var card = makeCard(placeholder);
  streamEl.appendChild(card);
  cards.set(p, card);
});
```

A `caco.edit` event may arrive (via `window.appletAPI.onSessionEvent` at line 1343-1346) **between** `loadPersistedCards` (line 1255) and `fetchSnapshot` (line 1287). The event calls `applyEdits`, which checks `cards.has(p)` at line 1170 before creating a new card.

**Race trace:**

1. `initFromPersistence` starts.
2. `loadPersistedCards` completes; persisted includes `src/foo.ts`.
3. **Event arrives**: `caco.edit` with `edits: [{ relativePath: 'src/foo.ts', status: 'modified' }]`.
4. `applyEdits` runs. `cards.has('src/foo.ts')` is false (placeholder loop at line 1275 hasn't run yet).
5. `applyEdits` creates a card for `src/foo.ts` and appends it.
6. The placeholder loop runs. `cards.has('src/foo.ts')` is now true (line 1276 guard fires), so no duplicate.

**Conclusion:** the guard at line 1276 prevents double-creation. ✓ Not a bug.

However, the **order** is lost: the card from the event is appended at the end (line 1194), then the placeholder loop skips it. The persisted order is not preserved for paths that arrive via event before the snapshot.

**Impact:** minor UX regression when an event races with applet open. The card appears at the bottom instead of its persisted position. Acceptable for V2.1.

---

### NICE-2: buildPersistBody iterates streamEl.children but does not filter by element type

**File:** `applets/file-edits/script.js:51-67`

```js
var n = streamEl.children;
for (var i = 0; i < n.length; i++) {
  var c = n[i];
  var p = c.dataset.path;
  if (!p) continue;
  list.push({ relativePath: p, collapsed: userCollapsed.has(p) });
}
```

If any non-card element is inserted into `streamEl` (e.g. a debug notice, a loading spinner), it's skipped by the `if (!p) continue` guard. ✓ Safe.

However, the loop assumes `c.dataset` exists. All HTML elements have dataset, so this is fine. Not a bug.

---

### NICE-3: applyEdits conditional persist check may fire on every poll with 0 mutations

**File:** `applets/file-edits/script.js:1203-1219`

```js
function applyAll() {
  var beforePaths = [];
  var c = streamEl.children;
  for (var k = 0; k < c.length; k++) beforePaths.push(c[k].dataset.path || '');
  for (var i = 0; i < mutations.length; i++) mutations[i]();
  enforceCap();
  updateCounts();
  var afterPaths = [];
  var c2 = streamEl.children;
  for (var m = 0; m < c2.length; m++) afterPaths.push(c2[m].dataset.path || '');
  if (beforePaths.length !== afterPaths.length
      || beforePaths.some(function(p, idx) { return p !== afterPaths[idx]; })) {
    schedulePersist();
  }
}
```

`applyAll` is only called when `mutations.length > 0` (guard at line 1201), so `beforePaths` and `afterPaths` differ only if a mutation added/removed a card or `enforceCap` evicted. ✓ Correct.

However, the path comparison does not detect **collapsed-state changes**. If a card's body is re-rendered with new content but the path list is unchanged, `schedulePersist()` does not fire.

**Is this a bug?** No — the collapsed state is tracked in `userCollapsed` (line 933-945), which is modified by the chevron click handler. That handler directly calls `schedulePersist()` (line 944 — not shown in diff but implied by V2 behavior). The `applyAll` persist check is only for **structural** changes (add/remove), not collapse toggles. ✓ Correct by design.

---

### NICE-4: fullFileEqual does not short-circuit on workLines inequality

**File:** `applets/file-edits/script.js:1104-1106`

```js
var wA = a.workLines || [], wB = b.workLines || [];
if (wA.length !== wB.length) return false;
for (var j = 0; j < wA.length; j++) if (wA[j] !== wB[j]) return false;
```

The loop iterates `wA.length` even when the length check has already passed. The early-return at line 1106 short-circuits on first mismatch. ✓ Efficient.

However, the function compares `workLines` **before** `headLines` (line 1107-1114). For clean files, `workLines = headLines`, so the comparison is done twice. Reordering to compare headLines first (which may be null, a cheaper check) would be a micro-optimization. Not worth changing.

---

### NICE-5: buildCleanEntry handles FULLFILE_LINE_CAP correctly

**File:** `src/git-edit-poller.ts:372-393`

```ts
async function buildCleanEntry(repoRoot: string, relPath: string): Promise<EditEntry | null> {
  const headText = await readHeadBlob(repoRoot, relPath);
  if (headText === null) return null;
  const lines = toLines(headText);
  if (lines.length > FULLFILE_LINE_CAP) {
    return {
      path: join(repoRoot, relPath),
      relativePath: relPath,
      status: 'clean',
      timestamp: new Date().toISOString(),
    };
  }
  return {
    path: join(repoRoot, relPath),
    relativePath: relPath,
    status: 'clean',
    timestamp: new Date().toISOString(),
    fullFile: { headLines: lines, workLines: lines, hunks: [] },
  };
}
```

When `lines.length > FULLFILE_LINE_CAP`, the function returns an entry **without** `fullFile`, causing the client to render a header-only card. ✓ Per spec line 97-98: "Missing-blob handling: if `git show HEAD:<path>` returns non-zero (path no longer in HEAD — was deleted after commit), omit `fullFile` and the card falls back to '(no diff)'."

However, the **too-large** case is not explicitly called out in the spec. The spec says "bounds payload + render cost" (line 87-88) but doesn't document the fallback behavior for oversized clean files. The implementation is correct (matches the V2 behavior for dirty files), but the spec should note that clean files exceeding 5000 lines render header-only.

---

### NICE-6: pollSession cleanedEdits concurrency shares DIFF_CONCURRENCY with edits

**File:** `src/git-edit-poller.ts:428-434`

```ts
const cleanedEdits: EditEntry[] = [];
if (cleared.length > 0) {
  const cleans = await mapWithConcurrency(cleared, DIFF_CONCURRENCY, async (path) => {
    return buildCleanEntry(state.repoRoot, path);
  });
  for (const c of cleans) { if (c) cleanedEdits.push(c); }
}
```

The `cleans` batch runs **after** the `diffs` batch (line 419-424). Each batch is bounded by `DIFF_CONCURRENCY=4`, so the total in-flight subprocess count is still 4 at any moment. ✓ No fork-bomb risk.

However, the spec says "Concurrency: reuse `mapWithConcurrency(..., DIFF_CONCURRENCY)`" without clarifying whether the two batches run in series or parallel. The implementation runs them in series. If a poll has 10 dirty + 10 cleared, the total time is ~5 batches (10/4 rounded up for dirty, then 10/4 for cleared). A parallel approach would be faster but harder to bound.

**Current behavior is safe** and matches the spec's "the existing concurrency bound is still `DIFF_CONCURRENCY=4`" claim.

---

## [QUESTION]

### QUESTION-1: What happens if dismissed.clear() is called while persistence is pending?

**File:** `applets/file-edits/script.js:1336-1338`

```js
resetBtn.addEventListener('click', function() {
  dismissed.clear();
  schedulePersist();
  void fetchSnapshot();
});
```

User clicks Reset, which calls `dismissed.clear()` and schedules a persist. If a dismiss happened 100ms earlier (within the 250ms debounce), the pending PUT still has the old dismissed set. The `schedulePersist` call at line 1337 cancels that timer and schedules a new one with the cleared set.

**Trace:**

1. User dismisses `src/foo.ts` → `dismissed.add('src/foo.ts')` → `schedulePersist()` starts a 250ms timer.
2. 100ms later: user clicks Reset → `dismissed.clear()` → `schedulePersist()` cancels the first timer, schedules a new one.
3. The PUT fired by the second timer has an empty `dismissed` array.

**Conclusion:** ✓ Correct. The latest mutation wins. The spec says "the latest body wins" (line 72-73 of file-edits-store.ts).

---

### ~~QUESTION-2: Does _renderDiff update card.dataset.status?~~ ✓ VERIFIED

**File:** `applets/file-edits/script.js:980`

```js
card._renderDiff = function(newEdit) {
  card._edit = newEdit;
  card.dataset.status = newEdit.status || 'modified';
  // ... rest of update
```

**Answer:** Yes. `_renderDiff` updates `card.dataset.status` on every call. IMPORTANT-5 is not a bug.

---

### ~~QUESTION-3: Can GET /cards return 404 if the session directory doesn't exist yet?~~ ✓ SAFE

**File:** `src/session-data-store.ts:32-39`

```ts
export function getSessionData(sessionId: string, name: string): Record<string, unknown> | null {
  if (!isValidDataName(name)) return null;
  const filePath = join(getSessionDir(sessionId), `${name}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}
```

**Answer:** `getSessionData` returns `null` for missing files, never throws. `getCardList` (file-edits-store.ts:49-63) handles `null` by returning the empty-list fallback. The route does not need try/catch for missing sessions.

The `ensureSession` guard at routes.ts:72 verifies the session exists in `sessionManager` before calling `getCardList`, so the session directory is guaranteed to exist. ✓ Safe.

---

## Summary

| Level      | Count |
|------------|-------|
| BLOCKER    | 1     |
| IMPORTANT  | 5     |
| NICE       | 6     |
| QUESTION   | 1     |
| **Total**  | **13** |

**Blockers:** sendBeacon sends POST, not PUT (route mismatch).

**High-priority bugs:**
- IMPORTANT-6: session switch within debounce window writes empty card list to old session.
- IMPORTANT-4: `pending.delete` fires before write, making flush inert on failure.

**Verified:**
- QUESTION-2: `_renderDiff` updates `card.dataset.status` ✓ (line 980).
- QUESTION-3: `getSessionData` returns `null` for missing files, never throws ✓ (session-data-store.ts:35).

**Acceptable design choices:**
- IMPORTANT-1: server-side cap enforcement is conservative but correct.
- IMPORTANT-2: tail selection uses insertion order; acceptable if documented.
- NICE-1: event race with applet open is rare and has minor UX impact.

**Recommended fixes before merge:**
1. Add POST route for sendBeacon (BLOCKER-1).
2. Capture `buildPersistBody()` at schedule time, not flush time (IMPORTANT-6).
3. Move `pending.delete` after try/catch (IMPORTANT-4).
4. Verify and document QUESTION-2.
