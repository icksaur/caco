# File Edits V2.1 — Persistence and clean-file full view

Builds on V2 (Phases 1–3, all shipped on `file-edits-v2`). Spec:
`docs/file-edits-v2.md` and `docs/file-edits.md`. This is a small
incremental release.

## Goal

The applet should feel like a stable place where reviewed files
accumulate, like a tab strip in an editor. Three changes drive that:

1. **Clean files keep their full content visible** — today, when a
   file goes from dirty → clean (committed, reverted, etc.) the body
   collapses to an empty pane and only the muted `✓` pill remains.
   This loses context the user was reading.
2. **Cards never disappear during a session** — already true within
   one applet open, but lost on applet reopen or session switch.
3. **Persist the card list across applet restarts and session
   reloads** — store `{ relativePath, collapsed }` per session in a
   JSON file under the session's storage directory.

## Scope (locked)

This is a single increment. No phases.

- Server: 1 new endpoint pair (read/write the per-session
  `file-edits-cards.json`). Reuse `session-data-store`.
- Client: render full file content for clean files; persist card list;
  restore card list on applet open / session switch.

## Non-Goals (V2.1)

- Cross-session persistence (each session keeps its own list).
- Card ordering by anything other than first-touched-first.
- Manual "remove all cards" UI — that's what X already does.
- Pinning, starring, or filtering — V3 backlog.

---

## Behavior changes

### 1. Clean files render full content

Today, `markClean(path)` synthesizes a faux edit with `diff: ''` and
no `fullFile`, so the body renders the "(no diff)" empty state.

New behavior: when a file goes clean, the server still computes its
`fullFile` payload but with **zero hunks**. The client renders this
as the full file with **every row a `ctx` row** (no add/del backgrounds,
muted gutter as today).

Implementation requirements:

- Server `git-edit-poller.ts`:
  - Type updates (required to type-check):
    - Extend `FileStatus` to add `'clean'`:
      `'modified' | 'untracked' | 'deleted' | 'renamed' | 'clean'`.
    - Make `EditEntry.diff` optional: `diff?: string`. Existing call
      sites that produce a `diff` string are unaffected; clean entries
      omit it.
  - The `cleared` event payload currently sends an array of relative
    paths only. Extend the `caco.edit` event with a parallel
    `cleanedEdits: EditEntry[]` array where each entry has
    `status: 'clean'`, no `diff`, a fresh `fullFile` (HEAD blob =
    working tree = current file content; hunks = `[]`), and
    `timestamp` = now.
  - For files that are no longer tracked at all (e.g. user rolled back
    a freshly-untracked file), `fullFile` is omitted and the card
    falls back to a "no diff" body.
  - `cleanedEdits` is **additive to** `cleared`, not a replacement.
    Old clients keep using `cleared`. New clients should prefer
    `cleanedEdits` when present and silently skip any `cleared` path
    that also appears in `cleanedEdits` (avoids the idempotency-guard
    double-call).
  - No in-memory "recently-cleaned" set on the server. Snapshot uses
    the per-session card list (see §3) as the source of truth for which
    clean files to include.

- Snapshot endpoint extension (the BLOCKER fix):
  - On `GET .../file-edits/snapshot`, the server reads the persisted
    card list via `getCardList(sessionId)`, finds paths that are NOT
    in the current dirty set, and for each builds a clean `EditEntry`
    by running `git show HEAD:<path>` (the existing `readHeadBlob`
    helper) and synthesizing `fullFile = { headLines, workLines:
    headLines, hunks: [] }` (working tree equals HEAD for a clean file
    — no need for a second `readFile`).
  - Bound: limit this batch to the existing 50-card cap minus the
    current dirty count. If the persisted list is larger than the
    available slots, prefer the most-recently-touched persisted entries
    (the list is stored in insertion order — newest at end — so take
    the tail).
  - Concurrency: reuse `mapWithConcurrency(..., DIFF_CONCURRENCY)`.
    Each persisted-clean lookup is one `git show` subprocess; the
    existing concurrency bound is still `DIFF_CONCURRENCY=4` so the
    in-flight subprocess count stays at 4 total during snapshot.
  - Missing-blob handling: if `git show HEAD:<path>` returns non-zero
    (path no longer in HEAD — was deleted after commit), omit
    `fullFile` and the card falls back to "(no diff)".

