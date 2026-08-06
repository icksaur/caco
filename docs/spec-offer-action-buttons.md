# Offer-action buttons: 200-char cap, ellipsis display, full-text send

Status: spec (quick). Goal: stop offer-action buttons from sending visually-truncated
text. Cap each action at 200 chars (the canonical text), display it ellipsis-truncated to
fit a 2×2 grid, show the full (200-char) text in a tooltip, and send that same 200-char
text on click — tooltip and sent text identical.

## Goals

`normalizeOptions` (`src/offer-action-parse.ts`) destructively truncates each option to
`MAX_OPTION_LENGTH = 50` (`o.slice(0, 50)`) **server-side**, before it reaches the client.
So the button's `data-prompt` is already the 50-char fragment, and clicking sends that
fragment — not the full action. The cap is also too short.

## Design

- **Canonical text = the action capped at 200 chars.** This single string is what's
  stored in `responseOptions`, shown in the tooltip, and sent on click. (A model rarely
  exceeds 200; beyond that the hard cap applies and is faithfully reflected everywhere.)
- **Button display** is visually shortened with a CSS ellipsis so four buttons fit a 2×2
  grid — purely cosmetic; the element's value/tooltip/sent text remain the full 200-char
  string.
- **Tooltip** (`title`) = the full 200-char text.
- **Click** stages the full 200-char text into the message well (already via `data-prompt`); sending is a second, deliberate act. See `spec-offer-action-stage`.

## Changes

| File | Change |
|---|---|
| `src/offer-action-parse.ts` | `MAX_OPTION_LENGTH` `50` → `200`. (Single shared truncation point — both inline-parse and tool paths inherit it. Cap stays destructive: the 200-char value is canonical for tooltip + send, satisfying "must match sent text".) |
| `public/ts/chat-form-controller.ts` (`renderResponseOptions`) | Add `title="${escaped o}"` to each button (tooltip = full text). `data-prompt` already carries the full `o` and the click handler already sends `btn.dataset.prompt` — no logic change, just confirm it sends the untruncated value. Keep HTML-escaping for `title`, `data-prompt`, and text. |
| `public/style.css` | `.response-options`: switch to a 2-column grid (`display: grid; grid-template-columns: 1fr 1fr; gap: 6px`) so ≤4 options lay out 2×2. `.response-option-btn`: `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;` for the ellipsis (grid cell constrains width; `min-width:0` lets it shrink below content). |

## Considerations

- `min-width: 0` is required — without it a grid/flex item won't shrink below its content
  width, so `text-overflow: ellipsis` never triggers.
- 1–3 options: a 2-col grid still reads naturally (1 → one cell; 2 → one row; 3 → 2 + 1).
- The existing `muted` state and `formStateStore` flow are unchanged. (Click-to-send became click-to-STAGE in `spec-offer-action-stage`; the text carried is the same.)
- HTML-escaping: `data-prompt` and `title` are escaped with the **same** shared
  `escapeHtml` (escapes `&` before `"`), so the two are byte-identical and decode back to
  the canonical text — guaranteeing tooltip === sent.
- **Legacy/in-flight options:** any `meta.responseOptions` already persisted at the old
  50-char cap cannot be recovered (the full text is gone) — no migration is possible or
  needed. The fix applies to newly parsed/stored offer actions; stored 50-char options
  age out on the next send.

## Acceptance

- Observable: buttons display ellipsed text in a 2×2 grid; hovering shows the full text in a tooltip; clicking sends the full (up to 200-char) canonical text. Visual signoff required (user confirms layout and tooltip).
- Budgets: n/a.
- Gates: `npm run build` green.
- Oracles: `tests/unit/offer-action-parse.test.ts` — an option >50 chars preserved up to 200; an option >200 cut at exactly 200; `MAX_OPTION_LENGTH === 200`. `tests/unit/response-option-html.test.ts` — button `data-prompt` equals `title` equals full canonical text (render assertion). Click handler sends `data-prompt` verbatim.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Raise `MAX_OPTION_LENGTH` to 200 | `src/offer-action-parse.ts` | `offer-action-parse.test.ts`: option >50 preserved; option >200 cut exactly |
| 2 | Add `title="${escaped o}"` to each button | `public/ts/chat-form-controller.ts` | `response-option-html.test.ts`: `title === data-prompt` |
| 3 | 2-column grid + ellipsis CSS | `public/style.css` | visual signoff |
