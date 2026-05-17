# File-watch leases

A leased subscription mechanism so applets can react to file-system changes without polling, leaking watchers, or holding the inotify budget hostage.

Audience: applet authors (`markdown-viewer`, `html-viewer`, `image-viewer`, `git-status`, `session-surface` customScript). Also a reference for future applets.

## Goal

Allow an applet to say "tell me when this file or directory changes" and:

- Get notified in near-real-time via the existing WebSocket event stream.
- Not depend on polling.
- Automatically release the watcher if the applet's tab is closed, the session ends, or the applet simply forgets to clean up.
- Share watcher cost when multiple applets watch the same path.
- Bound the cost: a buggy applet cannot consume the entire inotify budget.

Concrete first-user motivations:

- **markdown-viewer**: refresh rendered markdown when the source `.md` is edited.
- **html-viewer**: refresh when its target HTML changes (live-preview small dev artifacts).
- **image-viewer**: refresh when the displayed image is overwritten on disk.
- **git-status**: refresh when the working tree changes (today this polls).
- **session-surface customScript**: a user-authored surface that watches a directory of diagnostic images produced by a graphics build, reloading thumbnails as the build re-emits them.

## Non-goals

- Recursive directory watching. V1 supports `file` scope and `dir` (immediate-children) scope only. The Linux `fs.watch` recursive option is non-functional; supporting it portably means a per-subdir walker or chokidar, both deferred. If you need recursive, take multiple leases.
- File-content streaming. The watch event carries the path and a coarse event type; the applet fetches contents itself via the existing `callFileApi('read_file', ...)` or `fetch('/api/shell', ...)` helpers.
- Watching paths the user lacks read permission on (returns `watch-failed`).
- Watching network filesystems. `fs.watch` does not fire for NFS, SMB, virtio-fs, or most overlay mounts. Documented limitation.

## Lease model

A lease is a server-managed subscription identified by an opaque `leaseId`. Leases:

- Are **session-owned**: each lease belongs to one Caco chat session (the same unit `sessionState.deleteSession` operates on, not an SDK or HTTP session). When the chat session ends, all its leases are released.
- Have a **TTL** (default 5 minutes). The lease expires unless renewed.
- Are **renewable** with `POST /watch/:leaseId/renew`.
- Are **refcounted by path**: the server keeps **one** underlying `fs.watch` per unique path; multiple leases for the same path share it.
- Are **process-bounded**: max 16 leases across the entire Caco process. Today only one applet is active per chat session, so the practical concurrent demand is the number of open browser tabs times their respective active applets. 16 is generous for that.

The TTL exists to clean up after applets that forget to release. Renewal is mandatory for long-lived watches; the recommended cadence is every 60s.

## HTTP API