- Client `script.js`:
  - `markClean(path)` receives the new `EditEntry` shape with
    `fullFile`. `renderBody` renders it through the existing
    `renderFullFile` path. `buildRows` already produces an
    all-`ctx` row list when `hunks = []`.
  - In `renderFullFile`, before calling `collapseFolds`, guard:
    ```js
    var rows = rawRows.every(function(r) { return r.kind === 'ctx'; })
      ? rawRows
      : collapseFolds(rawRows);
    ```
    This skips fold collapse for any all-context row list (clean files
    or any unchanged file). Does not change behavior for files with
    add/del rows.
  - The card's `data-status` becomes `clean`; existing CSS already
    dims the `.fe-path` for clean cards. No further visual change.

### 2. Cards never disappear during a session

Already true within a single applet open: the V1 polish patch
removed reorder/removal-on-clean. This spec extends "never disappear"
to **across applet open/close** and **across session switch**.

Mechanism: the card list is restored from session storage (see §3).

### Cap eviction (normative)

When the total card count (dirty + clean + persisted-phantom) exceeds
50, evict in this order until under the cap:

1. **Oldest clean cards first** (status === 'clean', evict by insertion
   order). A clean card is "the user already reviewed this; it's just
   parked here."
2. **Oldest dirty cards next**, only if step 1 alone can't get under the
   cap. Should be rare in practice; if 51+ files are dirty at once we
   accept some loss at the top.

Cap eviction removes from both DOM and persistence atomically (the
PUT debouncer fires for the eviction same as any other mutation).

Edge cases:

- **Dismiss (X):** removes the card from the list AND persists.
  Dismissal is a permanent user gesture per session (see also
  §3 "dismissed persistence" below).
- **Session change:** cards from the previous session are dropped
  from the DOM but their persistence file is left intact under the
  old session ID. Opening the applet again on that session restores
  them. Sessions are isolated.

### 3. Session-scoped persistence

Storage location: per-session JSON file via the existing
`session-data-store` API, name `file-edits-cards`.

