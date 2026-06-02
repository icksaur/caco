# File Edits V2.1 — Spec Review

Reviewed against: `docs/file-edits-v2.1.md`
Context: `docs/file-edits-v2.md`, `docs/file-edits.md`, `src/git-edit-poller.ts`,
`src/routes/file-edits.ts`, `src/session-data-store.ts`, `applets/file-edits/script.js`

---

## [BLOCKER] Cross-session phantom cards can never fill their body

**File:** `docs/file-edits-v2.1.md:155-160`

The spec states: *"Otherwise create a 'phantom' card with status `'clean'` and no
`fullFile`. On the next snapshot or `caco.edit` event for that path, the body fills
in."* This is false for the primary persistence scenario — files cleaned in a prior
server session.

Trace:

1. Server restarts; `recently-cleaned-this-session` set is gone (it lives in
   `SessionPollerState`, which is in-memory only — `git-edit-poller.ts:61-71`).
2. Applet opens. `GET /cards` → `src/foo.ts` is persisted as clean.
   `GET /snapshot` → runs `git status --porcelain` — clean files are not listed →
   `src/foo.ts` absent from snapshot.
3. `fetchSnapshot()` marks any card in DOM but absent from snapshot as clean via
   `markClean(path)`. The idempotency guard fires immediately. Body stays empty.
4. `caco.edit` events only fire when a file transitions dirty→clean. A permanently-
   clean file produces no events. Body never fills in.

This defeats Goal 1 ("clean files render full content") for every card persisted
across a server restart — the primary use case of Goal 3 (persistence).

Fix needed before implementation: the snapshot endpoint or the client init sequence
must have a mechanism to fetch HEAD blobs for persisted-clean paths. See QUESTION-1
for three options; recommend (b) — server reads the card list itself in the snapshot
handler.

---

## [IMPORTANT] `EditEntry` interface is incompatible with `cleanedEdits` entries

**File:** `src/git-edit-poller.ts:25, 47-59`

`FileStatus = 'modified' | 'untracked' | 'deleted' | 'renamed'` — no `'clean'`.
`EditEntry.diff: string` is required (non-optional).

The spec says `cleanedEdits` entries have `status: 'clean'` and "no `diff`" but never
says to update the interface. Implementers must decide: extend `FileStatus` to add
`'clean'`, and make `diff` optional or document `diff: ''`. The current `markClean`
uses `diff: ''`, so the client convention exists. The server type needs to be
updated explicitly. Without this the poller code won't type-check.

---

## [IMPORTANT] Server debounce in `setCardList` must be per-session-ID

**File:** `docs/file-edits-v2.1.md:134-136`

*"debounced 500ms inside the module"* — a naive implementation uses a single
module-level timer, which races across concurrent sessions. If sessions A and B both
trigger writes within the 500ms window, only the last one fires; the other session's
write is silently dropped. The spec must say explicitly: **debounced 500ms per
session-ID**, implemented as a `Map<sessionId, NodeJS.Timeout>`.

---

## [IMPORTANT] Session-switch flush mechanism is underspecified

**File:** `docs/file-edits-v2.1.md:169-172`

*"The PUT debouncer flushes its pending write before the new session's GET fires."*

The current `onSessionChange` clears state and calls `fetchSnapshot()` — no flush of
any kind. Two options for the pending write:

- (a) Cancel the timer — the last X-dismiss or collapse for the old session is lost.
  Violates "X is permanent" if the user dismissed a card and switched within 250ms.
- (b) Fire immediately — execute the write synchronously (or await it) before
  teardown, then cancel the timer.

Option (b) is required to honor "X is permanent" across quick session switches. The
spec must state which and sketch the implementation shape (e.g. a flush function
that cancels the timer and calls the write path directly with the old sessionId).

---

## [IMPORTANT] `dismissed` persistence contradicts the normative section

**Files:** `docs/file-edits-v2.1.md:128` vs `docs/file-edits-v2.1.md:237-239`

Normative: *"Dismissed set (already V1 behavior — session-only). Not persisted."*
Open Question 2: *"Recommend: persist a `dismissed: string[]` parallel field."*

These are different schemas and behaviors. An implementer following the normative
section builds one thing; if the recommendation is adopted later, the schema changes
silently. The current `dismissed.clear()` in `onSessionChange` already treats it as
session-only, which is what the normative section says. Decide and remove the
contradiction before implementation.

---

## [IMPORTANT] Cap eviction for mixed dirty + persisted is not normative

**File:** `docs/file-edits-v2.1.md:244-246` (Open Question 3 only)

The scenario — snapshot returns 50 dirty + 30 persisted = 80 total, needing 30
evictions — is only in the open questions section. `enforceCap()` evicts oldest by
Map insertion order with no knowledge of dirty vs. clean status. With V2.1's restore
path, insertion order mixes old-session persisted cards (restored first) with new
dirty cards (appended after snapshot). Without a normative eviction policy the
behavior is implementation-dependent. Promote the eviction order from Open Question
3 to the behavior section.

