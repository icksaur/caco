# spec-offer-action-stage

**Status:** draft. Amends `spec-offer-action-buttons` (main UI) and
`docs/archive/spec-pager.md` (pager). One behaviour change, two surfaces.

## Goals

Clicking an offered action puts its full text in the message well instead of
sending it. Sending takes a second, deliberate act. In the main UI that makes an
offer *editable* — the user can amend the wording before committing — and in both
surfaces it removes the class of mistake where a mis-tap immediately dispatches a
turn.

## Design

**The change is a deletion, not a feature.** The main UI already stages the text;
it just submits in the same breath (`chat-form-controller.ts` ~line 138):

    this.textarea.value = prompt;
    this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    this.form.requestSubmit();          // <- this goes

The `input` dispatch stays: it drives autosize, draft persistence, and the form
state that turns Send on. Focus moves to the textarea with the caret at the end,
because the point of staging is to let the user type.

**`formStateStore.set({ options: [] })` also goes.** That line clears the offer as
though it had been consumed. Nothing has been sent yet, so clearing it would strand
a user who clicked the wrong option with no way back to the others. The offer is
consumed when a message is actually sent, which the existing dispatch path already
handles.

**Existing behaviour does the muting for free.** `computeFormState` already returns
`optionsVisible: hasOptions && !hasText` and `optionsMuted: hasOptions && hasText`,
and the `input` event we keep firing recomputes it. So the moment the click stages
text, the buttons dim (`opacity: .3; pointer-events: none`) with no new code — the
user's "this is fine!" behaviour is emergent, not something to add.

There is a subtlety worth stating because it looks like a bug: with text present,
`optionsVisible` is false while `optionsMuted` is true. `refreshButton` decides
which of those applies. The staged state must leave the buttons **visible and
muted**, not hidden — a user who has just staged an option needs to see the others
to pick differently. Row 2's oracle pins that.

**The pager keeps its own rule, deliberately.** Its cards have no shared well and no
form state; each card owns a `.well` and a `Send`. Clicking an option there stages
into **that card's own well** and reveals its `Send`, reusing the draft map so the
text survives a board rebuild exactly like typed text. Options stay fully live —
no muting — because a pager card is a triage surface where switching between
offered options is the common act, and there is no ambiguity about which well the
text landed in.

**Staging on the pager MUST focus the well.** The board hold (spec-pager-freeform
phase 2) is a predicate over `document.activeElement`, so it engages only while a
well is focused. A click on a *button* does not focus the textarea, which would
leave a user who has just staged an option reading a board that can rebuild under
them mid-decision — the exact interruption the hold exists to prevent. The staging
path therefore calls `well.focus()` explicitly, and this is a behavioural
requirement, not an incidental nicety: without it the hold silently does not apply.
Focusing also raises the mobile keyboard, which is what an editable stage wants.

**One rule, two mechanisms.** The shared invariant is "a click stages, a second act
sends". How staging is displayed differs because the surfaces differ, and that
difference is intentional rather than an inconsistency to be reconciled later.

## Invariants

- **No message is dispatched by a single click on an offered action**, on either
  surface. This is the whole point and the one thing a regression would silently
  undo.
- **The offer survives staging** — clicking an option does not clear the other
  options; only an actual send consumes them.
- **Staged text is indistinguishable from typed text** downstream: same draft
  persistence, same form state, same send path. No parallel "pending option" state
  exists to drift.
- **The pager's draft map still owns card text** — staging writes through it, so a
  board rebuild cannot lose a staged option (`spec-pager-freeform`).

## Considerations

- **The main UI stages into a shared well, and replace is now riskier than it was.**
  Today a click sends immediately, so overwriting a draft is invisible collateral of
  an act the user clearly intended. Once options become an *editing affordance*, a
  mis-tap can silently clobber typed text that is also persisted to disk. The spec
  keeps replace anyway — a confirm on every click would defeat the one-tap ergonomics
  the buttons exist for, and an append produces a nonsense concatenation — but this is
  an accepted tradeoff, not an oversight. If it bites in practice, the fix is an undo
  affordance, not a prompt.
