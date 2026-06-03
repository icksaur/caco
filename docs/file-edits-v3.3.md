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

- Use `chokidar` (npm dep). Constructor options:
  - `persistent: false` — doesn't keep the event loop alive on its own.
  - `ignoreInitial: true` — don't emit events for files that already
    exist on watcher start.
  - `awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }`
    — collapse multi-write saves into one event.
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

`attachToSession(sessionId, cwd)`:
1. Existing: resolve repoRoot, set up `SessionPollerState`.
2. New: call `fileWatcher.attach(sessionId, repoRoot, () =>
   triggerPoll(sessionId, 'fs-event'))`.
3. If `attach` returns false, log and continue with timer-only mode.

`detachFromSession(sessionId)`:
1. Existing: clear timers, drop state.
2. New: call `fileWatcher.detach(sessionId)`.

`triggerPoll` gains a new source `'fs-event'`. Same debounce path as
'event' (50ms). The poll path is unchanged.

`scheduleTimer` drops the active cadence (1.5s) and always uses the
idle cadence (5s) as a backstop. The cadence is also gated by
"are we watching": if `fileWatcher.isWatching(sessionId)` is true,
the backstop is 30s instead of 5s — we trust chokidar to catch
realistic edits, and the 30s tick exists only to catch fs-watch
gaps (rare).

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

- inotify watch slots per repo: chokidar uses one per directory.
  Caco's typical repos have ~100–2000 directories; well under the
  user's 8192 default. We don't artificially cap.
- Watchers per server: bounded by active sessions × 1 watcher each.
  Worst-case 51 sessions × ~500 dirs = ~25k watch slots. If a user
  hits inotify limits, chokidar's `error` event fires and we drop to
  timer mode for that session. Document this in the troubleshooting
  section of `docs/file-edits.md`.
- Memory: chokidar holds a Map of watched paths. ~100 bytes per
  directory. ~50KB per session — negligible.

### Failure modes

1. **chokidar throws on construction** (missing optional dep
   `fsevents` on Mac is fine; chokidar uses inotify fallback). Catch,
   log, return false from `attach`.
2. **inotify watch cap reached.** chokidar emits `error` events with
   `ENOSPC`. Drop the watcher, log a user-visible warning explaining
   how to raise `fs.inotify.max_user_watches` (link to Linux docs).
3. **Repo on a network mount that doesn't fire inotify events** (NFS,
   some FUSE mounts). chokidar's `usePolling: true` fallback works
   but defeats the purpose. V3.3 doesn't auto-detect — operator can
   manually disable via config (V4 work).
4. **Repo is huge enough that chokidar's startup walk is slow.** Use
   `ignored` aggressively (gitignore + EXCLUDED_DIRS) to skip
   `node_modules` and friends. Add a startup time log: warn if
   chokidar takes >2s to be `ready`.

### Config

No new config in V3.3. Defaults are:
- chokidar on by default.
- Idle cadence 30s when chokidar attached, 5s otherwise.

A future config could add `CACO_FILE_EDITS_WATCH=off` to force timer
mode (for the network-mount case) — deferred to V4.

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
3. With chokidar attached, the idle timer fires every 30s (verify
   via `[FILE-EDITS]` log spam: should see ~1 poll per 30s when
   no edits happen, not 1 per 5s).
4. Forcibly fail chokidar (e.g. mock `attach` to return false) →
   applet falls back to timer-only at 5s cadence. Polls still fire.
5. `git checkout other-branch` (50+ file change) → applet catches up
   in <500ms (one poll covers all the new edits).
6. `.gitignore`-listed file changes → no event fires; no spurious
   poll.
7. Server starts with chokidar disabled → behavior is exactly V3.2
   (5s idle, 1.5s active). No regression.

## Risks

- **inotify cap hits on multi-session users.** Worst case: 16
  sessions × 2000 dirs = 32k watches; default cap is 8192. Users on
  large monorepos may need to raise `fs.inotify.max_user_watches`.
  Document, don't auto-fix.
- **chokidar dependency footprint.** chokidar v3 + optional
  `fsevents` on Mac. Adds ~250KB to node_modules. Acceptable for
  the gain.
- **Coalescing across files.** A `git checkout` of 100 files fires
  100 events; `awaitWriteFinish` coalesces per-file not cross-file.
  The 50ms debounce in `triggerPoll` catches most of the burst, but
  a slow git op (>50ms between file writes) could spawn multiple
  polls. Tolerable — the polls are cheap and the no-op poll guard
  client-side dedups any rebroadcasts.
- **Watch storms.** A tight write loop on a file could fire >1000
  events/sec. `awaitWriteFinish` + 50ms `triggerPoll` debounce caps
  poll rate at ~20/sec. The poll itself is single-flight (existing
  `state.polling` guard) so we can't pile up.

## Open questions

1. **Should `awaitWriteFinish.stabilityThreshold` be 100ms or
   shorter?** 100ms is chokidar's standard recommendation for save
   coalescing. Shorter (50ms) lowers per-save latency but may emit
   duplicate events for editors that do an atomic
   write-then-rename. **Recommend 100ms.**
2. **Should the watcher follow symlinks?** Spec says no for safety.
   Operators who develop in a symlinked checkout would lose
   responsiveness. **Recommend false** until a use case argues
   otherwise.
3. **Should the idle cadence be 30s, 60s, or disabled when chokidar
   is attached?** 30s catches truly-missed events without much cost.
   Disabled has appeal but loses the safety net for filesystems
   where chokidar misses. **Recommend 30s** as a conservative
   backstop.
4. **Logging verbosity.** Each fs event currently does NOT log
   (avoid console spam). The first attach + each detach + each
   chokidar `error` should log. Sound right? **Yes, recommend that.**

## Document layout

- `docs/file-edits.md` — V1 + V3 backlog; update to note chokidar
  ships in V3.3.
- `docs/file-edits-v3.3.md` — this doc.
- `docs/file-edits-v3.3-review.md` — review log.
