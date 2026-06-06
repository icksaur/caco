# File Edits V3.3 — Filesystem watch for sub-second updates

Builds on V3.2 (`docs/file-edits-v3.2.md`, shipped on master). First
V3 increment targeting **polling and responsiveness**.

## Goal

Replace (or short-circuit) the 1.5s active / 5s idle git-status
polling loop with a filesystem watcher so non-agent edits (user
saves in VSCode, shell tools writing files) are reflected in the
applet within <300ms instead of up to 5s.

Use chokidar as the primary mechanism. Document `git fsmonitor` as
an explicit non-goal for V3.3 (deferred to V4).

## Why chokidar, not git fsmonitor

| Concern | chokidar | git fsmonitor |
|---|---|---|
| External setup | none (npm dep) | `core.fsmonitor true` per-repo OR built-in `git fsmonitor--daemon` (git 2.36+) |
| What it accelerates | "when to poll" — eliminates timer entirely | "what `git status` does" — makes status calls cheap |
| Process model | one inotify subscription per session repo | one git-fsmonitor daemon per repo (long-lived) |
| Cap | inotify watches (kernel limit, typically 8192/user) | one daemon per cwd |
| Failure mode | falls back to polling | falls back to walking |

Our problem is detection latency. `git status` is already cheap on
typical repos (<20ms per the existing measurements). The cost is the
1.5–5s tick interval. chokidar fires events on inotify so we can
trigger a poll immediately.

`git fsmonitor` is a future optimization for very large repos where
`git status` itself becomes the bottleneck (e.g. monorepos >50k
files); deferred.

## Scope (locked)

- One chokidar watcher per session, rooted at the session's
  `repoRoot` (not `cwd` — captures changes across the whole repo).
- Honors `.gitignore` (chokidar's `ignored` option using the same
  `ignore` package the file picker uses).
- Falls back to existing 1.5s/5s polling if chokidar fails to attach
  (permission, missing inotify, watch cap exceeded).
- Debounces fs events into a single poll trigger per 50–150ms burst
  (matches `git status` cost; absorbs typical "save fires N events"
  patterns from editors).
- Idle polling timer (5s) stays as a safety net even when chokidar
  is active. Active polling timer (1.5s) is dropped — chokidar's
  event-driven trigger is faster.
- No new endpoints. No new event types. No client changes.

## Non-goals (V3.3)

- `git fsmonitor` integration. V4.
- Per-repo shared watcher across sessions (multiple sessions on the
  same cwd each get their own watcher; refcount sharing is a
  V4 optimization).
- Watching outside the session's git repo root (e.g. cross-repo
  symlinks, submodules). V4.
- Reacting to fs events with anything other than "trigger a poll."
  No selective re-fetch of individual files; the poll is the
  source of truth.
- Removing the timer entirely. Idle timer (5s) stays as a backstop
  for cases where chokidar misses (e.g. mmap'd writes on some
  filesystems).

## Preserved invariants

- Server contracts unchanged: `/snapshot`, `/open`, `/cards`,
  `caco.edit` event shape.
- Client unchanged. Faster polls = more frequent `caco.edit` events
  = the existing tab UI just feels snappier.
- The 50-tab cap, persistence flow, picker, Follow button — all
  unchanged.
- `tool.execution_complete` write-tool trigger continues to fire its
  own poll (sometimes faster than fs events, sometimes redundant
  with them — debounced together).

---

## Design

### Server module: `src/file-watcher.ts` (new)

```ts
export interface FileWatcher {
  /** Attach a chokidar watcher to repoRoot. Idempotent per session.
   *  Returns true if attached, false if chokidar errored and the
   *  caller should fall back to timer-only polling. */
  attach(sessionId: string, repoRoot: string, onChange: () => void): boolean;
  detach(sessionId: string): void;
  /** Diagnostic: are we currently watching this session? */
  isWatching(sessionId: string): boolean;
}

export function createFileWatcher(): FileWatcher;
```

Implementation:

