# spec: persistent chat input drafts

## Goal

The chat input textarea contents survive page reloads. If the user is
typing — in an existing session or before starting a new one — and
the page is reloaded, closed-then-reopened, or crashes, their
half-written message is restored.

## Why

Drafts already survive *session-switches* via the in-memory
`sessionDrafts` Map (`public/ts/chat-view-controller.ts:31`), but a
page reload empties the Map. Several recurring complaints reduce to
this gap: accidental refresh during a long message, browser tab
restored after sleep, navigating away to look something up.

## Scope

- Per-session draft: persists as long as the session exists on disk.
- New-chat draft: persists across reloads even though no session ID
  exists yet. One single buffer (not one per CWD or one per model);
  if the user navigates away from new-chat back to it, they see the
  same draft.
- Restore on page load and on session activation.
- Clear after successful send.

Out of scope:
- Multi-tab synchronization (two browser tabs editing the same
  draft simultaneously). Last-writer-wins, no merge.
- Versioning / undo of saved drafts.
- Encryption at rest. Drafts may contain sensitive text; same
  trust model as the rest of `~/.caco/sessions/<id>/`.
- Drafts for sessions that get archived/deleted server-side — once
  the session directory is gone, the draft is gone too.
- Per-channel drafts (the chat input is single; nothing to split).

## Data model

Per-session draft, stored at
`~/.caco/sessions/<sessionId>/chat-draft.txt` — plain UTF-8 text,
no JSON envelope. Existence of the file = there is a draft. Empty
file = no draft (delete the file when the input goes empty).

New-chat draft, stored at `~/.caco/drafts/newchat.txt`. Same
shape. One file, global to the user. The draft is explicitly NOT
keyed by CWD: it survives navigating between CWDs the same way
the session list itself does. A user starting a draft for repoA
and then switching to repoB will see the repoA draft when they
re-enter new-chat — this is by design (treat the new-chat draft
like a single scratchpad), not a bug. See §Risks for the
multi-tab and multi-CWD acceptance.

Plain text rather than JSON because (a) the only content is a
string; (b) easier to inspect; (c) one less serialize/deserialize
round trip. The file is only ever read or written as a whole; no
appending.

## Behavior

### Save

Triggered by the textarea's `input` event. Debounced to 1000 ms after
the most recent keystroke (single timer, reset on each input). On
flush:

- If the active session has an ID: PUT `/api/sessions/:sessionId/draft`
  with the textarea's current value as the body
  (`Content-Type: text/plain`).
- If no active session (new-chat view): PUT `/api/draft/newchat`
  with the value as the body.

Empty value → DELETE the same URL. Treat whitespace-only as empty,
matching the existing `sessionDrafts` semantics
(`chat-view-controller.ts:57`).

Requests for a given key (per-session-id, or `newchat`) are
serialized client-side through a small per-key queue (one Promise
chained per key). This guarantees that DELETE always observes the
true latest text and that send-time DELETEs cannot be overtaken by
a still-in-flight PUT (see B1 in the implementation race notes
below).

The server writes synchronously to disk on each PUT/DELETE. With
client-side serialization, "two PUTs race" only happens across
browser tabs / processes; that case stays last-writer-wins as
documented under §Risks.

### Restore

On page load, before the user's first interaction:

1. If the URL points to an existing session, GET
   `/api/sessions/:sessionId/draft`. If 200, set the textarea value
   and dispatch a synthetic `input` event so the auto-resize and
   other input-event listeners fire. If 404, leave empty.
2. If the URL is `/` (new chat) or no session is active, GET
   `/api/draft/newchat`. Same handling.

Order matters: restore happens AFTER the existing session activation
flow (`onSessionChange` and friends), so the controller's in-memory
`sessionDrafts` Map is populated from disk during the same lifecycle
hook the controller already uses. Specifically: when the session is
activated (or when new-chat view is shown), kick off the GET and on
resolve write into `sessionDrafts` Map then call `restoreDraft`.

