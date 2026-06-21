# Code Review — P2: single dispatch-teardown owner

**Commit:** `673e7a9` — "Route all dispatch exits through one teardown owner"
**Branch:** `code-review-brutal-2026-06`
**Scope:** `src/routes/session-messages.ts` (`dispatchMessage`), plus spec + new test.

## Verdict: **ship as-is**

No bug, race, or contract violation introduced by this commit. Typecheck clean
(`tsc --noEmit` exit 0); new test passes. The consolidation is faithful to the
original behavior on every exit path and strictly improves the two previously
divergent paths (`!session` early return, outer catch) by adding the missing
temp-file unlink and `busy=false` broadcast.

The findings below are the result of the requested scrutiny, not defects.

---

### 1. Idempotency — completeDispatch cannot run its body twice. (verified, no issue)
`completeDispatch` sets `dispatchCompleted = true` synchronously (line 290),
before its only `await` (the temp-file unlink, line 294). JS is single-threaded
and nothing interleaves between the `if (dispatchCompleted) return` guard
(line 289) and the assignment.
- **Sync send-error throw → outer catch:** the inner catch calls
  `void completeDispatch('send error')` (runs the synchronous body, sets the
  flag) *then* `throw err`. The outer catch sees `dispatchCompleted === true`
  and skips. Body runs once.
- **Concurrent SDK idle + watchdog timeout:** whichever fires first sets the
  flag; the second call returns at the guard. Body runs once.
- The async tail (unlink) from a `void` call is a detached promise, but it is
  guarded internally and identical in effect to the original fire-and-forget
  `unlink(p).catch(...)`.

### 2. Outer-catch rethrow — no behavior lost. (verified, no issue)
The framing that `if (!sendStarted) throw error;` is "now nested" inside
`if (!dispatchCompleted)` is not a change — the diff shows both lines as
unchanged context; the nesting was already present. The rethrow predicate is
identical in old and new: rethrow only when `!dispatchCompleted && !sendStarted`.
An error thrown *after* `dispatchCompleted` is already true was swallowed by the
outer catch in the original too (the inner send-error catch already set the flag
via `cleanupAndComplete` before `throw err`). No rethrow path is gained or lost.

### 3. `void` vs `await completeDispatch` ordering — no hazard. (verified, no issue)
On the async callback sites (`handleEvent` idle/error, watchdog timeout, async
send-error), the pattern is `void completeDispatch(...); unsubscribe();`.
`completeDispatch` runs `endDispatch` and the `busy=false` broadcast
*synchronously* (lines 292–293) before its first `await`, so both complete
before `unsubscribe()` executes — same ordering as the original synchronous
`cleanupAndComplete`. Only the temp-file unlink is deferred past `unsubscribe`,
which is order-independent. Pre-send paths (`no-session`, outer catch) use
`await`, so temp files are gone before the function returns/throws.

### 4. `if (dispatchCompleted) return` guard in handleEvent — drops nothing required. (verified, no issue)
The terminal event itself is fully processed (flush of queued caco events,
forwarding, `applyDispatchEventEffects`, `markIdle`/`pollQuota`) because the
guard passes while `dispatchCompleted` is still false on entry; completion
happens at the *end* of that same invocation. Every terminal site calls
`unsubscribe()` immediately after completing, so post-completion events do not
arrive in normal flow; the guard is a belt-and-suspenders against a late/buggy
SDK delivery, where dropping is the correct choice. During retry,
`dispatchCompleted` stays false, so events continue to flow. No event that must
be processed is dropped.

### 5. watchdog nullable + optional chaining — no unguarded deref. (verified, no issue)
`watchdog` is a `let … | null` initialized to null and assigned at line 337.
Every dereference uses `?.` (`watchdog?.cancel/reset/notifyEvent`). The only
call site reachable before assignment is the `no-session` path's
`completeDispatch('no-session')` → `watchdog?.cancel()`, which correctly no-ops.
The deferred `resetWatchdog: () => watchdog?.reset()` closures only fire after
assignment. No path dereferences `watchdog` expecting non-null.

---

## Minor observations (non-blocking, NOT introduced by this commit)
- The inner send-error catch's `throw err` (line 488) is effectively swallowed
  by the outer catch because `completeDispatch` has already set the flag and
  `sendStarted` is always false there. This is pre-existing dead rethrow
  behavior, unchanged by P2 — flagged only for awareness, not for this commit.
