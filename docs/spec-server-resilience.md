# Spec: Server resilience — survive benign watcher faults

## Status
Draft — pending gpt-5.3-codex review, then implementation on branch `server-resilience`.

## Overview

The Caco server process was killed by a single **unhandled `fs.watch` EPERM**:

```
[UNCAUGHT EXCEPTION] Error: EPERM: operation not permitted, watch
    at FSWatcher._handle.onchange (node:internal/fs/watchers:214:21) {
  errno: -4048, syscall: 'watch', code: 'EPERM', filename: null }
```

Context (from `~/.caco/logs/server-20260722-082802.log`): a session rooted in a
**OneDrive-synced** folder (`C:\Users\...\OneDrive - Microsoft\Desktop\workspace`)
was active; mid-dispatch, a filesystem watcher threw `EPERM: watch`. The error
reached the process-level `uncaughtException` handler (`server.ts:435`), which
**unconditionally `process.exit(1)`s** — taking the whole server (and every other
session running inside it) down.

This is a **fault-tolerance gap**, not a Windows-path bug. The prior
windows-test-portability work (`spec-windows-test-portability.md`, item A9) added
`.on('error')` handlers to the two raw `fs.watch` sites Caco *owns*
(`extension-store.ts`, `watch-store.ts`). But per-watcher handlers can only cover
watchers we create. This EPERM escaped **every** per-watcher listener — it came
from a watcher Caco does not own (chokidar's internal per-directory `fs.watch`,
or an SDK/dependency watcher) — and the one process-level chokepoint treats every
uncaught error as fatal.

## Why this happened despite A9

Confirmed from the crash log + git state:
- The crashed process **started 2026-07-16**, well after the A9 fix (merged
  `9baf81b`, 2026-07-13). Both A9 handlers were live in the running process.
- The `[UNCAUGHT EXCEPTION]` prefix is emitted by `server.ts:435` — proof the
  watch error bypassed all `FSWatcher.on('error')` listeners and hit the process
  handler.
- A raw `FSWatcher` with **no `'error'` listener**, on emitting `'error'`, makes
  Node throw synchronously → `uncaughtException`. So the culprit watcher had no
  listener: it is one Caco doesn't own (chokidar internals / SDK / future code).

**OneDrive is the trigger.** On-demand sync constantly mutates reparse points and
dehydrates/rehydrates files under the synced tree; Windows then raises spurious,
transient `EPERM: watch` on directory watches. These are *benign* — the watcher
is simply gone; the process can and should continue.

## The core insight

Per-watcher `.on('error')` handlers are **necessary but not sufficient**: they
cannot cover watchers created inside dependencies (chokidar, the Copilot SDK) or
any watcher added later without remembering to guard it. The **process-level
`uncaughtException` handler is the single chokepoint** that sees them all. Today
it converts a survivable watcher fault into a hard exit. It should instead treat
a benign watcher fault the way the sibling `unhandledRejection` handler already
treats SDK async errors: **log it, record it for post-mortem, and keep running.**

## Goals

1. A benign filesystem-watcher fault (`syscall === 'watch'`, e.g. `EPERM`,
   `ENOSPC`, `EPERM`/`ENOENT` on a watched-dir teardown) **never terminates the
   server.** It is logged + recorded, and the process survives.
2. Genuinely fatal uncaught exceptions **still exit** (unchanged behavior) — we do
   not blanket-swallow everything, which would risk running in a corrupt state.
3. The crash record still lands in `~/.caco/logs/crash.log` for every case
   (survived or fatal), so nothing is lost to post-mortem.
4. No behavior change on Linux for real faults; the watcher-survival path is
   simply rarely/never exercised there.

## Non-Goals

- Not removing or weakening the existing per-watcher `.on('error')` handlers
  (A9). Defense in depth: keep both layers.
- Not attempting to identify/guard the specific unowned watcher (chokidar/SDK).
  The process-level guard covers it and all future ones; chasing the individual
  watcher is brittle and dependency-version-specific.
- Not turning the server into a swallow-all process. Only a **narrow, classified**
  set of benign faults survives; everything else exits as before.
- Not changing `unhandledRejection` (already non-fatal) or `SIGINT`.

## Design

### Classify the error, then decide

Add a small predicate that recognizes a **benign, survivable** fault, and branch
the `uncaughtException` handler on it:

```ts
/** A transient filesystem-watch fault (e.g. Windows EPERM on a OneDrive-synced
 *  tree, or ENOSPC exhausting inotify) surfaced by an fs.watch/chokidar watcher
 *  we may not own. The watcher is gone; the process can safely continue.
 *  Lives in src/watch-fault-classifier.ts (pure, unit-testable; server.ts is
 *  import-side-effecting so the helper can't live there). */
const WATCH_FAULT_CODES = new Set(['EPERM', 'EACCES', 'ENOENT', 'EBADF', 'ENOSPC', 'EMFILE']);
export function isBenignWatcherFault(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  if (!e || e.syscall !== 'watch' || !e.code) return false;
  if (WATCH_FAULT_CODES.has(e.code)) return true;
  return platform === 'win32' && e.code === 'UNKNOWN'; // OneDrive sometimes reports UNKNOWN
}
```