First-load GET runs once per session as the user activates it; the
Map serves cross-switch hits without re-fetching. We deliberately
do NOT pre-fetch all drafts at boot — most users touch one session
per load and per-activation GETs are cheap (small files, local
filesystem).

The two-level setup (Map + disk) means session-switches within a
single page load remain instant (Map hit, no fetch). Cross-reload
restoration goes through disk.

### Clear after send

`ChatViewController` already calls `sessionDrafts.delete(sessionId)`
on successful send (`chat-view-controller.ts:379`). Extend that path
to also issue a `DELETE /api/sessions/:sessionId/draft`. For
new-chat → first message → session-created transition, the new-chat
file is deleted and a per-session file may be created when the user
starts typing follow-ups (or never, if they send and stop).

The send path MUST:
1. Cancel the pending debounce timer for the active key.
2. Enqueue the DELETE through the per-key serialization queue
   (step 1's cancellation only stops the timer; a PUT already on
   the wire is sequenced *before* the DELETE by the queue).

### Failed-send recovery and persistence

`ChatViewController.restoreFailedPrompt` (`chat-view-controller.ts:382-393`)
puts a failed send's text back into `sessionDrafts` so the user can
retry. Today it survives session switches; pre-spec it does not
survive a reload because the Map is in memory.

V1 of this spec preserves that pre-existing limitation: failed-send
recovery survives in-memory session-switches but does NOT survive a
reload. Rationale: the path is a recovery affordance, not a
persistent draft, and persisting it would require additional PUT
calls on failure paths that currently don't talk to the server.
Document the regression explicitly so a future agent doesn't try to
remove the difference.

If a future change wants reload-survival for failed sends, the
simplest answer is: in `restoreFailedPrompt`, additionally enqueue
the same per-key PUT used by the normal save path. That's a
follow-up, not V1.

### New-chat → session-created handoff

When the user sends their first message from new-chat:

1. Send creates the session, gets a session ID.
2. New-chat draft is now obsolete (the user sent it). DELETE
   `/api/draft/newchat`.
3. If the user immediately starts typing again into the now-existing
   session, the debounce will save to
   `/api/sessions/<newid>/draft` as normal.

No migration of newchat draft into the session-specific file —
sending the message already consumed it.

### Edge cases

| Case | Behavior |
|---|---|
| User types, closes browser before debounce flushes | Last 0-1 s of typing lost. Acceptable; 1 s is short. |
| User types in new-chat, navigates to an existing session, navigates back | Restore-on-show path runs again; sees the same disk file; draft re-appears. The in-memory Map for new-chat needs the same treatment as per-session drafts (key `'__newchat__'` or similar). |
| User has the same session open in two tabs, both typing | PUTs race. Whichever lands last wins. Visible to user as: type in tab A → reload tab B → tab A's draft appears. No CRDT, no merge, no warning. Documented. |
| Server can't write to disk (permissions / disk full) | PUT returns 5xx. Client logs warning, retries next debounce. Draft still safe in memory. |
| Disk file contains 2 MB of text (e.g. paste of huge buffer) | Cap the textarea content at the existing UI cap (whatever multiline-input already enforces, if anything; spec a cap of 1 MiB if no existing cap). Reject PUT bodies above the cap server-side with 413. |
| User reloads while a PUT is in flight | New page issues GET; if PUT hasn't landed yet, sees pre-PUT version. Race accepted. |
| Session is deleted server-side while a draft exists | Whatever cleanup deletes `~/.caco/sessions/<id>/` removes the draft for free. |
| Concurrent send + debounce flush | Send issues DELETE; debounce flush issues PUT. If DELETE lands first, PUT recreates a draft of the message that was just sent. Mitigation: cancel the debounce timer in the send path before issuing DELETE. |

## API

REST rather than the WebSocket `setState`/`getState` bus because (a)
that bus is backed by an in-memory `Map` (`src/applet-state.ts`)
which does not persist across server restarts, and (b) REST is
robust against the WebSocket-not-yet-connected window on initial
page load. Both behaviors matter for draft persistence.

