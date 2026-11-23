# Session Pin (glyph folders)

## Goals

Let a user mark a session they are not finished with so it is easy to find
again and is never auto-archived, without adding a new concept. Source: Joseph
Gearhart in the "Caco users" chat (2026-11-20). He runs one busy instance with
auto-archive on, loses track of unfinished sessions after a week or two, and
cannot tell the main session apart from several similarly named ones. Carl's
offer in the same thread: a folder whose name is a single glyph is a pin.

- A **glyph folder** is a folder whose whole name is one emoji or symbol, for
  example `📌` or `⭐`.
- Sessions in a glyph folder render at the **top of root**, not under a folder
  header.
- The glyph shows at the **top-right of the session card**. One click on it
  removes the folder (the session returns to plain root).
- **Long-press** on a session card sets its folder to `📌`. A session already
  in a folder moves to `📌`. Long-press on a pinned session does nothing.
- **`/caco.session-pin`** pins the active session, for discoverability.
  `/caco.session-pin ⭐` uses a custom glyph. `/caco.session-folder ⭐` also
  works. Every glyph behaves the same as a pin.
- Pinned and glyph sessions always render first in root, with no divider.
- A pinned card cannot be dropped on root: that is a move to nowhere and does
  not unpin it.
- Pinned sessions are never auto-archived. This already holds: the auto-park
  sweep only takes root sessions (folder unset), see
  `spec-soft-archive-folder.md`.

Non-goals: drag-to-pin, a pin folder header, ordering controls within the
pinned group, a divider, making auto-archive opt-in.

## Design

### Storage: unchanged shape

A pin is `meta.folder = '📌'`. No new field, route, or meta key. Every
existing folder rule (auto-park skips foldered sessions, drag to root clears
the folder, `/caco.session-folder /` moves to root) applies unchanged.

### Server: accept a single-glyph folder name

`src/folder.ts` strips everything outside `[a-zA-Z0-9 _/-]`, so `📌`
normalizes to `''` and the PATCH route rejects it. Add one carve-out:

- `isGlyphFolder(s)`: `s.trim()` matches
  `/^\p{Extended_Pictographic}\uFE0F?$/u`, one emoji with an optional
  variation selector. That covers `📌`, `⭐`, `⭐️`, `🔥`, `✅`. A single
  letter, digit, or punctuation mark is a normal named folder. Flags,
  skin-tone and ZWJ sequences are not glyphs; simple code wins over coverage.
- `normalizeFolder(input)`: if `isGlyphFolder(input)`, return the trimmed
  glyph as-is. Otherwise unchanged.
- `isValidFolder(input)`: true for a glyph folder. Otherwise unchanged.
- The 400 message in `PATCH /api/sessions/:id` adds "or a single emoji".

The same helper is exported for the client (shared module or a small copy in
`public/ts/`; the client cannot import from `src/`).

### Client: list model

`buildSessionListModel` (`public/ts/session-list-model.ts`) gains a `pinned`
bucket:

```ts
export interface SessionListModel {
  pinned: SessionData[];   // sessions in any glyph folder
  root: SessionData[];
  folders: FolderGroup[];  // glyph folders never appear here
}
```

- A session with `isGlyphFolder(s.folder)` goes to `pinned`, never into
  `folderMap`.
- `pinned` sorts with the same MRU comparator as root. Glyphs are mixed in one
  group; there is no per-glyph grouping.
- The fuzzy filter (`session-panel.ts` line ~56) applies before the model is
  built, so pinned sessions filter like any other.

### Client: rendering

In `renderFromModel` (`public/ts/session-panel.ts`):

- The root zone renders `model.pinned` first, then `model.root`. Both live in
  the same `.folder-zone[data-folder=""]` element, so the existing root drop
  highlight covers the pinned cards with no extra code.
- The "root is empty" drop indicator shows only when both `pinned` and `root`
  are empty.
- The whole-list "no sessions" empty state (`session-panel.ts` ~561) must
  check `pinned` too, so a list of only pinned sessions is not shown as empty.
- No visual separator between pinned and unpinned cards in v1.

In `createSessionItem`:

