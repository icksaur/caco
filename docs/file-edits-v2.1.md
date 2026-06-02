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
  - The `cleared` event payload currently sends an array of relative
    paths only. Extend the `caco.edit` event with a parallel
    `cleanedEdits: EditEntry[]` array where each entry has status
    `'clean'`, no `diff`, a fresh `fullFile` (HEAD blob = working tree
    = current file content; hunks = `[]`), and `timestamp` = now.
  - For files that are no longer tracked at all (e.g. user
    rolled back a freshly-untracked file), `fullFile` is omitted
    and the card falls back to a "no diff" body.
  - Snapshot endpoint follows the same shape: snapshot returns the
    union of currently-dirty + recently-cleaned-this-session. The
    server keeps a small per-session "recently cleaned" set bounded
    by the existing 50-card cap.
  - Cap eviction priority: dirty cards take precedence over clean
    cards when the dirty set exceeds the cap. Cleaning a dirty card
    doesn't change its rank in the cap; X dismiss does.

- Client `script.js`:
  - `markClean(path)` receives the new `EditEntry` shape with
    `fullFile`. `renderBody` renders it through the existing
    `renderFullFile` path. `buildRows` already produces an
    all-`ctx` row list when `hunks = []`.
  - `collapseFolds` must NOT fold clean files: a clean file is
    entirely ctx, and folding it would defeat the whole purpose.
    Add a guard: skip fold collapse when **every** row is ctx
    (i.e. no add/del rows present).
  - The card's `data-status` becomes `clean`; existing CSS already
    dims the `.fe-path` for clean cards. No further visual change.

### 2. Cards never disappear during a session

Already true within a single applet open: the V1 polish patch
removed reorder/removal-on-clean. This spec extends "never disappear"
to **across applet open/close** and **across session switch**.

Mechanism: the card list is restored from session storage (see §3).

Edge cases:
- **Dismiss (X):** still removes the card from the list AND persists.
  Dismissal is a permanent user gesture per session.
- **Cap eviction:** still drops the oldest card. The cap is 50; the
  dropped card disappears from both DOM and persistence.
- **Session change:** cards from the previous session are dropped
  from the DOM but their persistence file is left intact under the
  old session ID. Opening the applet again on that session restores
  them. Sessions are isolated.

### 3. Session-scoped persistence

Storage location: per-session JSON file via the existing
`session-data-store` API, name `file-edits-cards`.

File shape:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-06-01T19:40:00Z",
  "cards": [
    { "relativePath": "src/foo.ts", "collapsed": false },
    { "relativePath": "src/bar.ts", "collapsed": true }
  ]
}
```

Persisted fields per card:

- `relativePath` — the only identity. No path = no card.
- `collapsed` — explicit user-collapse state. Defaults to `false`
  (expanded) on restore for any card not in the file.

Not persisted (computed at runtime from git):

- Status, diff, fullFile, timestamp, isBinary, truncated.
- Dismissed set (already V1 behavior — session-only).

Server work:

- New file `src/file-edits-store.ts`:
  - `getCardList(sessionId): { schemaVersion, cards: Array<{relativePath, collapsed}> }`
  - `setCardList(sessionId, list): void` — debounced 500ms inside
    the module (writes are bursty during X / collapse toggles).
  - Validates schemaVersion; ignores unknown versions (forward-compat).
  - Returns `{ schemaVersion: 1, cards: [] }` if file missing.

- New routes in `src/routes/file-edits.ts`:
  - `GET /api/sessions/:id/file-edits/cards` → returns the list.
  - `PUT /api/sessions/:id/file-edits/cards` → writes the list
    (JSON body validated).
  - 404 if session unknown; 400 on validation failure.

- The poller is **not** the writer. The client owns the list; the
  poller only sees it indirectly via the snapshot/event path.

Client work:

- On applet open / session change:
  1. `GET .../cards` → returns the persisted list.
  2. `GET .../snapshot` → returns current dirty + recently-cleaned edits.
  3. Build cards in the persisted order. For each persisted path:
     - If the snapshot has an edit for it, use that.
     - Otherwise create a "phantom" card with status `'clean'` and no
       `fullFile`. On the next snapshot or `caco.edit` event for that
       path, the body fills in. The card header still shows the path
       and the `✓` pill.
  4. Persisted paths missing from the snapshot stay as phantoms;
     they're not stale, just "not currently being polled."
  5. Append any snapshot edits whose path isn't in the persisted
     list (new files the agent touched while the applet was closed).

- On any mutation (X dismiss, chevron toggle):
  - Update in-memory state.
  - Schedule a debounced PUT (250ms client-side; server also
    debounces to absorb the bursty case).

- On session change:
  - Clear in-memory state. The PUT debouncer flushes its pending
    write before the new session's GET fires, so no cross-session
    leakage. Use a single in-flight controller.

Concurrency note: if two applet instances on the same session have
the file-edits applet open, the last writer wins. This is acceptable
for V2.1; both instances will eventually converge on the next poll
broadcast which both receive.

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

## Open questions

1. Should the persisted `collapsed` flag default to `true` for
   files the agent touched while the applet was closed? Currently
   the client appends them as expanded. Operator's call. Recommend:
   expanded — matches V1's "freshly touched is interesting" model.
2. Should dismissed paths also persist, so an X dismissal survives
   reopen? Current V1 behavior: dismissed is session-only.
   Recommend: persist a `dismissed: string[]` parallel field
   alongside `cards`, to honor the "X is permanent" intent.
   This costs nothing.
3. Cap eviction conflict: a persisted-only card (no current edit)
   gets evicted only when total cards exceeds 50. If the snapshot
   returns 50 dirty + 30 persisted, that's 80 → 30 eviction
   candidates. Which? Recommend: evict oldest persisted-clean cards
   first, dirty cards always survive cap, then oldest clean,
   then if still over cap, oldest dirty. Document.

## Document layout

- `docs/file-edits.md` — V1 + V3 backlog (unchanged).
- `docs/file-edits-v2.md` — V2 spec (unchanged).
- `docs/file-edits-v2.1.md` — this doc.
- `docs/file-edits-v2.1-review.md` — review log (created after review).