All routes session-scoped under `/api/sessions/:sessionId/`.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/watch` | Acquire a lease on a path. |
| `POST` | `/watch/:leaseId/renew` | Reset the TTL. |
| `DELETE` | `/watch/:leaseId` | Release the lease. |
| `GET` | `/watch` | List the session's active leases (debug). |

### `POST /watch`

Body:

```json
{
  "path": "/home/user/proj/notes.md",
  "scope": "file"
}
```

`scope` is `"file"` or `"dir"`. Defaults to `"file"` if the path is a regular file at request time, `"dir"` if it's a directory.

Success response:

```json
{
  "ok": true,
  "leaseId": "lease-7f2a91",
  "ttlMs": 300000,
  "path": "/home/user/proj/notes.md",
  "scope": "file"
}
```

Failure responses (HTTP 200 with `ok: false` for protocol-level errors, matching the surface API convention):

```json
{ "ok": false, "reason": "path-not-found" }
{ "ok": false, "reason": "lease-cap" }
{ "ok": false, "reason": "watch-failed", "error": "EACCES: permission denied" }
```

HTTP 4xx is reserved for malformed requests (missing `path`, etc.).

### `POST /watch/:leaseId/renew`

No body. Response: `{ "ok": true, "ttlMs": 300000 }` or `{ "ok": false, "reason": "unknown-lease" }`.

### `DELETE /watch/:leaseId`

No body. Response: `{ "ok": true }`. Idempotent — releasing an unknown lease is a no-op success.

### `GET /watch`

Response:

```json
{
  "leases": [
    { "leaseId": "lease-7f2a91", "path": "/home/user/proj/notes.md", "scope": "file", "expiresAt": "2026-05-17T06:23:00Z" }
  ]
}
```

## WebSocket event

When a watched path changes, the server broadcasts via `broadcastEvent(sessionId, ...)`:

```json
{
  "type": "caco.fs.changed",
  "data": {
    "leaseId": "lease-7f2a91",
    "path": "/home/user/proj/notes.md",
    "eventType": "change"
  }
}
```

`eventType` is one of:

- `"change"` — file contents changed (per Node's `fs.watch`; on Linux this is the `change` event, on macOS it's a coalesced FSEvent).
- `"rename"` — a child entry was created, renamed, or deleted. On Linux `fs.watch` reports this for both create and delete; the applet must `stat` to disambiguate if it cares.

For `scope: "dir"` leases, `path` is the directory; `data.filename` (when available from the OS) names the affected entry. Linux always provides it; macOS often does not.

### Broadcast scope

`broadcastEvent` (in `src/routes/websocket.ts`) is **already session-scoped** server-side — it sends only to WebSocket connections subscribed to that session. Clients filter the inbound stream by `leaseId` to dispatch to the correct handler when one client holds multiple leases. Cross-session leakage is impossible.

The event filter (`src/event-filter.ts`) passes all `caco.*` events through unconditionally. The applet runtime's generic `appletAPI.onSessionEvent(cb)` therefore also receives `caco.fs.changed`. To prevent every applet from seeing every other applet's watch events, the `watchPath` implementation consumes `caco.fs.changed` events **before** they reach the `onSessionEvent` dispatcher — the WatchHandle subscribes via an internal, lower-level event hook that intercepts and short-circuits these events when `leaseId` matches a known lease. The implementation note: `watchPath` registers with a dedicated `caco.fs.changed` channel inside `applet-runtime.ts`, not through the public `onSessionEvent` API.

### Coalescing

Multiple OS-level events within a 150ms window for the same `leaseId` collapse into one broadcast. Editor saves typically fire 2-3 events; the user sees one render.

## Path safety

Caco runs as the user and operates on the user's behalf. The watch API does not whitelist paths — file permissions and the user's existing privilege boundary do the work. If the user can `cat` a file, they can watch it; if they can't, `fs.watch` returns `EACCES` and the acquire fails with `watch-failed`.

`fs.realpathSync.native(path)` is still called at acquire time to canonicalize the path (so the path refcount map keys agree across symlinks), but the result is not checked against any allowlist.

Failure modes still apply:

- Path doesn't exist → `path-not-found`.
- Path exists but the user lacks read permission → `watch-failed` with the `EACCES` reason.
- Network filesystem where `fs.watch` is silent → the lease acquires but no events fire. Documented limitation; consumer should expect this if watching mounted shares.

Note for future hardening: if Caco ever runs as a remote-accessible service (cloud-agent mode, the Portal exposing watch endpoints across machines), the trust model changes and an allowlist would need to be reintroduced. That is out of scope here.

## Applet API

In `appletAPI`:

```ts
interface WatchHandle {
  /** Set or replace the change handler. */
  onChange(cb: (event: { path: string; eventType: 'change' | 'rename'; filename?: string }) => void): void;
  /** Release the lease and stop receiving events. Idempotent. */
  close(): Promise<void>;
}

interface WatchOptions {
  /** "file" or "dir". Defaults based on the path's current type. */
  scope?: 'file' | 'dir';
}