- When `isGlyphFolder(session.folder)`, append a `span.session-pin` holding the
  glyph as the last child of `row1`, after the age, so it sits at the
  top-right of the card.
- `title`: "Pinned. Click to unpin." for `📌`; "In folder ⭐. Click to
  remove." for other glyphs.
- Click handler: `stopPropagation()` (do not open the session), then
  `PATCH /api/sessions/:id { folder: '/' }`, toast "Unpinned", reload the
  list. Reuse the `movingSessionIds` guard so a double click sends one PATCH.
- The glyph span sets `draggable = false` and stops `pointerdown` and
  `dragstart` propagation, so holding the glyph neither starts a card drag nor
  the card long-press.

### Client: long-press to pin

On each session card, a long-press (500 ms, matching `applet-button.ts`)
sends `PATCH { folder: '📌' }` and toasts "Pinned".

- Implement a small pointer-based gesture on the card. `button-gestures.ts`
  is not reusable here: it uses separate mouse and touch events and has no
  move threshold or drag cancel. The card gesture: start a timer on
  `pointerdown` (ignore events whose target is inside `.session-pin`), cancel
  on `pointerup`, `pointercancel`, `pointerleave`, or a move over 8 px; when it
  fires, set a flag that suppresses the following click so the session does
  not also open. Reset the flag on the next `pointerdown`.
- Cancel the timer on `dragstart`. A desktop mouse that starts dragging is a
  drag, not a pin.
- Suppress the native `contextmenu` only when the long-press fired, so mobile
  does not also show the browser menu.
- A session already in `📌`: long-press does nothing (no PATCH, no toast).
- A session in another folder (named or another glyph): long-press moves it
  to `📌`.

### Client: a pinned card cannot drop on root

Dropping a glyph-folder card on the root zone is a move to nowhere, since it
already renders in root. It must not unpin.

- `dragstart` records the dragged session id in a module variable
  (`draggingSessionId`), cleared on `dragend`. `dataTransfer.getData` is not
  readable during `dragover`, so the id is needed there.
- Root zone `dragover` / `dragenter`: when the dragged session is in a glyph
  folder, do not `preventDefault` (the browser shows "no drop") and do not add
  `drop-highlight`.
- Root zone `drop`: the same check returns early with no PATCH, as a backstop.
- Dragging a pinned card onto a named folder zone still moves it there, which
  unpins it. That is a real move.

### Command: `/caco.session-pin`

New builtin in `public/ts/command-registry.ts`, listed next to
`caco.session-folder` ("Pin session to the top of the list (optionally with an
emoji)").

- `/caco.session-pin` pins the active session with `📌`.
- `/caco.session-pin ⭐` uses that glyph. An argument that fails
  `isGlyphFolder` toasts "Usage: /session-pin [emoji]" and sends nothing.
- If the session is already in that glyph: toast "Already pinned", no PATCH.
  The current folder comes from `getCachedSessions()` (`session-panel.ts`
  ~40). If the active session is not in the cache, PATCH anyway; the server
  write is idempotent.
- Otherwise `PATCH /api/sessions/:id { folder: glyph }`, toast "Pinned".
- Unpin is the glyph click or `/caco.session-folder /`. No `/caco.session-unpin`.

The backend work is the folder validator change above; the command uses the
existing PATCH route. `/caco.session-folder 📌` also works.

## Invariants

- A pin is only `meta.folder`. Nothing else in meta marks it.
- A glyph folder never renders a folder header, never appears in
  `model.folders`, and never collapses.
- Pinned sessions are never auto-parked, because they are not root sessions
  on the server.
- Unpinning always means folder `'/'` (root), never "previous folder".
- Named folder validation is unchanged for anything that is not a single
  glyph.

## Considerations

- **Server sees pins as foldered.** Anything server-side that checks
  `!meta.folder` (auto-park, overview `folder` fact) treats a pinned session as
  foldered. That is the point for auto-park. The overview shows `folder 📌`,
  which is accurate.
- **Drag to pin.** Not possible: a glyph folder has no drop zone. Long-press
  and the commands are the ways in.
- **Variation selectors.** `⭐` and `⭐️` are distinct folder strings but render
  the same and both land in `pinned`; harmless.