- **Add npm dep:** `npm install chokidar` — pin to `^5` (drops the old
  optional `fsevents` dep; ESM-only, min Node 20 — compatible with
  Caco's `"type": "module"`). Bundle size ~50KB, not the ~250KB of v3.
- Constructor options:
  - `persistent: false` — doesn't keep the event loop alive on its own.
  - `ignoreInitial: true` — don't emit events for files that already
    exist on watcher start.
  - `awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }`
    — collapse chunked writes (VS Code, large files).
  - **`atomic: true`** — coalesce vim's `:w` temp-file-then-rename
    pattern (and emacs, many CI tools) into a single `change` event.
    Without this, vim saves emit `unlink` + `add` which bypasses
    `awaitWriteFinish`. The two options handle different patterns
    and don't conflict.
  - `followSymlinks: false` — **overrides chokidar's default of
    `true`**. Keeps the watch scoped to the repo; symlinks pointing
    outside the repo aren't followed.
  - `ignored: ignoreInstance` — uses the `ignore` package loaded from
    the repo's `.gitignore` plus a hard-coded list of dirs
    (`node_modules`, `.git`, `dist`, etc. — same `EXCLUDED_DIRS` as
    `src/routes/api.ts:472`).
- Subscribe to `all` events (add, change, unlink, addDir, unlinkDir).
  Any event → call `onChange()`.
- On any chokidar `error` event: log + call `detach()` for that
  session. Caller stays in timer-only mode.

### Wire into `git-edit-poller`

`createGitEditPoller()` gains an internal `fileWatcher` instance.

**Type changes (required for compilation):**

- `GitEditPoller` interface (currently
  `triggerPoll(sessionId: string, source: 'event'): void`):
  becomes `source: 'event' | 'fs-event'`.
- `pollSession` (currently `source: 'timer' | 'event'`):
  becomes `source: 'timer' | 'event' | 'fs-event'`.
- Both implementation sites and the interface declaration must be
  updated.

`attachToSession(sessionId, cwd)`:
1. Existing: resolve repoRoot, set up `SessionPollerState`.
2. Existing: run the initial inline non-broadcasting poll to
   populate `lastDirty`. (DO NOT attach chokidar before this — see
   note below.)
3. **New: call `fileWatcher.attach(sessionId, repoRoot, () =>
   triggerPoll(sessionId, 'fs-event'))`** AFTER step 2 completes.
   This ordering matters: if chokidar fires before `lastDirty` is
   populated, `pollSession` would see every dirty file as "new" and
   broadcast a full-dirty event on attach — spurious.
4. If `attach` returns false, log and continue with timer-only mode.
5. `scheduleTimer(sessionId)`.

`detachFromSession(sessionId)`:
1. Existing: clear timers, drop state.
2. New: call `fileWatcher.detach(sessionId)`.

`triggerPoll` gains source `'fs-event'`. Same debounce path as
'event' (50ms). The poll path is unchanged.

### Polling cadence (normative)

| Condition | Backstop tick |
|---|---|
| `fileWatcher.isWatching(sessionId) === true` | 30s |
| `fileWatcher.isWatching(sessionId) === false` (failure fallback) | 5s |

The V3.2 "1.5s active when an edit-event fired in the last 10s"
cadence is **dropped entirely** in V3.3. Reasoning:

- When chokidar is attached, fs events drive polling directly. The
  active cadence is meaningless — chokidar IS the active signal.
- When chokidar isn't attached, the 5s idle cadence covers all
  cases. The 1.5s acceleration was a heuristic that doesn't reliably
  beat 5s anyway, and removing it simplifies the state machine.

This is a small UX regression for the chokidar-disabled fallback
path (5s vs V3.2's 1.5s), but the fallback exists only when chokidar
can't attach — a rare failure mode, not the steady state. Net win.

### Debounce alignment

V3.3 doesn't change the existing 50ms `DEBOUNCE_MS` in
`triggerPoll`. Chokidar's `awaitWriteFinish.stabilityThreshold = 100`
already absorbs the per-save event burst. Net latency from a single
external save:

```
0ms: save fires N inotify events
0–100ms: chokidar awaitWriteFinish coalesces
~100ms: chokidar emits one event
~100ms: onChange → triggerPoll → 50ms debounce
~150ms: pollSession runs → git status (~20ms) + diff per file
~170ms: caco.edit broadcast
~200ms: client renders updated tab
```

Operator target was sub-second; this is ~5x improvement.

### Resource bounds

- inotify watch slots: chokidar uses one per directory. The Linux
  default is 8192 watches per user (verify with
  `cat /proc/sys/fs/inotify/max_user_watches`; varies by distro —
  Arch/Ubuntu/WSL2 ship 8192, some cloud VMs less).
- **Across all sessions**, total watches = N active sessions × D
  directories average:
  - 10 sessions × 300 dirs = 3,000 (safe under default 8192).
  - 20 sessions × 500 dirs = 10,000 (exceeds default).
  - 16 sessions × 2,000 dirs (large monorepos) = 32,000 (4× over).
- Operators on busy servers or large repos should raise
  `fs.inotify.max_user_watches`. If a user hits the limit, chokidar's
  `error` event fires (`ENOSPC`) and that session drops to
  timer-only mode. Documented in the troubleshooting section of
  `docs/file-edits.md`.
- Memory: chokidar holds a Map of watched paths. ~100 bytes per
  directory. ~50KB per session — negligible.

### Failure modes

1. **chokidar throws on construction.** Catch, log, return false
   from `attach`.
2. **inotify watch cap reached.** chokidar emits `error` events with
   `ENOSPC`. Drop the watcher, log a user-visible warning explaining
   how to raise `fs.inotify.max_user_watches`.
3. **Repo on a network mount that doesn't fire inotify events** (NFS,
   some FUSE mounts). On Linux, `fs.watch`/inotify *attaches without
   error* on NFS — chokidar's `error` event never fires,
   `isWatching` returns true, and the 30s backstop activates. The
   user gets 30s polling latency silently — a regression from V3.2's
   1.5–5s. V3.3 doesn't auto-detect. **Operator opt-out via
   `CACO_FILE_EDITS_WATCH=off` env var lands in V4.** Until then, NFS
   users should set this manually (see Config below).
4. **Repo is huge enough that chokidar's startup walk is slow.** Use
   `ignored` aggressively (gitignore + EXCLUDED_DIRS) to skip
   `node_modules` and friends. Add a startup time log: warn if
   chokidar takes >2s to be `ready`.
5. **`.gitignore` updated mid-run.** chokidar doesn't auto-reload
   the ignore pattern. Watcher's ignore list stays stale until
   server restart. Events fire for newly-ignored paths; polls are
   no-ops if `git status` doesn't change, so harmless but wasteful.
   V4 could watch `.gitignore` itself.

### Config

V3.3 adds **one** env var:

- `CACO_FILE_EDITS_WATCH` — set to `off` to force timer-only mode.
  Default `on`. Use case: NFS / network mounts where chokidar
  attaches but doesn't fire events. Read once at process start.

Defaults:
- chokidar on (`CACO_FILE_EDITS_WATCH` unset or anything other than `off`).
- Backstop cadence 30s when chokidar attached, 5s otherwise.

This addresses the BLOCKER 3 testability concern: a process started
with `CACO_FILE_EDITS_WATCH=off` exercises the fallback path
end-to-end.

---

## Edge cases

- **Multiple sessions on the same cwd.** Each gets its own watcher.
  Two redundant inotify subscriptions; not great but cheap and
  correct. Future V4 refcount.
- **Session's cwd changes mid-life.** Doesn't happen in Caco;
  `cwd` is immutable per session. No special handling.
- **Git operations** (`git checkout`, rebase) touch hundreds of files
  fast. chokidar fires many events; `awaitWriteFinish` collapses
  per-file but cross-file events still fire. Debounced by
  `triggerPoll`'s 50ms.
- **`.gitignore` change.** chokidar doesn't auto-reload the ignore
  pattern. Operator must restart the server to pick up new
  gitignored paths. V4 could watch `.gitignore` for changes.
- **Symlinks pointing outside the repo.** chokidar follows by
  default. `followSymlinks: false` to keep the watch scoped — V3.3
  goes with `false` for safety.
- **Session detach during a chokidar event handler.** The handler
  calls `triggerPoll(sessionId, 'fs-event')`. If the session is gone,
  `triggerPoll` no-ops (existing guard). No leak.

---

## Acceptance

1. With the applet open on a git repo and chokidar attached,
   `echo x > file.txt` from the shell → tab updates within 300ms.
2. Save a file in VSCode while the applet is open → tab updates
   within 300ms.
3. **Vim save** (`:w` with default `backupcopy`) of an open file →
   tab updates within 300ms; only ONE poll triggers (the `atomic`
   option coalesces the unlink+add).
4. With chokidar attached, the backstop timer fires every 30s
   (verify via `[FILE-EDITS]` log: ~1 poll per 30s when no edits
   happen, not 1 per 5s).
5. Start server with `CACO_FILE_EDITS_WATCH=off` → chokidar never
   attaches; polls fire every 5s. (Replaces V3.2's 1.5s/5s — see
   Polling cadence section for the rationale.)
6. Forcibly fail chokidar in-process (e.g. mock `attach` to return
   false) → same as test 5: 5s timer cadence; polls fire.
7. `git checkout other-branch` (50+ file change) → applet catches up
   in <500ms (one poll covers all the new edits).
8. `.gitignore`-listed file changes → no event fires; no spurious
   poll.

## Risks

- **NFS / network mount silent regression.** chokidar attaches
  without error but never fires events; the 30s backstop activates.
  Users get 30s latency instead of V3.2's 1.5–5s. Workaround:
  `CACO_FILE_EDITS_WATCH=off`. Auto-detection deferred to V4.
- **inotify cap hits on multi-session users.** Worst case: 16
  sessions × 2,000 dirs = 32k watches; default cap is 8,192. Users on
  large monorepos may need to raise `fs.inotify.max_user_watches`.
  Document, don't auto-fix.
- **chokidar dependency footprint.** chokidar v5 has one transitive
  dep (vs v3's 13). Adds ~50KB to node_modules. Acceptable.
- **Coalescing across files.** A `git checkout` of 100 files fires
  100 events; `awaitWriteFinish` coalesces per-file not cross-file.
  The 50ms debounce in `triggerPoll` catches most of the burst, but
  a slow git op (>50ms between writes) could spawn multiple polls.
  Tolerable — polls are cheap and the no-op poll guard client-side
  dedups any rebroadcasts.
- **Watch storms.** A tight write loop on a file could fire >1000
  events/sec. `awaitWriteFinish` + 50ms `triggerPoll` debounce caps
  poll rate at ~20/sec. The poll itself is single-flight (existing
  `state.polling` guard) so we can't pile up.

## Open questions

1. ~~`awaitWriteFinish` 100ms vs 50ms?~~ **Resolved: 100ms**, paired
   with `atomic: true` to cover the rename-over save pattern that
   `awaitWriteFinish` alone misses.
2. ~~Follow symlinks?~~ **Resolved: false** (overrides chokidar's
   default of true).
3. ~~Backstop cadence 30s, 60s, or disabled when watching?~~
   **Resolved: 30s** (catches truly-missed events without much cost).
4. ~~Logging verbosity?~~ **Resolved: log first attach + detach +
   each `error` event. Do NOT log per-fs-event.**
5. **`FileWatcher` keyed on `sessionId` — V4 sharing path
   pre-considered?** V4 plans repoRoot-keyed refcount sharing across
   sessions. The V3.3 interface (sessionId-keyed) would change
   significantly. **Recommendation: mark the FileWatcher interface as
   internal to the poller (not exported from a public module path)
   so V4 can refactor freely.** No breaking change concern.

## Document layout

- `docs/file-edits.md` — V1 + V3 backlog; update to note chokidar
  ships in V3.3.
- `docs/file-edits-v3.3.md` — this doc.
- `docs/file-edits-v3.3-review.md` — review log.
