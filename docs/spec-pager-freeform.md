# spec-pager-freeform

**Status:** draft, reviewed once (findings folded). Extends the shipped pager
(`docs/archive/spec-pager.md`).

## Goals

Each pager card gains a free-text well below its options, reading `something
else …` until tapped, with a Send button that appears once there is text. Sending
behaves exactly like clicking an option: the message goes to that session and the
card leaves the board.

This closes the gap that makes the pager a dead end — today an offer the user
disagrees with can only be dismissed, forcing them into the full UI.

## Design

**A textarea, not an input.** Option buttons wrap to multiple lines because they
carry full option text; a single-line field would truncate visually and is painful
for a sentence on a phone. The control is a `rows=1` textarea that auto-grows,
styled to match `.option` metrics (full width, same padding, radius, font size) so
it reads as one more item in the option stack.

**Deliberately featureless.** No `#` path completion, no `/` commands, no image
paste, no server-side draft persistence. It must NOT reuse
`chat-form-controller.ts` — that would pull the entire popup/router stack into a
build-free page whose point is to stay out of the frontend bundle and coverage
denominator. A textarea and a click handler is the whole mechanism.

**DOM order inside a card is head → cwd → options → well → foot**, where the foot
is `[Dismiss … Send]` with Send right-aligned (`margin-left:auto`). Send therefore
sits immediately below the well it belongs to, and the foot reads as one action
row: discard left, send right.

**The error message moves to its own line.** The foot currently holds
`[Dismiss][msg]`; adding a right-aligned Send would put a long error string
between two buttons and overflow a narrow screen. `card-msg` becomes a block below
the action row.

**The hazard is re-render, and it is the main thing this spec exists to solve.**
`render()` does `boardEl.textContent = ''` and rebuilds every card. It runs
whenever the poll returns a new version — which happens when **any** session
becomes busy or idle, not just this one. With several sessions running, a user
typing a sentence is interrupted within seconds: text gone, and on mobile the
keyboard dismissed. Two mechanisms, each covering what the other cannot:

- **A draft map** `drafts[sessionId] = text`, module-scoped like the existing
  `acted` map, written on every `input` and restored when a card is rebuilt. This
  survives any rebuild, including one the user is not watching.
- **A held board rebuild while a well has focus.** The draft map restores *text*
  but not caret position or the mobile keyboard, so a mid-sentence interruption
  would still be visible and would dismiss the keyboard. While a well is focused
  the incoming view is stashed and the board is not rebuilt.

**The hold is stateless — it cannot wedge.** It is not a boolean set on focus and
cleared on blur (which strands if the focused node is removed, or if a mobile
keyboard closes without firing blur). It is a predicate evaluated at render time:
*is `document.activeElement` a well inside `boardEl`?* If the node is gone, the
predicate is false and the board rebuilds. Three release paths beyond that:
`focusout` on the board applies the stash, `visibilitychange` to hidden applies it,
and a **60-second maximum hold** applies it regardless — after a minute of holding,
staleness is the worse failure, and the draft map means only caret and keyboard are
lost, never text.

**Exactly what is held.** `render(view)` splits into `renderRunning(view)` (the
running rows) and `renderBoard(view)` (the `acted` prune, cards, empty state, and
the truncated notice). Running rows and the `live` badge always update, so the page
never looks frozen; only `renderBoard` is deferred. The `acted` prune moves inside
`renderBoard` so suppression stays in lockstep with what is displayed — pruning
`acted` against a view whose cards were never rendered could un-suppress a card
that then reappears.

`lastVersion` continues to track what was **received**, not what was displayed:
it exists to drive the long poll's `since`, and holding it back would re-request a
version we already have. Applying a later snapshot on blur is always correct
because every response is a complete snapshot, and only the newest is kept
(a stash, not a queue).

**Drafts are never pruned by board absence.** The `acted` map is pruned when the
server stops listing a session, and that is right for a *suppression*, which must
expire. A draft is not a suppression. A session that briefly goes busy from another
client leaves `waiting` and returns with the same offer; pruning on absence would
silently delete text the user is still writing, contradicting the invariant below.
Drafts are cleared only on **successful send** or **dismiss** — the two moments the
user has resolved that card — and the map is capped at the **20 most recently
edited** entries so a long-lived tab cannot grow without bound.

**Send is the only send path — no Enter handler.** Mobile is the primary consumer
and there Enter is a newline; a desktop-only Enter-to-send would be an invisible
inconsistency between the two, and a phone user pressing Return mid-thought would
fire a half-written message. A `Ctrl/Cmd+Enter` shortcut is compatible with both
and can be added later; it is left out to keep this change one mechanism.

**Send appears only when there is something to send** — `value.trim()` non-empty,
recomputed on `input` — and the **trimmed** text is what goes on the wire.

**Send is an option click with a different string.** Same endpoint, same
closure-captured session id, same lock, same 409/404 handling (already busy or
gone ⇒ take the card off the board). One difference: on an *unexpected* failure
the draft is kept and the controls re-enabled, because a transient error must not
destroy typing.