- **Unicode property escapes.** `\p{...}` with the `u` flag is supported by
  every current browser and Node version Caco runs on.
- **Long-press vs scroll on mobile.** A move threshold cancels the timer so a
  scroll that starts on a card does not pin it.
- **Peers.** Folder names cross instances only as display text (overview,
  portal). No schema change.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Long-press fires during a desktop drag | Cancel on `dragstart` and on pointer move past threshold |
| Long-press also opens the session | Suppress the next click after a fired long-press |
| Emoji in a filesystem path | Folder is meta-only; it is never a path segment. Verify no code joins `meta.folder` into a path |
| A single letter folder like `A` becomes a pin | Glyph test requires `\p{Extended_Pictographic}`; letters and digits stay named folders |
| A pinned card dropped on root unpins it | Root zone refuses glyph-folder drags in `dragover` and `drop` |
| Existing folders named with one symbol char today | Impossible: the current validator strips all symbols |

## Acceptance

| # | Criterion |
|---|---|
| A1 | `PATCH /api/sessions/:id {folder:'📌'}` and `{folder:'⭐'}` succeed and store the glyph; `{folder:'A'}` still stores the named folder `A`; `{folder:'📌📌'}` is rejected |
| A2 | `buildSessionListModel` puts glyph-folder sessions in `pinned`, never in `folders`; `pinned` is MRU-sorted |
| A3 | Pinned cards render at the top of the root zone, above unpinned root cards, with the glyph as the last element of row 1 |
| A4 | Clicking the glyph moves the session to root and does not open the session |
| A5 | Long-press (500 ms) on an unpinned card pins it; on a card in a named folder moves it to `📌`; on a pinned card does nothing; never opens the session; a drag does not pin |
| A6 | Dragging an unpinned card over the root zone highlights it, pinned cards included; dragging a pinned card over the root zone shows no highlight and a drop sends no PATCH |
| A7 | A pinned session idle past the auto-park threshold is not moved to `auto-archive` |
| A8 | `/caco.session-pin` pins with `📌`; `/caco.session-pin ⭐` uses `⭐`; `/caco.session-pin abc` shows usage and sends nothing; `/caco.session-folder ⭐` also works; `/caco.session-folder /` unpins |
| A9 | Unit tests for `isGlyphFolder`, `normalizeFolder`, `isValidFolder`, and the list model; DOM tests for render order, a pinned-only list (not "no sessions"), glyph click, holding the glyph does not long-press, long-press click suppression, and the root drop refusal (no PATCH, no leftover `drop-highlight`); command tests for default glyph, custom glyph, invalid argument, and same-glyph no-PATCH |

## Plan

| Phase | Work | Files |
|---|---|---|
| 1 | Glyph folder helper; accept glyphs in normalize/validate; route error text; tests (A1, A7) | `src/folder.ts`, `src/routes/sessions.ts`, `tests/unit/folder*.test.ts` |
| 2 | List model `pinned` bucket; tests (A2) | `public/ts/session-list-model.ts`, client glyph helper, tests |
| 3 | Render pinned first in root zone; glyph badge with click-to-unpin; CSS for `.session-pin` (A3, A4, A6) | `public/ts/session-panel.ts`, `public/style.css` |
| 4 | Long-press to pin with click and drag suppression; root zone refuses pinned drags (A5, A6) | `public/ts/session-panel.ts` |
| 5 | `/caco.session-pin` builtin; README session list section; `/caco.session-folder` help mentions emoji (A8) | `public/ts/command-registry.ts`, `README.md` |

## Rationale

Decisions from Carl (2026-11-23):

1. Long-press on a pinned session does nothing. The glyph click is the one way
   to unpin from the card.
2. Dropping a pinned card on root is a move to nowhere, so it is refused and
   does not unpin.
3. `/caco.session-pin` exists for discoverability, even though
   `/caco.session-folder 📌` does the same thing.
4. A glyph is whatever a simple emoji regex matches. A single letter or digit
   is a folder. Simpler code is preferred over full emoji coverage.
5. No divider. Pinned and glyph sessions go first in root.