---

## [IMPORTANT] `recently-cleaned-this-session` set: structure and eviction unspecified

**File:** `docs/file-edits-v2.1.md:64-66`

*"The server keeps a small per-session 'recently cleaned' set bounded by the existing
50-card cap."*

`SessionPollerState` has no such field. The spec does not say:

- Map shape (`Map<relativePath, EditEntry>` is implied but unstated).
- Eviction order within the set (FIFO? by dirty rank?).
- What happens when a path goes dirty again — does it leave the recently-cleaned set?
- Whether the 50-card cap is shared with the dirty set or separate.

Two implementers would produce incompatible results. Add a subsection under §1
specifying this structure before implementation.

---

## [NICE] GET /cards response shape is undocumented

**File:** `docs/file-edits-v2.1.md:140-142`

The spec shows the on-disk JSON shape but never states what GET returns. Since
`updatedAt` is set by the server on every write, the client PUT body should not need
to include it. Add: *"GET returns `{ schemaVersion, updatedAt, cards }`. PUT body
requires `{ schemaVersion, cards }` only; server sets `updatedAt`."*

---

## [NICE] PUT validation: accepted `schemaVersion` value not stated

**File:** `docs/file-edits-v2.1.md:143`

*"400 on validation failure"* — but what counts as failure for `schemaVersion`? The
spec says to "ignore unknown versions" on read, but a PUT with an unknown version
should be rejected to avoid storing uninterpretable data. Add: *"PUT only accepts
`schemaVersion: 1`; any other value → 400."*

---

## [NICE] `cleared` vs. `cleanedEdits` double-processing

**File:** `docs/file-edits-v2.1.md:183-188`

New clients processing `cleanedEdits` receive the same paths in `cleared`. The
idempotency guard swallows the duplicate call — harmless but confusing. Clarify:
*"New clients call markClean with the full entry from `cleanedEdits`; they may skip
`cleared` entries for any path that appears in `cleanedEdits`."*

---

## [NICE] Fold guard placement is vague

**File:** `docs/file-edits-v2.1.md:77-79`

*"Add a guard: skip fold collapse when every row is ctx."* The right location is in
`renderFullFile`, before calling `collapseFolds`:

```js
var rows = rawRows.every(function(r) { return r.kind === 'ctx'; })
  ? rawRows
  : collapseFolds(rawRows);
```

Placing the guard inside `collapseFolds` would change behavior for non-clean callers.

---

## [NICE] Spec is not self-contained for a fresh implementation agent

V2 constraints (fold threshold = 20, sticky/autoscroll, never-reorder, `fullFile`
payload shape) are implied by reference to V2.md. Adding a brief "Preserved V2
invariants" bullet list would make V2.1 self-contained.

---

## [QUESTION] How to fix phantom fill-in for cross-session clean cards?

Three options:

(a) Extend GET /snapshot to accept `paths[]=` query param. Client sends persisted
paths absent from the primary snapshot result; server runs `git show HEAD:<path>`
for each.

(b) Server reads the card list itself. Snapshot handler knows sessionId, calls
`getCardList(sessionId)`, finds paths absent from the dirty set, fetches HEAD blobs,
and includes them in the snapshot response. No client API change.

(c) Accept empty phantom body permanently. Reframe persistence as Goal 2-only;
Goal 1 applies only to files dirty or cleaned within the current server session.

Option (b) is least invasive.

---

## [QUESTION] Resolve dismissed persistence before coding

If dismissed IS persisted: schema becomes `{ schemaVersion, cards, dismissed }`;
store writes it; `onSessionChange` restores it. If NOT: remove Open Question 2.
Decision cannot be deferred past first commit.

---

## [QUESTION] Two-debounce stack: is 750ms to disk acceptable?

250ms client + 500ms server = 750ms max from last mutation to disk. A browser close
within that window loses the last gesture. Flush on `beforeunload` via
`navigator.sendBeacon`?

---

## [QUESTION] Scroll position on applet open with restored cards

Autoscroll starts in `'autoscroll'`. When N persisted cards are restored and a
`caco.edit` event fires, `scrollToCard` jumps the viewport — jarring when 20 stale
clean cards are already visible. Start in `'sticky'` when restoring from persistence,
or keep `'autoscroll'`?

---

## Summary

| Level | Count |
|-------|-------|
| BLOCKER | 1 |
| IMPORTANT | 5 |
| NICE | 5 |
| QUESTION | 4 |
| Total | 15 |

**Recommendation: do not proceed to implementation yet.** The BLOCKER is structural;
the five IMPORTANTs each represent an underspecified decision where two implementers
would produce incompatible behavior. All resolvable with one focused revision pass.
Once addressed, V2.1 is implementable as a single increment.