process.on('uncaughtException', (err) => {
  if (isBenignWatcherFault(err)) {
    // A filesystem watcher (possibly one we don't own — chokidar/SDK) died with
    // a transient OS error. Record it but DO NOT exit: killing every session
    // over a lost directory watch is far worse than losing live-reload on one
    // path. Mirrors the unhandledRejection policy below.
    console.warn(`[WATCH-FAULT survived] ${(err as NodeJS.ErrnoException).code} ${(err as NodeJS.ErrnoException).syscall}`);
    recordCrash('uncaughtException:watch-survived', err);
    return;
  }
  console.error('[UNCAUGHT EXCEPTION]', err);
  recordCrash('uncaughtException', err);
  try { flushAllFileEditsCardLists(); } catch { /* ignore */ }
  process.exit(1);
});
```

Key points:
- **Gated by `syscall === 'watch'`** — we do not survive arbitrary `EPERM`
  (e.g. a failed `open`/`write`, which may indicate real trouble). Only watcher
  faults, which are known-benign and self-contained.
- **Still records** to `crash.log` under a distinct kind
  (`uncaughtException:watch-survived`) so the frequency is visible in post-mortem
  and we can tell survived-vs-fatal apart.
- **Log the error TYPE/code only**, never the message/path (may carry PII), per
  the project's logging rule.
- The fatal path is byte-for-byte the previous behavior.

### Why not just add `.on('error')` to the specific watcher?

We can't reliably: the emitting watcher is created inside a dependency
(chokidar's per-dir `fs.watch`, or the SDK), and its identity/version can change.
The A9 per-watcher handlers stay for the watchers we *do* own (they also let those
degrade gracefully — e.g. close + drop the lease). The process-level guard is the
catch-all backstop for everything else.

## Considerations / risks

- **R1 — Masking a real bug.** Surviving could hide a watcher that *should* be
  fixed. Mitigation: we still `recordCrash(...:watch-survived)` every time, so the
  signal is preserved and countable; we can revisit if it becomes frequent.
- **R2 — Running in a corrupt state.** A lost watch does not corrupt server state
  — it only means that path stops emitting change events (live-reload / files-applet
  freshness degrades for that path until re-attach or next poll). The git-edit
  poller already has a timer-only backstop cadence. So surviving is safe.
- **R3 — Over-broad classification.** Bounding on `syscall === 'watch'` plus a
  small code allowlist keeps this narrow. A real fatal error with a different
  syscall still exits.
- **R4 — Repeated faults / thrash.** If a watcher re-arms and repeatedly EPERMs,
  we could log-spam. Accepted for now (each is recorded; volume is itself a
  signal). A future dedupe/backoff is out of scope.

## Implementation plan

1. Add `isBenignWatcherFault(err)` helper in `server.ts` near `recordCrash`.
2. Branch the `uncaughtException` handler: survive benign watcher faults
   (log type/code + `recordCrash('uncaughtException:watch-survived', err)` +
   `return`); otherwise unchanged (`process.exit(1)`).
3. Keep A9 per-watcher handlers as-is.
4. Test (see below).
5. Manual verification on this Windows box before commit.

## Test / verification strategy

- **Unit:** extract the classifier (`isBenignWatcherFault`) so it is testable
  without the process handler, and assert:
  - `{ syscall:'watch', code:'EPERM' }` → true; `ENOSPC`/`ENOENT`/`EBADF` → true.
  - `{ syscall:'open', code:'EPERM' }` → false (non-watch).
  - `{ syscall:'watch', code:'EACCES' }` → false (not in allowlist) — or decide to
    include; see open question.
  - `undefined` / plain `Error` → false.
  If the handler wiring itself is covered by an existing server harness, add a
  case that a synthesized benign watcher error does not call `process.exit`; else
  unit-test the classifier only (the handler is a thin branch over it).
- **Manual:** on this box, confirm the server stays up when a watch EPERM occurs
  (hard to force deterministically; at minimum confirm the classifier + that a
  simulated benign error is logged as `watch-survived` and the process keeps
  serving). Confirm a normal fatal error still exits.
- Full unit suite stays green (`vitest run`), no Linux regression.

## Open questions for review — RESOLVED (gpt-5.3-codex)

1. **Code allowlist.** Final: `EPERM, EACCES, ENOENT, EBADF, ENOSPC, EMFILE`
   (all with `syscall === 'watch'`), **plus `UNKNOWN` on win32 only** (OneDrive
   sometimes surfaces `code:'UNKNOWN'`). Do NOT include broad `EINVAL`/`EEXIST`.
2. **`syscall` gate is sufficient** — no brittle stack-string matching.
3. **Fatal path unchanged** — no self-restart here; start scripts/autostart
   already relaunch on a real exit.
4. **Testability:** `server.ts` is import-side-effecting (`start()` runs at module
   load, no exports), so the classifier lives in its own pure module
   `src/watch-fault-classifier.ts` and is unit-tested there.
5. **Storm detection:** rate-limit **both** the survived-fault console line and
   the `crash.log` persist (once/min, carrying a suppressed-count), so a
   thrashing watcher can neither spam stderr nor churn `crash.log` (one rotated
   generation only — unbounded persists could evict real fatal history). Persist
   **code + syscall only**, never `err.message`/stack (may carry a path/PII).