```
GET    /api/sessions/:sessionId/draft       → 200 text/plain | 404
PUT    /api/sessions/:sessionId/draft       ← text/plain     → 204 | 404 | 413
DELETE /api/sessions/:sessionId/draft       → 204 | 404

GET    /api/draft/newchat                   → 200 text/plain | 404
PUT    /api/draft/newchat                   ← text/plain     → 204 | 413
DELETE /api/draft/newchat                   → 204
```

Status code rules:

- `404` on session-scoped routes when the session directory does not
  exist on disk. This is distinct from "draft file does not exist
  but session does", which is also 404 for GET but 204 for PUT (we
  just wrote it). The session-disappeared signal lets the client
  log a warning and stop trying.
- `404` from GET when no draft file exists (whether or not the
  session does — same code, the client treats both as "no draft").
- `413` from PUT when body exceeds the 1 MiB cap.

The server-side draft store MUST check `existsSync(getSessionDir(sessionId))`
before writing. The existing `setSessionData` pattern at
`src/session-data-store.ts:41-46` calls `ensureDir` unconditionally,
which would resurrect a ghost session directory on every keystroke
from a stale tab pointing at a deleted session. The new
`setSessionDraft` must NOT use that pattern; it must return a
"missing" signal that the route maps to 404. (Cleanup at
`src/session-manager.ts:811` via `rmSync` then stays effective.)

Body cap: 1 MiB. Enforced by per-route `express.text({ type:
'text/plain', limit: '1mb' })` middleware (the project does not use
a global body parser — see `src/routes/api.ts:438` for the existing
per-route pattern). The middleware returns 413 automatically; no
manual size check needed.

Client-side, the textarea is NOT truncated. If the user pastes >1 MiB
the in-memory text is preserved; the controller stops issuing PUTs
and surfaces a small warning. Mutating user input out from under
them (mid-paste, mid-word) is a bad pattern with no undo. The 1 MiB
threshold is so far above realistic chat input that the warning is
the actual UX, not the truncation.

## Implementation plan

In order:

1. **Server: per-session draft store.** Add
   `getSessionDraft(sessionId)` / `setSessionDraft(sessionId, text)`
   / `deleteSessionDraft(sessionId)` to a new file
   `src/session-draft-store.ts`. Reads/writes
   `~/.caco/sessions/<sessionId>/chat-draft.txt` using
   `fs.writeFileSync`. **Must `existsSync(getSessionDir(sessionId))`
   before writing** and return a "missing-session" result if false
   (per §API). Do NOT reuse `setSessionData`'s ensureDir-unconditional
   pattern.

2. **Server: new-chat draft store.** Add
   `getNewChatDraft()` / `setNewChatDraft(text)` / `deleteNewChatDraft()`
   to the same file. Reads/writes `~/.caco/drafts/newchat.txt`. Calls
   `ensureDir(~/.caco/drafts/)` once on first write.

3. **Server: routes.** Add to `src/routes/sessions.ts` for the
   session-scoped routes and a new `src/routes/draft.ts` (or extend
   an existing global route file) for the new-chat routes. Each PUT
   route gets its own
   `express.text({ type: 'text/plain', limit: '1mb' })` middleware
   (the project does not use a global body parser — the existing
   per-route pattern is at `src/routes/api.ts:438`). The middleware
   handles the 413 case automatically. Return appropriate status
   codes per §API.

3a. **Cleanup on session delete: already covered.** Session deletion
    calls `rmSync(cacoPath, { recursive: true })` at
    `src/session-manager.ts:811`, which removes the entire
    `~/.caco/sessions/<id>/` directory including
    `chat-draft.txt`. No new cleanup code needed.

4. **Client: API helper.** Add `chat-draft-api.ts` under
   `public/ts/` with `getDraft(sessionId | null)`,
   `putDraft(sessionId | null, text)`, `deleteDraft(sessionId | null)`.
   `null` means new-chat. Wraps `fetch`. Returns Promises.
   Internally serializes per key via a `Map<string, Promise<unknown>>`
   queue: every call chains onto the prior promise for the same
   key, so the in-flight PUT race (B1) is impossible.