- **Mobile keyboards.** Focusing the textarea on the main UI raises the keyboard,
  which is what an editable stage wants. On the pager, focusing a card's well also
  raises it — and that now interacts with the board hold from
  `spec-pager-freeform`, which is correct: a staged option should hold the board
  exactly like typing does.
- **Staging overwrites the pager well too**, including text the user typed there.
  Same reasoning as the main UI — the click is a specific expressed intent — and
  symmetric across both surfaces so there is one rule to remember. Repeated option
  clicks therefore restage, which is the intended way to change your mind.
- **Empty/whitespace options cannot occur** — the server only emits non-empty
  option text — but the pager's Send already gates on `value.trim()`, so a staged
  option behaves the same as typed text with no extra guard.
- **The user must still be able to send unchanged.** Staging adds a keystroke to the
  common path (click, then Enter or tap Send). That is the accepted cost of
  preventing mis-taps, and is the user's explicit request.

## Risks and Mitigations

- **Users perceive the button as broken** because nothing appears to happen →
  mitigated by focus moving to the well with the caret at the end, plus the
  buttons visibly dimming, so the state change is legible.
- **A regression re-adds auto-send** → the oracle asserts no dispatch occurs on
  click, on both surfaces, which is what actually matters.
- **The pager's staged text is lost on rebuild** → staging writes through the draft
  map, and the existing rebuild oracle covers it.

## Acceptance

- Observable: in the main UI, clicking an action fills the well, dims the other
  options, and sends nothing until Send/Enter; the text can be edited first. In
  the pager, clicking an option fills that card's well and reveals Send, with the
  options still clickable. **Manual signoff on a phone** for the pager, since
  keyboard and focus behaviour is not observable in jsdom.
- Gates: `npm run build` green.
- Oracles: rows below; each must fail before its change exists.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 0 | Build the missing main-UI harness: no existing test exercises the `#responseOptions` click wiring at all, so rows 1-2 are not checkable without it. A jsdom fixture that mounts the form, renders options, and can observe `dispatchPrompt` | `tests/unit/chat-form-options.test.ts` | the harness renders option buttons and a click reaches the handler | - |
| 1 | Main UI: drop `requestSubmit()` and the `options: []` clear from the option-click handler; focus the textarea with the caret at the end | `public/ts/chat-form-controller.ts` | jsdom: clicking an option sets `textarea.value`, **`dispatchPrompt` is NOT called** (asserted directly, not via the absence of `requestSubmit` — the dispatch path could change), and `formStateStore` options are unchanged | no-single-click-send, offer-survives-staging |
| 2 | Confirm the staged state leaves options visible-and-muted rather than hidden. **Verified from code**: `refreshButton` renders when `optionsVisible \|\| optionsMuted`, so muted ⇒ shown-and-dimmed and no change is needed — the row exists to pin it | `public/ts/chat-form-controller.ts`, `public/ts/form-state.ts` | after a staged click the container is displayed and its buttons carry `.muted` | offer-survives-staging |
| 3 | Pager: option click stages into that card's well (`setDraft` + `syncSend` + `grow`), **focuses the well**, reveals Send, and posts nothing | `public/pager.html` | jsdom (`pager-page-dom.test.ts`): clicking an option makes zero POSTs, sets the well's value, un-hides Send, and leaves `document.activeElement` as that well (which is what engages the board hold); a rebuild preserves the staged text | no-single-click-send, pager-draft-owns-text |
| 4 | Pager: options stay live after staging (no muting) | `public/pager.html` | jsdom: after staging, option buttons are enabled and a second click restages | - |
| 5 | Update the live specs and the README pager section to describe staging. **`docs/archive/spec-pager.md` is deliberately NOT edited** — archived specs are frozen as-built records; this spec supersedes it, and `spec-pager-freeform` (still draft, and the accurate description of the shipped page) carries the pager's current contract | `docs/spec-offer-action-buttons.md`, `docs/spec-pager-freeform.md`, `README.md` | `npm run check:specs` | - |

## Rationale

An offered action is a *suggestion*, and the previous design treated a tap as
consent to send it verbatim. That is right when the suggestion is exactly what the
user wants and wrong the moment it is nearly right — which, for text the model
wrote, is common. Staging costs one keystroke and converts every offer into a
starting point. The pager differs only in where the text lands, because it has no
shared well; the rule is the same on both.
