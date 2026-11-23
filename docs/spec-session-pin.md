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
  in a folder moves to `📌`.
- `/caco.session-folder ⭐` gives a custom glyph. Same behavior as a pin.
- Pinned sessions are never auto-archived. This already holds: the auto-park
  sweep only takes root sessions (folder unset), see
  `spec-soft-archive-folder.md`.

Non-goals: drag-to-pin, a pin folder header, ordering controls within the
pinned group, making auto-archive opt-in.

## Design

### Storage: unchanged shape

A pin is `meta.folder = '📌'`. No new field, route, or meta key. Every
existing folder rule (auto-park skips foldered sessions, drag to root clears
the folder, `/caco.session-folder /` moves to root) applies unchanged.

### Server: accept a single-glyph folder name

`src/folder.ts` strips everything outside `[a-zA-Z0-9 _/-]`, so `📌`
normalizes to `''` and the PATCH route rejects it. Add one carve-out:

- `isGlyphFolder(s)`: `s.trim()` is exactly one grapheme cluster
  (`Intl.Segmenter` with `granularity: 'grapheme'`) and that grapheme matches
  `\p{Extended_Pictographic}` or `\p{S}` (symbol). Letters, digits, spaces and
  punctuation are not glyphs.
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

### Client: long-press to pin

On each session card, a long-press (500 ms, matching `applet-button.ts`)
sends `PATCH { folder: '📌' }` and toasts "Pinned".

- Use the pattern in `public/ts/button-gestures.ts`: a timer started on
  `pointerdown`, cancelled on `pointerup`, `pointercancel`, `pointerleave`, or
  a move beyond a small threshold; when it fires, set a flag that suppresses
  the following click so the session does not also open.
- Cancel the timer on `dragstart`. A desktop mouse that starts dragging is a
  drag, not a pin.
- Suppress the native `contextmenu` only when the long-press fired, so mobile
  does not also show the browser menu.
- A session already in `📌`: long-press does nothing (see Open questions).
- A session in another folder (named or glyph): long-press moves it to `📌`.

### Command

No new command. `/caco.session-folder 📌` and `/caco.session-folder ⭐` work
once the server accepts glyphs. The client check in `command-registry.ts`
already passes a single glyph through.

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
- **Drag a pinned card onto root.** The root zone drop handler compares the
  current folder (`📌`) to `''`, sees a change, and PATCHes to root. So
  dragging a pinned card within the root area unpins it. Acceptable and
  consistent with "the root zone is root", but it may surprise; see Open
  questions.
- **Drag to pin.** Not possible: a glyph folder has no drop zone. Long-press
  and the command are the ways in.
- **Grapheme edge cases.** Flags, skin-tone and ZWJ emoji are one grapheme
  each and are accepted. Variation selectors (`⭐` vs `⭐️`) are distinct
  folder strings but render the same and both land in `pinned`; harmless.
- **Old browsers.** `Intl.Segmenter` is in all current evergreen browsers and
  Node 16+. No fallback.
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
| A single letter folder like `A` becomes a pin | Glyph test requires `\p{Extended_Pictographic}` or `\p{S}`; letters and digits stay named folders |
| Existing folders named with one symbol char today | Impossible: the current validator strips all symbols |

## Acceptance

| # | Criterion |
|---|---|
| A1 | `PATCH /api/sessions/:id {folder:'📌'}` and `{folder:'⭐'}` succeed and store the glyph; `{folder:'A'}` still stores the named folder `A`; `{folder:'📌📌'}` is rejected |
| A2 | `buildSessionListModel` puts glyph-folder sessions in `pinned`, never in `folders`; `pinned` is MRU-sorted |
| A3 | Pinned cards render at the top of the root zone, above unpinned root cards, with the glyph as the last element of row 1 |
| A4 | Clicking the glyph moves the session to root and does not open the session |
| A5 | Long-press (500 ms) on an unpinned card pins it; on a card in a named folder moves it to `📌`; does not open the session; a drag does not pin |
| A6 | Dragging over the root zone highlights the pinned cards as part of root |
| A7 | A pinned session idle past the auto-park threshold is not moved to `auto-archive` |
| A8 | `/caco.session-folder ⭐` stars the active session; `/caco.session-folder /` unpins it |
| A9 | Unit tests for `isGlyphFolder`, `normalizeFolder`, `isValidFolder`, and the list model; DOM test for render order, glyph click, and long-press click suppression |

## Plan

| Phase | Work | Files |
|---|---|---|
| 1 | Glyph folder helper; accept glyphs in normalize/validate; route error text; tests (A1, A7) | `src/folder.ts`, `src/routes/sessions.ts`, `tests/unit/folder*.test.ts` |
| 2 | List model `pinned` bucket; tests (A2) | `public/ts/session-list-model.ts`, client glyph helper, tests |
| 3 | Render pinned first in root zone; glyph badge with click-to-unpin; CSS for `.session-pin` (A3, A4, A6) | `public/ts/session-panel.ts`, `public/style.css` |
| 4 | Long-press to pin with click and drag suppression (A5) | `public/ts/session-panel.ts` |
| 5 | Docs: README session list section, `/caco.session-folder` help text mentions glyphs (A8) | `README.md`, `public/ts/command-registry.ts` |

## Open questions

1. **Long-press on an already pinned session.** Spec says no-op. Alternative:
   toggle (unpin). Clicking the glyph already unpins, so no-op avoids two ways
   to do the same thing.
2. **Dragging a pinned card within root unpins it.** Keep (root zone means
   root), or treat a drop of a pinned card on the root zone as a no-op?
3. **`/pin` command.** Your chat offer mentioned "/pin" as a shortcut. Spec
   leaves it out because `/caco.session-folder 📌` covers it. Add
   `/caco.session-pin` (toggle) if you want it.
4. **What counts as a glyph.** Spec: one grapheme that is an emoji or a
   symbol. A single letter or digit stays a normal named folder. OK?
5. **Visual separation.** No divider between pinned and unpinned root cards in
   v1. Want a thin rule?