5. **Client: ChatViewController integration.**
   - Constructor / initialization: also listen for `input` events on
     the textarea; debounce 1 s; on flush, call `putDraft` or
     `deleteDraft` based on whitespace-only check. The flush
     enqueues through the per-key queue (step 4), so ordering vs
     send-time DELETE is automatic.
   - `onSessionChange` (or wherever session activation runs): after
     in-memory `restoreDraft` runs, if the Map entry is empty AND
     the textarea is empty, GET the disk draft; on success, populate
     the Map and re-call `restoreDraft`.
   - `showNewChat`: same idea, but with the new-chat key.
   - Send path (the existing `sessionDrafts.delete(sessionId)` call
     at line 379): (a) clear the pending debounce timer, (b) call
     `deleteDraft(...)`. Because the per-key queue serializes all
     requests, any PUT already in flight runs to completion before
     the DELETE — so the DELETE always wins. For
     new-chat → session-created handoff, also call
     `deleteDraft(null)` for the new-chat key.

6. **Client: cap behavior.** In the textarea's `input` handler, if
   `value.length > 1 MiB` (1024 * 1024), skip the PUT (keep the
   in-memory text intact) and show a small one-time warning via
   the existing notification system if available, else console. Do
   NOT truncate the user's text. The cap is a persistence
   boundary, not an input restriction; the threshold is far above
   any realistic message.

7. **Tests.** Extend `tests/unit/chat-view-controller.test.ts`:
   - Mock the draft API; assert PUT is called after 1 s debounce.
   - Assert DELETE is called on successful send and that an
     in-flight-PUT scenario doesn't recreate the file (the per-key
     queue test).
   - Assert GET is called on session activation when in-memory Map
     is empty.
   - Assert new-chat draft round-trips across showNewChat calls.
   - Assert failed-send recovery still works in-memory (regression
     guard for §Failed-send recovery).

   New file `tests/unit/session-draft-store.test.ts` for server side:
   round-trip read/write/delete, 1 MiB cap enforcement, missing-
   session 404 (verify no directory is created).

## Risks

- **Race between debounce and send.** Resolved by per-key
  client-side serialization queue (step 4). The DELETE always sees
  the latest text and cannot be overtaken by an in-flight PUT.
- **PUT to missing session creates ghost directory.** Resolved by
  the server `existsSync` check; do NOT reuse `ensureDir`-
  unconditional pattern from `setSessionData`.
- **Failed-send recovery does not survive reload (regression).**
  Pre-existing in-memory-Map limitation; explicitly documented as
  out of scope for V1. Easy follow-up: have
  `restoreFailedPrompt` also PUT through the per-key queue.
- **Disk fills up.** Drafts are small (1 MiB cap). At 1 MiB per
  session and ~thousands of sessions, worst case ~few GB. Pre-
  existing session-data files are already comparable; no new risk.
- **Stale newchat draft confuses the user.** If they typed a draft
  weeks ago and forgot, opening a new chat shows it. Acceptable —
  same as VSCode unsaved changes; easy to clear by Ctrl+A Del.
- **Cross-CWD new-chat draft bleed.** User starts a draft in repoA,
  switches CWD to repoB, sees repoA draft. Acceptable: the
  new-chat input is a single scratchpad by design (matches
  Caco's session list, which is also global). Documented as
  explicit product choice in §Data model.
- **Multi-tab clobbering (same session).** Last-writer-wins; no
  CRDT, no warning. Rare — the typical Caco usage is one tab per
  session.
- **`getLastInput()` up-arrow recall.** Lives in
  `sessionPrompts` Map (`chat-view-controller.ts:399-403`), also
  in-memory, also lost on reload. Out of scope for this spec; do
  not assume that "drafts persist therefore up-arrow recall
  persists."

## Open questions

None.