appletAPI.watchPath(path: string, options?: WatchOptions): Promise<WatchHandle>;
```

The handle:

- POSTs to acquire the lease on construction.
- Subscribes to `caco.fs.changed` events for the matching `leaseId` via the runtime's internal hook (see "Broadcast scope" above).
- Renews automatically every 60 seconds (well within the 5-minute TTL).
- On `window.beforeunload`, **does not** attempt a `sendBeacon` cleanup. `navigator.sendBeacon` only supports POST and the cost of adding a POST shim purely for tab-close cleanup is not worth it given the 5-minute TTL. The lease expires naturally; the underlying watcher is released within at most 5 minutes after tab close.
- Throws if the acquire fails. Caller catches as needed.

Multiple changes to the same path within the coalesce window are combined into one `onChange` invocation.

Example:

```js
const watcher = await appletAPI.watchPath('/home/user/proj/notes.md');
watcher.onChange(async ({ eventType }) => {
  if (eventType === 'change') {
    const { content } = await appletAPI.callFileApi('read_file', { path: notesPath });
    render(content);
  }
});
// later, on cleanup:
await watcher.close();
```

## Applet integration cases

### markdown-viewer

Today: loads markdown from `?path=<...>` once, then never re-checks.

After: on mount, acquire a `scope: "file"` lease on the path. On `change`, re-fetch via `callFileApi('read_file', { path })` and re-render. On unmount, `close()`.

### html-viewer

Same as markdown-viewer: file lease, re-fetch on change, force the sandboxed iframe to reload its `srcdoc` with the new content.

### image-viewer

`scope: "file"` lease. On change, append `?t=<Date.now()>` to the image element's `src` to bypass browser cache. No fetch needed; the `<img>` reload handles it.

### git-status

Today: re-runs `git status` on a polling interval (every few seconds) when the panel is visible.

After: take two leases — one `scope: "dir"` on the repo root, one `scope: "dir"` on `<root>/.git/refs/heads` (catches branch operations even when the working tree is clean). On any event, debounce 250ms then re-run `git status`. Significantly less wakeup churn for idle repos.

### session-surface customScript

The agent-authored `customScript` for a surface can call `appletAPI.watchPath` like any other applet. The user's graphics-programming use case:

```js
const watcher = await appletAPI.watchPath('/tmp/diag-frames', { scope: 'dir' });
watcher.onChange(async ({ filename }) => {
  if (!filename || !/\.png$/.test(filename)) return;
  await refreshTile(filename);  // calls /api/sessions/.../surface/mutate
});
```

The surface state stores the lease's `leaseId` only as an in-memory closure variable inside the script (no need to persist it). On reload the script's setup runs again and gets a fresh lease.

## Safety constraints

| Constraint | Value | Rationale |
| --- | --- | --- |
| Process-wide lease cap | 16 | Today only one applet is active per chat session; concurrent demand scales with open tabs, not sessions. Well below inotify defaults (8192). A runaway applet hits this fast. |
| Default TTL | 5 minutes | Tolerates a missed renewal heartbeat or two. |
| Renewal cadence (client) | 60 seconds | 5x safety margin against the TTL. |
| Coalesce window | 150ms | Empirically covers editor save bursts. |
| Network FS | not detected | `fs.watch` is silent on NFS/SMB but the lease acquires fine. Documented as a known no-event scenario; consumer should expect this if watching mounted shares. |

## Server architecture

New module `src/watch-store.ts`. Owns:

- `Map<leaseId, Lease>` — primary index.
- `Map<path, { watcher, leaseIds: Set<leaseId>, lastEventAt }>` — path refcount.
- Expiry timer wheel (a single `setInterval` scanning for expired leases every 30s is sufficient at our scale).
- Coalesce timers per path.

Public surface:

```ts
acquireLease(sessionId: string, path: string, scope: 'file' | 'dir'): Promise<AcquireResult>
renewLease(leaseId: string): RenewResult
releaseLease(leaseId: string): void
releaseSession(sessionId: string): void   // called on session end
listLeases(sessionId: string): LeaseSummary[]
```

Lease IDs are generated as `lease-` + `crypto.randomUUID()` for debuggability. Not security-critical (leases are session-scoped and only operable by the owning session) — the UUID is for log readability.

The module emits change events through `broadcastEvent(sessionId, { type: 'caco.fs.changed', data: ... })`. Refcounted close: when the last lease for a path is released, the `fs.watch` handle is closed.

New routes in `src/routes/watch.ts` (~80 lines): thin wrappers over the store, plus path validation.

Wired in `server.ts`:

```ts
app.use('/api', watchRoutes);
```

### Session lifecycle integration

`sessionState` does not currently expose an "on session end" hook. The spec defines one as part of this work:

```ts
// In session-state.ts:
type SessionEndListener = (sessionId: string) => void;
const sessionEndListeners = new Set<SessionEndListener>();

export function onSessionEnd(cb: SessionEndListener): () => void {
  sessionEndListeners.add(cb);
  return () => sessionEndListeners.delete(cb);
}

