# Code review — `file-edits-v1`

Scope: `git diff master..file-edits-v1` (10 files, +1073 / −1). Reviewed against `docs/file-edits.md` and `code-quality.md`.

---

## BLOCKERS

### B1. Applet shows stale diff after an update when the card was collapsed
**File:** `applets/file-edits/script.js:73-180` (`makeCard` / `_renderDiff` / `toggle`)
**Problem:** `toggle()` is a closure that captures the original `edit` parameter from `makeCard`. When an update comes in for an existing path, `_renderDiff(newEdit)` correctly updates `card._edit`, and — if the card is currently collapsed — calls `delete body.dataset.rendered` so the *next* expand will lazy-render. But that next expand still executes `body.innerHTML = renderDiff(edit.diff)` (line 128), reading the **stale closure variable**, not `card._edit.diff`. Result: user expands a card after one or more updates landed while it was collapsed and sees the very first diff that ever arrived for that path.

This is exactly the failure mode the reviewer asked us to verify, and it reproduces by inspection: the only thing the collapsed-update path does is invalidate the `rendered` flag, but the renderer it re-runs hasn't been pointed at the new data.

**Suggested fix:** in `toggle`, replace `renderDiff(edit.diff)` with `renderDiff(card._edit.diff)` (same fix for `_renderDiff`'s expanded branch for consistency, though that one is already correct).

---

### B2. Snapshot `path` (and poll `path`) is wrong for renames
**File:** `src/git-edit-poller.ts:226` and `:324`
**Problem:** For a rename entry the code builds the absolute `path` as `join(repoRoot, info.renamedFrom ?? path)`. That joins the **old** (source) path. The published `EditEntry` contract is `{ path: absolute, relativePath: <new>, renamedFrom?: <old> }`. After a rename the source path doesn't exist on disk; any consumer that opens `entry.path` (an obvious next step — "click card → open file in editor", and the v2 follow-ups in the spec assume it) lands on a non-existent file.

This looks like a typo: the `??` operands are inverted. The author almost certainly meant `info.renamedFrom ? path : path` — i.e., the new path is always the right thing to join, the `renamedFrom` is only the bookkeeping that lives in its own field.

**Evidence:** the relativePath/renamedFrom split everywhere else in the file is consistent (new = primary, old = `renamedFrom`); only the `path` join inverts it. Two occurrences (poll loop + snapshot), same bug both places.

**Suggested fix:** `path: join(state.repoRoot, path)` in both spots; drop the `??`.

---

## IMPORTANTS

### I1. Unbounded `git diff` subprocess fan-out
**File:** `src/git-edit-poller.ts:221` (poll loop) and `:321` (snapshot)
**Problem:** Both call sites do `Promise.all(paths.map(p => fetchDiff(...)))`, which spawns one `git diff` subprocess per dirty path with no concurrency cap. The realistic worst case is unavoidable on this codebase: a `git checkout` of another branch, a `git stash pop`, or a large `sed -i` produces a 100–500 file dirty set, and the very next poll (event-triggered, ~50 ms after the tool completes) spawns that many `git` processes simultaneously. On a workstation that's a momentary spike; on a smaller container or a session with several active repos that's an OOM / fork-bomb risk. The snapshot endpoint compounds it: two clients open the applet at the same time → 2× the spike, completely independent of the poll guard (`state.polling` doesn't gate `snapshot`).

**Suggested fix:** small concurrency pool (e.g. 8) shared across `fetchDiff` calls; reuse it from both `pollSession` and `snapshot`. A trivial p-limit-style helper is fine — no new dep needed.

---

### I2. `parsePorcelain` doesn't handle copy entries (`C`)
**File:** `src/git-edit-poller.ts:114-128`
**Problem:** Copy detection uses the same two-field NUL-delimited encoding as rename (`C  new\0old\0`). The parser only special-cases `R`, so a `C` entry is bucketed as `modified` and the *source* path is then mis-parsed as its own porcelain entry on the next loop iteration (where it will have a garbage `xy` derived from the first two bytes of the source filename). One out-of-spec poll desynchronises `lastDirty` from reality until the working tree settles.

Default `git status` does **not** enable copy detection (`status.renames=copies` is opt-in), so this won't fire for most users — which is why I'm marking it IMPORTANT rather than BLOCKER. But anyone with `status.renames=copies` in their config (a real and documented setting) will hit it.

**Suggested fix:** add `|| xy[0] === 'C'` to the rename branch (the field layout is identical) and add a status variant or fold it into `renamed`.

---

### I3. Spec says "v1 always auto-scrolls"; code only scrolls on insert
**File:** `applets/file-edits/script.js:253-255`; spec §Auto-scroll
**Problem:** `applyEdits` sets `streamEl.scrollTop = 0` only when `addedAny` is true. The dominant case during an active edit session is *update an existing card* (same path re-edited), which moves the card to the top but does not scroll. The spec explicitly says: *"v1 always auto-scrolls so the newest card is visible. Simple and easy."* The current behavior is the v2 sticky behavior minus the smart parts.

**Suggested fix:** scroll whenever `edits.length > 0` and at least one was not dismissed (i.e. anything was applied, whether new or updated).

---

### I4. Dead branch in poll loop
**File:** `src/git-edit-poller.ts:201-210`
**Problem:** Both branches of `if (!prev || prev.status !== info.status) { newOrChanged.push(path); } else { newOrChanged.push(path); }` do the same thing. The comment acknowledges this is a v2 optimization placeholder — but in v1 it's just dead code that reads as a meaningful conditional. Per `code-quality.md` (no speculative scaffolding) the whole `if/else` should collapse to a single push.

**Suggested fix:** `for (const path of current.keys()) newOrChanged.push(path);` — and drop the v2-mtime comment, that lives in the spec.

---

## Items reviewed and cleared

- **Race on `state.lastDirty = current` after the await (#3 in the brief).** The `state.polling` guard at line 189 forecloses overlapping `pollSession` calls; the second trigger returns immediately. There is a related minor effect — a `triggerPoll` that fires while a poll is in flight is *dropped* rather than queued (the debounce already consumed it, and the in-flight poll doesn't re-check on completion) — but the 1.5 s active timer picks up any missed work. Acceptable for v1.
- **Overlapping `scheduleTimer` calls (#4).** Every `scheduleTimer` call clears the previous timer before setting a new one, so the worst case is one redundant `clearTimeout`. No leak.
- **Detach race (#6).** In-flight `pollSession` continues, eventually calls `broadcastEvent` on a torn-down session (WebSocket layer no-ops cleanly) and `scheduleTimer` (no-ops because `sessions.get` returns `undefined`). Harmless.
- **`event-bus.broadcastEvent` import (#11).** Correctly routed through `src/event-bus.ts` (which re-exports from `routes/websocket.ts`). ✓
- **`session.cwd` lifecycle gap (#10).** `ensureSession` and the `snapshot` call both go through `sessionManager.getSessionCwd`; a session that hasn't been activated yet 404s cleanly. No silent failure.
- **`meta.json` shape (#12).** `params: {}` matches the existing `jobs` applet (no params, also no `stateSchema`). The applet does not push state, so `stateSchema` is correctly omitted. ✓
- **Porcelain parser coverage (#1, beyond the copy case).** `AD`/`MD`/`AM`/`MM`/`??`/` D`/`UU` all bucket correctly under the existing rules. Tests cover the happy paths; the only real-world gap is `C` (covered in I2).

---

## Verdict

**Do not merge as-is.** Two blockers (B1: stale diff after collapsed update; B2: rename `path` field points at the old file) and four importants. B1 and B2 are both small, surgical fixes — under ten lines each. Recommend a single follow-up commit addressing B1, B2, I1, I2, I3, I4, then re-review.