File shape (on-disk):

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-06-01T19:40:00Z",
  "cards": [
    { "relativePath": "src/foo.ts", "collapsed": false },
    { "relativePath": "src/bar.ts", "collapsed": true }
  ],
  "dismissed": ["src/old.ts"]
}
```

Persisted fields:

- `cards[].relativePath` — the only identity. No path = no card.
- `cards[].collapsed` — explicit user-collapse state. Defaults to
  `false` (expanded) for any card not in the file.
- `dismissed[]` — paths the user has explicitly X-dismissed. The
  applet honors this list on restore: any dirty edit or snapshot entry
  whose path is in `dismissed` does NOT spawn a card. Reset Dismissals
  button (existing) clears the array and triggers a PUT.

Persisting `dismissed` honors the "X is permanent" intent across
applet reopens and session reloads. (Resolves the contradiction from
the original spec.)

Not persisted (computed at runtime from git):

- Status, diff, fullFile, timestamp, isBinary, truncated.

Server work:

- New file `src/file-edits-store.ts`:
  - `getCardList(sessionId): { schemaVersion, updatedAt, cards, dismissed }`
    — returns `{ schemaVersion: 1, updatedAt: null, cards: [], dismissed: [] }`
    if file missing.
  - `setCardList(sessionId, body): void` — body is
    `{ schemaVersion, cards, dismissed }`; server sets `updatedAt` to
    `new Date().toISOString()` on every write. Validates `schemaVersion === 1`
    and rejects other values (the route returns 400 for unknown versions
    on PUT; GET still returns the file as-is even if unknown for
    forward-compat reads, with the caller deciding what to do).
  - **Per-session-ID debounce**, 500ms: `Map<sessionId, NodeJS.Timeout>`.
    Calling `setCardList(sid, body)` cancels any pending timer for `sid`,
    schedules a new one. Crucially, **`flushAll()` writes any pending
    timers immediately** — called on process SIGINT and on session
    detach so we don't lose the last gesture on shutdown.

- New routes in `src/routes/file-edits.ts`:
  - `GET /api/sessions/:id/file-edits/cards` → returns the list.
    Response shape: `{ schemaVersion, updatedAt, cards, dismissed }`.
  - `PUT /api/sessions/:id/file-edits/cards` → writes the list.
    Request body: `{ schemaVersion: 1, cards, dismissed }` (no
    `updatedAt` — server-set). Validates:
    - `schemaVersion === 1` (else 400)
    - `cards` is `Array<{ relativePath: string, collapsed: boolean }>` (else 400)
    - `dismissed` is `string[]` (else 400)
  - 404 if session unknown.

- **Snapshot endpoint** (existing `GET /api/sessions/:id/file-edits/snapshot`)
  is extended to also fetch HEAD blobs for any persisted-clean paths
  not in the current dirty set. See §1 "Snapshot endpoint extension"
  for the full mechanism. This is the BLOCKER fix that makes
  cross-server-restart phantom cards work.

- The poller is **not** the writer. The client owns the persisted
  list; the poller only reads it indirectly through the snapshot
  handler.

Client work:

- On applet open / session change:
  1. `GET .../cards` → returns persisted `cards[]` + `dismissed[]`.
  2. `GET .../snapshot` → returns current dirty + persisted-clean edits
     (snapshot handler now joins the card list — see §1).
  3. Build cards in the persisted order. For each persisted path
     not in `dismissed`:
     - If the snapshot has an edit for it (dirty OR clean-with-fullFile),
       render that. The body fills in immediately — no phantom phase.
     - If the snapshot has NO entry for it (rare: the snapshot's
       HEAD-blob lookup failed), render a header-only card with
       `✓` pill and empty body.
  4. Append any snapshot edits whose path isn't in the persisted
     list AND isn't in `dismissed` (new files the agent touched
     while the applet was closed).
  5. Honor the persisted `collapsed` flag per card.

- On any mutation (X dismiss, chevron toggle, cap eviction):
  - Update in-memory state.
  - Schedule a debounced PUT (250ms client-side; server also
    debounces 500ms per-session-ID).

- On session change:
  - **Flush the PUT debouncer immediately** for the outgoing session:
    fire any pending PUT synchronously (or `await` it) BEFORE
    clearing in-memory state. Without this, an X dismiss within
    250ms of a session switch is lost. Implementation: track the
    current sessionId alongside the pending body; the flush function
    cancels the timer and calls PUT directly with the captured pair.
  - Then: clear in-memory state, run GET cards + GET snapshot for
    the new session.

- On `beforeunload`:
  - Best-effort flush via `navigator.sendBeacon('.../cards', body)`.
    Honors "X is permanent" across browser-close-within-250ms.

Concurrency note: if two applet instances on the same session have
the file-edits applet open, the last writer wins. Acceptable for V2.1;
both instances will converge on the next poll broadcast which both
receive.

---

## Migration / compatibility

- Sessions without the JSON file: behave as before — start empty,
  build up as edits arrive.
- The new `cleanedEdits` event field is **additive**. Old clients
  ignore it; new clients ignore the absence (the existing `cleared:
  string[]` field still wins for path lifecycle).

---

## UI changes (minimal)

- Clean cards now display the file body with all-ctx rows. No new
  controls.
- No new buttons, no toolbar changes.
- The header counter (`N files`) already counts cards including
  clean ones — no change.

---

## Acceptance

1. With the applet open, edit `src/foo.ts`, `git add . && git commit`,
   then look at the card: the body shows the full file (post-commit
   state), all lines muted, gutters aligned. Card stays put.
2. Close the applet, reopen on the same session: the foo.ts card is
   still there in the same position with the same collapsed state.
3. Switch session, switch back: the card is still there.
4. X-dismiss a clean card: gone now and gone on reopen.
5. Toggle a card collapsed, reload: card comes back collapsed.
6. 51st file changes: oldest card evicted from DOM and from the
   persisted list.

## Risks

- **Server load**: GET cards + GET snapshot on every applet open
  doubles the cold-start subprocess count. Mitigation: the cards
  endpoint reads a single JSON file — negligible cost.
- **Persistence drift**: client and server disagree on the card
  list if a PUT failed silently. Mitigation: server logs PUT
  failures; client treats failed PUT as in-memory-only and retries
  on next mutation.
- **Phantom card UX**: a card with no body might look broken.
  Mitigation: the header still shows path + `✓` pill + timestamp;
  the body says "(committed — full content below)" until the
  snapshot fills it. *Open question: keep "(committed)" or hide
  body entirely for phantoms?* Recommend: empty body, no message;
  snapshot/event resolution is sub-second.

## Preserved V2 invariants

V2.1 must not regress any V2 behavior. Specifically:

- **Cards are never reordered.** New cards always `appendChild` to the
  stream. Restored persisted cards preserve their persisted order.
- **Fold threshold = 20** consecutive ctx rows. V2.1 adds: skip folds
  entirely when all rows are ctx (clean files).
- **Sticky/Autoscroll state machine** is unchanged. Restored cards do
  not trigger autoscroll on applet open; the state starts as
  `'autoscroll'` per V2.
- **No-op poll check** (`fullFileEqual`) still gates re-renders.
  Clean-card `fullFile` payloads with `hunks: []` pass through it the
  same as any other.
- **The 50-card cap** is enforced; V2.1 specifies the new eviction
  priority order (clean first, then dirty).

---

## Migration / compatibility

- Sessions without the JSON file: behave as before — start empty,
  build up as edits arrive.
- The new `cleanedEdits` event field is **additive**. Old clients
  ignore it; new clients ignore the absence (the existing `cleared:
  string[]` field still wins for path lifecycle).
- The new `dismissed` field in the persistence file is additive.
  Servers that read a file with `dismissed` missing treat it as `[]`.

---

## UI changes (minimal)

- Clean cards now display the file body with all-ctx rows. No new
  controls.
- No new buttons, no toolbar changes.
- The header counter (`N files`) already counts cards including
  clean ones — no change.

---

## Acceptance

1. With the applet open, edit `src/foo.ts`, `git add . && git commit`,
   then look at the card: the body shows the full file (post-commit
   state), all lines muted, gutters aligned. Card stays put.
2. Close the applet, reopen on the same session: the foo.ts card is
   still there in the same position with the same collapsed state and
   the same full-file body visible.
3. **Restart the server**, reopen the applet on the same session:
   foo.ts is still there with body filled. (BLOCKER fix verification.)
4. Switch session, switch back: the card is still there.
5. X-dismiss a clean card, reload page (not server restart): card
   stays dismissed.
6. X-dismiss a clean card, restart server, reopen: card stays
   dismissed.
7. Toggle a card collapsed, reload: card comes back collapsed.
8. 51st file changes while a clean card is at the top: clean card
   evicted, all 50 dirty kept.
9. X-dismiss a card and immediately switch session within 250ms:
   on returning to original session, dismiss persists. (Session-switch
   flush verification.)

## Risks

- **Server load**: every snapshot now also runs `git show HEAD:<path>`
  for each persisted-clean card not in the dirty set. Bounded by the
  50-card cap and `DIFF_CONCURRENCY=4`. Worst case (50 persisted, 0
  dirty) is 50 `git show` subprocesses at concurrency 4 = ~12 batches.
  Still <1s on typical repos. Snapshot endpoint is hit only on applet
  open, not on every poll tick.
- **Persistence drift**: client and server disagree on the card list
  if a PUT failed silently. Mitigation: server logs PUT failures;
  client treats failed PUT as in-memory-only and retries on next
  mutation. The `beforeunload` sendBeacon is best-effort.
- **Stale persisted paths**: a path persisted from a prior session
  may have been deleted from HEAD by another tool. The snapshot
  handler's missing-HEAD-blob path renders an empty-body card with
  the `✓` pill; the user can X-dismiss to clean up. Not perfect;
  acceptable for V2.1.

## Open questions

1. Should the persisted `collapsed` flag default to `true` for
   files the agent touched while the applet was closed? Currently
   the client appends them as expanded. Recommend: **expanded** —
   matches V1's "freshly touched is interesting" model.

(Open Question 2 about dismissed persistence: **resolved** —
persisted, see §3. Open Question 3 about cap eviction: **resolved**
— normative order in §"Cap eviction" above.)

## Document layout

- `docs/file-edits.md` — V1 + V3 backlog (unchanged).
- `docs/file-edits-v2.md` — V2 spec (unchanged).
- `docs/file-edits-v2.1.md` — this doc.
- `docs/file-edits-v2.1-review.md` — review log.