## Invariants

- **Typing is never destroyed by anything the user did not do.** Only an explicit
  send or dismiss clears a draft.
- **No raw-HTML sink.** The new control reads `.value` and writes `textContent`,
  never `innerHTML`.
- **Actions are bound to their card's session id by closure**, never re-read from
  the DOM or a list index, so a re-render between paint and tap cannot retarget a
  send (existing pager invariant, extended to Send).
- **The board hold cannot become permanent** — it is a render-time predicate over
  live DOM state with a bounded maximum duration, not stored state.
- **The well appears only on cards that have options.** The server guarantees this
  (`needsTriage` requires `options.length > 0`), so the check is defensive.

## Considerations

- **Locking must include the textarea and Send.** They join the same `buttons`
  array `lock()` walks, so an in-flight send cannot be double-fired or edited
  underneath.
- **Whitespace-only never sends** and never reveals Send.
- **A held board is stale by design.** Bounded by the 60s cap and by the user's
  own attention; running rows keep moving so the staleness is visibly scoped.
- **The draft cap is a safety net, not a policy.** Twenty distinct sessions typed
  into without a reload is not a real workflow; the cap exists so an unbounded map
  is not left as a latent leak.

## Risks and Mitigations

- **Draft lost through a path not considered** → the jsdom oracles drive real
  typed values through a real rebuild and a real busy-blip, rather than asserting
  that a mechanism exists.
- **The hold wedges and the board freezes** → statelessness plus three
  independent release paths, one of which is a timer that needs no event at all.
- **The page grows toward being a chat client** → the featureless rule above, plus
  a static assertion that the chat-form machinery is not referenced.

## Acceptance

- Observable: tapping the well shows a caret and hides the placeholder; typing
  reveals Send; sending puts the message in that session and the card leaves the
  board. **Manual signoff on a phone** for placeholder legibility, tap-target size,
  foot layout with a long error string, and that a background refresh does not
  dismiss the keyboard.
- Gates: `npm run build` green.
- Oracles: the jsdom suite below; each must fail before its change exists.

## Plan

Two phases. **Phase 1 is independently shippable and useful on its own**; phase 2
carries the regression risk and should not block it.

### Phase 1 — the well

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | jsdom harness: load `public/pager.html`, extract and run its inline IIFE, stub `fetch` **before** evaluation with a controllable queue whose later entries never resolve (the IIFE self-re-polls, so an always-resolving stub loops forever); flush microtasks between steps; use fake timers for the backoff/retry paths and assert no unhandled rejections leak between tests | `tests/unit/pager-page-dom.test.ts` | harness renders one card from a fixture view and finds its option buttons | - |
| 2 | Add the well + Send to `renderCard` in DOM order options → well → foot; move `card-msg` to its own line; Send visible iff `value.trim()` non-empty; both join the locked set | `public/pager.html` | Send hidden when empty and when whitespace-only, visible after typing; textarea and Send are disabled during an in-flight action | well-only-with-options |
| 3 | Send posts the **trimmed** text to that card's session and removes the card | `public/pager.html` | fetch called with `/api/sessions/<id>/messages` and `{prompt}` equal to the **trimmed** typed text; card removed | closure-bound |
| 4 | Draft map: written on `input`, restored on rebuild, cleared **only** on successful send or dismiss, capped at 20 by recency | `public/pager.html` | type → force a rebuild with a new version → value survives; type → session leaves `waiting` and returns → value survives; successful send → draft gone | typing-never-destroyed |
| 5 | Keep the draft and re-enable controls on unexpected send failure; 409/404 still remove the card | `public/pager.html` | 500 ⇒ draft intact, controls unlocked, message shown; 409 ⇒ card removed | typing-never-destroyed |

### Phase 2 — the hold

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 6 | Split `render` into `renderRunning` + `renderBoard`, moving the `acted` prune into `renderBoard`; `lastVersion` still tracks what was received | `public/pager.html` | running rows update from a view whose board render is skipped; `acted` is not pruned by a skipped board render | - |
| 7 | Hold `renderBoard` while `document.activeElement` is a well inside the board; stash latest-only; release on `focusout`, on `visibilitychange` to hidden, and after 60s | `public/pager.html` | focused ⇒ new view does not rebuild the board and `document.activeElement` is unchanged; on blur the stashed view lands; a removed-while-focused node does not wedge the hold; the 60s timer releases with no event | hold-cannot-be-permanent |
| 8 | Extend the static assertions: no raw-HTML sink, no chat-form machinery referenced | `tests/unit/pager-page-static.test.ts` | static: no `innerHTML`, no chat-form/slash/`#`-completion hooks | no-raw-html-sink |
| 9 | Document the well in the pager section | `README.md` | - | - |

## Rationale

The pager was built on the premise that its unit of work is the *offer*. The well
slightly widens that: the unit becomes the *decision*, of which the offered options
are shortcuts. That is why Send sits opposite Dismiss rather than inside the option
list — the options are suggestions, and the well is the general case that was
previously reachable only by leaving the pager entirely.