// Modify deleteSession() to fire the hook after a successful delete:
async deleteSession(sessionId: string, clientId?: string): Promise<boolean> {
  const ok = await /* existing delete logic */;
  if (ok) {
    for (const cb of sessionEndListeners) {
      try { cb(sessionId); } catch (e) { console.error('[SESSION-END] listener:', e); }
    }
  }
  return ok;
}
```

`watch-store.ts` registers a listener at module init that calls `releaseSession(sessionId)`. The hook is a one-way notification; listeners don't get a chance to veto deletion.

The listener is also called when a fork's parent is deleted (by current behavior of `deleteSession`). The lease store doesn't care: a session ending releases its leases regardless of why.

Frontend addition in `public/ts/applet-runtime.ts`: a `watchPath()` function that wraps the HTTP + WS protocol, plus the WatchHandle implementation. Added to `appletAPI`.

## Failure modes

| What goes wrong | What happens |
| --- | --- |
| Path doesn't exist | Acquire returns `path-not-found`. |
| `fs.watch` throws on a path that exists (e.g. EACCES) | Acquire returns `watch-failed` with error. Applet falls back to the no-watch behavior (whatever it did before). |
| Server restart | All leases lost. Applet's renew call gets `unknown-lease`; the helper transparently re-acquires. |
| Applet's tab closes without `close()` | TTL expires the lease within 5 minutes. `fs.watch` handle is released. |
| Network fs (NFS) where `fs.watch` is silent | Lease acquires fine but no events ever fire. Applet should fall back to a slow poll if the watch is critical. |
| Lease cap hit | Acquire returns `lease-cap`. Applet shows a warning; the user can close other panels to free leases. |
| OS-level inotify exhaustion | Acquire returns `watch-failed` with `ENOSPC`. Document the user-side fix: `sudo sysctl fs.inotify.max_user_watches=...`. |

## Edge cases worth documenting

- **Rename on Linux**: `fs.watch` reports `rename` for both creation and deletion of a directory child. Consumers that need to know which must `existsSync` after.
- **macOS coalescing**: FSEvents may collapse multiple file changes into a single event with no `filename`. Consumers must handle a `change` event with `filename === undefined` by re-listing the directory (for `scope: "dir"`) or simply re-loading the file (for `scope: "file"`).
- **Save-and-replace editors** (Vim with `backupcopy=auto`, some IDEs): writes a temp file and renames over the target. The watcher sees a `rename` event, not `change`. For `scope: "file"` leases the inotify watch is *attached to the inode*, so a rename-over closes our handle. The store handles this as follows:

  When a `rename` event fires on a `scope: "file"` lease:
  1. Wait 50ms (lets the editor finish the rename-then-write cycle).
  2. Call `existsSync(originalPath)`.
  3. If true: close the dead watcher, open a new `fs.watch` on the path, emit a single `change` event to the consumer (a rename-over is semantically a content change). Reset the coalesce window for this lease.
  4. If false: emit `rename` as-is so the consumer can handle the genuine deletion case. The lease remains active; subsequent acquires on the same path get the new watcher when (and if) the file reappears.

- **Concurrent acquire on the same path**: Node.js's single-threaded event loop makes the path refcount map's check-then-act sequence (look up path → if missing, `fs.watch` and insert) atomic in practice. The spec relies on this assumption — no explicit locking. This is the same assumption every other in-memory store in Caco makes.

- **Large directory** (10k+ entries): `fs.watch` itself doesn't enumerate; cost is per-directory not per-entry. Safe.

## Testing

- Unit tests for `watch-store.ts`:
  - Acquire, renew, release happy path.
  - TTL expiry releases the underlying watcher.
  - Path refcount: two leases on the same path share one `fs.watch`; releasing one keeps the watcher alive.
  - Session release drops all leases.
  - Process lease cap returns `lease-cap` on the 17th acquire.
  - `watch-failed` (EACCES) for a file the user can't read.
  - `path-not-found` for `/no/such/file`.
  - Coalesce window: rapid synthetic events produce one broadcast.
  - File-rename re-attach for `scope: "file"`.
- Route tests: malformed body, 404 on unknown lease, 200-with-`ok:false` on protocol failures.
- Manual: open markdown-viewer, edit the file in another editor, see the rendered output update without page reload.

## What this displaces

- `git-status`'s polling loop (replace once stable).
- The implicit "refresh on tab focus" patterns in `markdown-viewer` and `image-viewer` (keep them as a belt-and-suspenders fallback).

No removal in V1 — adding the API, no migration. Existing applets opt in one at a time.

## Future extensions (out of scope)

- Recursive watch (`scope: "tree"`).
- Pattern filters (`include: ['*.md']`).
- A debounce config per lease.
- Cross-session watch reuse (today two sessions watching the same path get two refcounted leases; could be one).
- An MCP tool the agent can call to subscribe — currently leases are applet-side only, which is the right scope.
