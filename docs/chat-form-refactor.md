# chat-form refactor (R1 + R3)

**Status:** spec for review.
**Background:** Follow-up to `docs/chat-draft-refactor.md` (QW1+QW2+QW3+R2).
Postmortem: `docs/archive/chat-draft-postmortem.md`.

## Overview

The chat-draft refactor (QW1+QW2+QW3+R2) closes the specific bleed bug
and the most-likely class of regression. This spec covers the two
proper structural fixes the postmortem identified, scheduled here in
order so each pays back the cost of the previous and de-risks the next:

- **R1 — typed form-state store.** Replace the synthetic-input-event
  bus pattern entirely. The current code uses `dispatchEvent('input')`
  on the chat textarea as a side-effect signal that "options changed,
  recompute button state." Six remaining call sites use that idiom
  (see `docs/chat-draft-refactor.md` §"Remaining `dispatchEvent('input')`
  sites"). Replace with a typed publish/subscribe store; the input
  listener stays for *real* user input only.

- **R3 — per-view textarea.** Today one `<textarea>` lives in the
  shared footer (`public/index.html:90-106`) and serves both
  new-chat and chatting views. Every view transition is a manual
  save/restore around that mutable cell. Replace with two
  `<textarea>` elements, one per view, each owned by a per-view
  controller. The shared-cell race documented in the postmortem
  becomes structurally impossible.

Order matters: R1 first. After R1, the textarea's `input` listener
only fires for real user input. R3 can then split the textarea
without having to inventory every synthetic-input caller and
re-attach it to the right per-view textarea.

## Scope

In scope:

- R1: form-state store module, refactor of `setResponseOptions`,
  `updateButton`, `sessionTracker.onChange` subscriber, and the
  textarea `input` listener.
- R1: removal of `lastSeenInputValue` and `suppressNextInput` guards
  (now structurally unnecessary).
- R3: HTML restructure — two textareas under separate forms.
- R3: per-view controller for the chat input (`FormBinding` or
  similar; one instance per view).
- R3: per-textarea wiring for `setupMultilineInput`, slash/pound
  popups, paste handling, autoresize.
- R3: per-view draft binding lifecycle (replaces the single
  `activeBinding` field added by R2).

Out of scope:

- Any non-chat-input UI (session list, applet panel, footer
  context/usage, model selector).
- The chat-draft persistence backend (`src/chat-draft-store.ts`,
  routes, the per-key promise queue). Unchanged.
- Up-arrow recall and slash-command popup behaviour — these are
  user-driven and rewired per-textarea but their semantics don't
  change.
- The WebSocket applet-state bus.

## Goals

1. **Delete the synthetic-input-event bus.** Six remaining
   `dispatchEvent('input')` call sites on the chat textarea become
   typed store updates (or are removed entirely). The chat textarea's
   `input` listener fires only on real user gestures.
2. **Delete the shared chat-input DOM cell.** No code has to "save
   the textarea, then clear it, then restore it" around a transition.
3. **Make `lastSeenInputValue` and `suppressNextInput` dead code.**
   Both were defence against the architecture this refactor removes;
   when both root causes are gone, both guards can be deleted.
4. **Preserve every user-visible behaviour.** Drafts persist, send
   works, slash commands work, autoresize works, focus follows view
   transitions correctly.

## Use cases (unchanged from current)

Every user-visible behaviour stays the same:

- Type in session S1, switch to S2, switch back: S1 draft preserved.
- Type in new-chat, send: session created, newchat draft cleared.
- Type 5000 lines of code: textarea grows to MAX_HEIGHT, then scrolls.
- Slash command in new-chat: popup attaches to new-chat textarea.
- Paste large content: handled per-view.
- Up-arrow recall: per-session. `getLastInput()` (chat-view-
  controller.ts:609-613) reads `getActiveSessionId()` and returns
  the prompt/draft for that session; in newChat view the active
  session is null and up-arrow is a no-op. This matches the
  existing behaviour and is intentional — newChat has no "last
  input" until a message is sent (and at that point it becomes
  a session, where the per-session recall takes over). Per-newChat
  up-arrow recall is out of scope for this refactor.
- Reload mid-typing: last 0-1 s lost (debounce trade-off, unchanged).

## Design

### Phase R1 — typed form-state store

New module: `public/ts/form-state-store.ts`.

```ts
export interface FormState {
  options: readonly string[];  // response option buttons
  sessionBusy: boolean;        // active session is mid-dispatch
  hasText: boolean;            // textarea is non-empty (trimmed)
}

interface Internal {
  state: FormState;
  subscribers: Set<(s: FormState) => void>;
}

const internal: Internal = {
  state: { options: Object.freeze([]) as readonly string[], sessionBusy: false, hasText: false },
  subscribers: new Set(),
};

export const formStateStore = {
  get(): FormState { return internal.state; },

  set(partial: Partial<FormState>): void {
    let changed = false;
    let next = internal.state;
    for (const k of Object.keys(partial) as (keyof FormState)[]) {
      if (k === 'options') {
        const a = next.options, b = partial.options!;
        if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
          // Freeze the stored copy so subscribers cannot mutate it
          // in place (which would corrupt the no-op-on-unchanged
          // optimization on the next set).
          next = { ...next, options: Object.freeze(b.slice()) as readonly string[] };
          changed = true;
        }
      } else if (next[k] !== (partial as FormState)[k]) {
        next = { ...next, [k]: (partial as FormState)[k] };
        changed = true;
      }
    }
    if (changed) {
      internal.state = next;
      for (const fn of internal.subscribers) fn(internal.state);
    }
  },

  subscribe(fn: (s: FormState) => void): () => void {
    internal.subscribers.add(fn);
    return () => internal.subscribers.delete(fn);
  },
};
```

Properties:
- `options` is frozen on every store. Subscriber mutation throws in
  strict mode (default in TS modules). Compile-time `readonly`
  reinforces.
- Empty-set / no-op-set is silent (no subscriber call).
- New state object on every change (shallow); subscribers can use
  `===` for identity-based memoization.

Scope of "delete `dispatchEvent('input')`":

**Delete only synthetic-signal events** (no value change involved):

| Site | Action |
|---|---|
| `message-streaming.ts:53` (setResponseOptions) | already removed by QW1; deleted again here in spirit (the line was the wrong tool) |
| `message-streaming.ts:126` (session.idle) | already removed by QW1 |
| `sessionTracker.onChange` (~line 347) — currently calls `updateButton()` directly | becomes `formStateStore.set({sessionBusy: ...})` |

**Keep dispatchEvent at real value-set sites.** These follow a
genuine `textarea.value = X` write and the resulting `input` event
is semantically *real* — it must continue to drive autoresize and
slash/pound popup logic (`multiline-input.ts:68-72`). The
`formStateStore.set({hasText: ...})` update piggybacks via the
existing textarea `input` listener (which after R1 also sets
`hasText`). Sites that stay unchanged:

- `chat-view-controller.ts:102` (restoreDraft)
- `chat-view-controller.ts:251` (hydrateDraft)
- `chat-view-controller.ts:599` (restoreFailedPrompt)
- `multiline-input.ts:101` (up-arrow recall)
- `main.ts:162` (prompt-template apply)
- `message-streaming.ts:366` (dispatch-failure restore)

This reframing is critical: R1's value is *the typed store
replacing synthetic signals*, not *the elimination of every
dispatchEvent*. Synthetic signals are the postmortem's "DOM events
as an in-process event bus" smell; real-input events after a value
write are not.

Migration details:

- `setResponseOptions(options)` becomes a one-liner:
  `formStateStore.set({ options });`. No DOM access.
- `updateButton` is registered once at form init via
  `formStateStore.subscribe(updateButton)` AND keeps its existing
  textarea `input` listener registration. The listener path now
  also pushes `hasText` into the store (the subscriber re-runs
  but is idempotent).
- The textarea's `input` listener at `message-streaming.ts:344`
  is augmented to also `formStateStore.set({hasText: ...})`. This
  fires for BOTH real user input AND programmatic
  `dispatchEvent('input')` after a value-set — correct in both
  cases.
- `sessionTracker.onChange` subscriber pushes
  `{ sessionBusy: tracker.isBusy(activeId) }`.
- `currentOptions` module-let is removed entirely; reads go through
  `formStateStore.get().options`. Writes through
  `formStateStore.set({ options: ... })`.

After this phase: synthetic-signal events on the chat textarea are
gone. The `lastSeenInputValue` guard becomes structurally redundant
(no more synthetic signals to filter out) and is removed. The
`suppressNextInput` guard remains — it protects against the
`hasText` echo-from-restore path: `restoreDraft` sets the value AND
fires dispatchEvent AND the listener sets `hasText` AND the
subscriber runs `updateButton`. That last step is fine
(`updateButton` reads `hasText` from the store, which matches the
restored value). So `suppressNextInput` may also become removable;
verify by inspection during implementation.

### Phase R3 — per-view textarea (HTML split + per-form draft binding)

**Scope decision:** R3 V1 covers HTML split + per-form `DraftBinding`
ownership ONLY. Submit-handler relocation (currently in
`setupFormHandler`, 158 lines of dispatch / steerCount / chatRegion /
ws-handler init / setFormEnabled coupling) is deferred to R3.5. The
submit handler stays at module-scope and reads
`chatView.getActiveForm()` to find the right textarea. R3 V1 still
delivers the structural win: drafts are bound to per-form
controllers, no shared mutable cell.

HTML restructure (`public/index.html`):

Move the `<form id="chatForm">` and its descendants out of
`#chatFooter` and into each view container. Two forms:

```html
<div id="newChat" class="new-chat">
  ...
  <form id="newChatForm" class="chat-form" data-view="newChat" novalidate>
    <input type="hidden" name="imageData">
    <div class="input-bar">
      <textarea class="input-text" name="message"
                placeholder="Ask anything..." required autofocus rows="1"></textarea>
      <button type="submit" class="send-btn">Send</button>
      <button type="button" class="stop-btn">Stop</button>
    </div>
  </form>
</div>

<div id="chat" class="hidden">
  ... message list ...
  <form id="chattingForm" class="chat-form" data-view="chatting" novalidate>
    <input type="hidden" name="imageData">
    <div id="responseOptions" class="response-options" style="display:none"></div>
    <div class="input-bar">
      <textarea class="input-text" name="message"
                placeholder="Ask anything..." required autofocus rows="1"></textarea>
      <button type="submit" class="send-btn">Send</button>
      <button type="button" class="stop-btn">Stop</button>
    </div>
  </form>
</div>
```

Note: `#responseOptions` lives only in `chattingForm`. Response
options come from session activity; new-chat has no session yet, so
its responseOptions div would be dead DOM. Skipping the duplication.

`#chatFooter` post-refactor contains only `#adHocBar` and
`#contextFooter`. `adHocBar` stays where it is — it's session-scoped
(only meaningful in chatting view), and `image-paste.ts` references
it by id which keeps working. Spec calls this layout asymmetry out
explicitly so a future implementer doesn't "helpfully" duplicate the
adHocBar.

Per-form controller: new file `public/ts/chat-form-controller.ts`.

```ts
export class ChatFormController {
  readonly view: 'newChat' | 'chatting';
  readonly form: HTMLFormElement;
  readonly textarea: HTMLTextAreaElement;

  /** Per-view draft binding. Replaces ChatViewController.activeBinding
   *  (which is removed in R3 V1). */
  binding: { sessionId: string | null; key: string };

  /** Per-form debounce timer for the disk-side draft PUT/DELETE.
   *  Each form has its own timer; switching views does not race the
   *  prior form's timer. */
  private draftTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(form: HTMLFormElement, view: 'newChat' | 'chatting');

  /** Install input listener (drives store hasText + debounced draft
   *  write). Does NOT install the submit handler — that stays in
   *  message-streaming.ts setupFormHandler in R3 V1. */
  attach(): void;

  /** Rebind to a new session (or null for newchat). Flushes any pending
   *  debounce for the prior binding. Called by ChatViewController on
   *  view transitions. */
  bind(sessionId: string | null): void;

  /** Flush the pending debounce immediately (PUT or DELETE). Called by
   *  bind() and by send-time DELETE. */
  flushPending(): void;

  /** Send-path: cancel timer, enqueue DELETE through the per-key
   *  promise queue in chat-draft-api.ts. */
  clearOnSend(): void;
}
```

`ChatViewController` updates (R3 V1):

- The `activeBinding` field added by R2 is removed; replaced by
  `this.activeForm: ChatFormController` (set on view transitions).
- `setActiveBinding`, `flushPendingDraft`, `draftTimer`,
  `draftTimerKey`, `scheduleDraftWrite`, `cancelDraftTimer`,
  `onDraftInput` are removed from `ChatViewController` and re-
  implemented on `ChatFormController` (per-instance state).
- `showChat(sessionId, ...)` calls `this.chattingForm.bind(sessionId)`
  and sets `this.activeForm = this.chattingForm`.
- `showNewChat()` calls `this.newChatForm.bind(null)` and sets
  `this.activeForm = this.newChatForm`.
- `onNewSessionCreated(sessionId, ...)` calls
  `this.chattingForm.bind(sessionId)`, sets
  `this.activeForm = this.chattingForm`, and calls
  `void this.newChatForm.deleteDisk()` (the newchat draft is consumed).
- `sessionDrafts` Map stays on `ChatViewController` (open question
  #1 decided: shared cache for cross-form Map-hit). Both form
  controllers read/write the same Map via `chatView.getDraft(key)`
  and `chatView.setDraft(key, value)` helpers.
- A new `getActiveForm()` method returns
  `this.activeForm` so `setupFormHandler`, `setFormEnabled`, and
  the few `#chatForm` queries can find the current target.

Crucial property: at any moment, only one of the two forms is in the
visible DOM tree. Both still exist; both still have their own
`binding`, their own debounce timer, their own pending state.

After R3 V1: `lastSeenInputValue`, `suppressNextInput` (if still
present after R1), `activeBinding`, `currentDraftScope`'s
descendants — all gone. The textarea bleed bug is structurally
impossible because each textarea has its own listener-and-binding
pair, scoped to its own DOM subtree.

Wiring updates:
- `setupMultilineInput` becomes `setupMultilineInput(textarea, anchor)`
  taking explicit args, called per-form from each controller's
  `attach()`. Module-scoped popup state (`pickerPopup`) stays
  module-scoped — only one popup at a time, only one form visible at
  a time.
- The eight `document.querySelector('#chatForm ...')` callsites
  become either `this.activeForm?.textarea` (on `ChatViewController`)
  or `chatView.getActiveForm()?.textarea` (external callers like
  `setFormEnabled`).
- `setFormEnabled` in `view-controller.ts:65-79` queries
  `#chatForm` — that id no longer exists. Refactor to call
  `chatView.getActiveForm()?.form` (or move setFormEnabled to be a
  method on ChatViewController).

Paste / image upload: `image-paste.ts:18` uses a document-level
`paste` listener; works regardless of which textarea is active. No
per-form wiring needed. No drag-drop handlers exist on the textarea
today (the spec previously misdiagnosed this; corrected).

### Phase R3.5 — submit-handler relocation (deferred)

After R3 V1 ships and we live with two-textareas-one-handler for a
release, schedule R3.5 to move `setupFormHandler` into the
controllers. Requires:

- Module-private `chatRegion`, `registerWsHandlers`, `steerCount`
  remain at module scope (chatting-only; not duplicated).
- Each form gets a per-form submit handler that delegates the
  common send path (network dispatch, optimistic UI, response
  routing) into a shared `sendMessage(form, sessionId | null, text)`
  helper.
- `getActiveSessionId()` reads in the handler become
  `this.binding.sessionId` reads (forms don't reach back into the
  global).
- `setFormEnabled` becomes per-form (one form busy at a time, but
  the API takes a form arg).

Out of scope here; a future spec.

## Considerations

### Can we do R3 without R1?

Yes, technically — R3 splits the DOM and would defeat the bleed-bug
class on its own. But the synthetic-input-event idiom would still be
present, just split per-view. Each view's `setResponseOptions`
equivalent would still hack on `dispatchEvent('input')`. The R1
typed store is the right contract to pair with the per-view
controllers; without it, each new ChatFormController would inherit
the old pattern.

R1 standalone is also valuable: it deletes the bleed-bug trigger
entirely (not just routes around it). If R3 turns out to be more
expensive than the value warrants, R1 alone is shippable.

### Per-form store vs singleton store

**Decision:** singleton store, scoped to the chatting form only.
Response options, busy state, and the Send button only exist in
the chatting view. The new-chat view doesn't need a store (it has
no busy state, no response options; the Send button is local to its
own submit handler which reads `hasText` from its own textarea
directly). One store keeps the contract simple; per-form stores
would duplicate machinery for a degenerate case (new-chat would
never actually use its store).

This decision also resolves the spec's prior "factory vs singleton"
ambiguity: keep `formStateStore` as a module singleton from R1
through R3.

**Consequence:** `updateButton`'s store subscriber must guard on
`getViewState() === 'chatting'` before doing DOM work. When the
user is in newChat view, the store's values are stale for the
visible form (e.g. `hasText` may reflect prior chatting-textarea
state, `sessionBusy` may flip from a background session) and must
not be applied to the newChat form's DOM. Without this guard,
`updateButton` would toggle the wrong form's send button or
`busy` class. The plan enforces the guard at R3 V1 wiring time.

### What about the `currentOptions` module-level let in `message-streaming.ts`?

After R1, `currentOptions` moves into `formStateStore.state.options`.
The module-level let is deleted. Two known writes (lines 364, 438 in
addition to lines 50 and 124) all become `formStateStore.set({options: ...})`.

After R3, this is unchanged — singleton store, chatting-only.
`setResponseOptions(options)` stays as a module-level function in
`message-streaming.ts`.

### What about `sessionTracker.onChange`?

After R1, the subscriber that currently calls `updateButton()` from
`message-streaming.ts:347` becomes:

```ts
sessionTracker.onChange(() => {
  const id = getActiveSessionId();
  formStateStore.set({ sessionBusy: id ? sessionTracker.isBusy(id) : false });
});
```

After R3 unchanged — busy state is only meaningful for the chatting
form, and the chatting form's `updateButton` subscribes to the
singleton store.

### Focus management

Today, `setViewState('newChat')` calls `setFormEnabled(true)` which
focuses the textarea via `input?.focus()` (view-controller.ts:73-74)
and queries `#chatForm`. After R3, `setFormEnabled` becomes a
`ChatViewController` method that delegates to
`this.getActiveForm()?.textarea?.focus()`. The
`#chatForm`-based version in `view-controller.ts` is removed.

### Slash / pound popups

`setupMultilineInput()` registers handlers on the single textarea
today. After R3, called per-form with explicit args:
`setupMultilineInput(this.textarea, this.form.querySelector('.input-bar'))`.
The popup state (`pickerPopup`) stays module-scoped — only one
popup at a time, only one form visible at any moment.

### Paste, drag-and-drop, image upload

`image-paste.ts:18` attaches a document-level `paste` listener.
After R3, no change needed — document-level listeners survive any
DOM split. No drag-drop handlers on the chat textarea exist today.
(Session-panel has drag handlers but for the session list.)

The original spec misdiagnosed this; corrected.

### Test environment

Both phases require updated tests:

- R1: unit tests on `form-state-store.ts` (set/get/subscribe, no-op on
  unchanged value, multi-subscriber, unsubscribe).
- R1: update `chat-view-controller.test.ts` mocks to inject a fake
  formStateStore (or just import and reset between tests).
- R3: convert any test that drove `cvc` with a stub `getTextarea` to
  drive `chattingForm` / `newChatForm` directly. The existing tests
  using `internal.getTextarea = () => ({ value })` (chat-view-controller.test.ts:421-449)
  are good prototypes.
- R3: integration-style test that constructs both forms in jsdom,
  drives `showChat` then `showNewChat`, asserts the right form has
  visible class and the right form's binding is the active one.

## Risks and mitigations

1. **R1 breaks form-state plumbing across many call sites.** Eight or
   so files touch the form (`message-streaming.ts`,
   `chat-view-controller.ts`, `multiline-input.ts`, `main.ts`,
   `view-controller.ts`, plus tests). Mitigation: do R1 in one PR;
   the store is a single module with a tight surface; TypeScript
   surfaces every consumer.

2. **R1's store change-detection on arrays can be subtle.** Two
   distinct-but-equal arrays would trigger a notify (false-positive);
   subscribers mutating the returned array would corrupt the store
   (false-negative on next set). Mitigation: element-wise comparison
   on set AND `Object.freeze(b.slice())` on the stored copy. Strict-
   mode TypeScript modules throw on frozen-mutation in dev; runtime
   guards detect the bug class.

3. **R3 duplicates form HTML and CSS.** Two forms with the same
   structure means any future change to "the form" is done in two
   places. Mitigation: components are simple HTML; `responseOptions`
   is chatting-only (not duplicated), reducing the delta; if
   duplication becomes painful, extract a `<template>` and clone
   — but that's premature optimization for two instances.

4. **R3 changes focus / autoresize wiring.** Focus and autoresize
   are textarea-attached; per-form `attach()` re-registers them.
   Paste (`image-paste.ts`) is document-level — unaffected. No
   drag-drop handlers on the textarea exist today. Mitigation: per-
   form `ChatFormController.attach()` centralizes the textarea-
   attached wiring; document-level handlers don't move.

5. **R3 might miss a `#chatForm` querySelector.** Eight callsites
   today (grep `#chatForm` under `public/ts/`). Mitigation: replace
   all with `chatView.getActiveForm()?.form` or `?.textarea`.
   TypeScript catches the migration via the new method's typed
   return. Search-and-confirm at end of R3.

6. **The R3 controller-per-form might over-couple.** If
   `ChatFormController` ends up reaching into `ChatViewController`
   for session state, we've just relocated the problem. Mitigation:
   `ChatFormController` only knows its `binding` (set externally by
   `ChatViewController.bind(...)`); it does NOT read
   `getActiveSessionId()` or call into the view controller. The
   binding is push-only.

7. **R1's `suppressNextInput` guard may or may not become dead.**
   After R1, the synthetic-signal events on the chat textarea are
   gone. Restore-driven dispatchEvents remain (they're real value-
   changes). The guard's purpose was to filter restore-echoes from
   `onDraftInput`; the same effect is now achieved by the store's
   no-op-on-unchanged-value semantics (the restore writes the same
   `hasText` that the store already has). Verify by inspection
   during R1 implementation; if dead, remove. If still needed for
   the `lastSeenInputValue` reason, the latter is also kept.
   Status TBD until R1 is implemented.

8. **R3 breaks the existing single-textarea bundle of behaviours
   in subtle ways.** Image data upload (chatting-only, on the
   form's hidden field), working cursor, ad-hoc bar, stop button.
   Mitigation: live smoke test the full set; acceptance criteria
   below enumerate gestures to verify.

9. **R3.5 (submit-handler relocation) is deferred.** R3 V1 ships
   two textareas served by ONE module-scoped submit handler. The
   handler finds the right textarea via
   `chatView.getActiveForm()?.textarea`. This keeps R3 V1 tractable
   but leaves a `getActiveSessionId()` read in the submit handler
   (it's the chatting case in practice). Acceptable as a stepping
   stone; R3.5 will address it.

## Phasing

Each phase is its own PR. Each must build, test, and live-verify
green before the next starts.

**Phase 1 (R1, ~1-2 days):**
- New file `public/ts/form-state-store.ts` with `Object.freeze`-on-set.
- Replace synthetic-signal `dispatchEvent('input')` sites
  (`sessionTracker.onChange`'s direct `updateButton()` call) with
  store updates.
- KEEP `dispatchEvent('input')` at the six real-value-set sites
  (chat-view-controller, multiline-input, main.ts, message-streaming
  failure-restore) — they drive autoresize/popup/etc via the
  existing input listener.
- Add `formStateStore.set({hasText: ...})` to the textarea's input
  listener so the store stays in sync.
- Remove `currentOptions` module-let from `message-streaming.ts`
  (all four read/write sites at lines 39, 50, 124, 309, 335, 364, 438).
- Remove `lastSeenInputValue` (now dead, store handles dedup).
- Inspect `suppressNextInput` — remove if dead, else keep.
- Unit tests for the store; existing controller tests stay green.

**Phase 2 (R3 V1, ~2-3 days):**
- HTML restructure: two forms, responseOptions only in chatting.
- New file `public/ts/chat-form-controller.ts` with `bind`,
  `flushPending`, `clearOnSend`, debounce timer, input listener.
- Remove `activeBinding`, debounce timer, `onDraftInput`,
  `flushPendingDraft` from `ChatViewController`. Add `activeForm`
  field and `getActiveForm()` method.
- `setupMultilineInput` takes explicit `(textarea, anchor)` args,
  called per-form.
- `setFormEnabled` moves to `ChatViewController` and delegates to
  the active form.
- Replace `#chatForm` queries with `chatView.getActiveForm()`.
- Submit handler stays in `message-streaming.ts` (deferred to R3.5).
- Per-form unit + integration tests.

R1 alone is shippable; R3 V1 alone is possible but doesn't realize
the full benefit. Strongly prefer R1 → R3 V1 ordering.

## Acceptance

R1:
1. Zero *synthetic-signal* `dispatchEvent('input')` calls on the
   chat textarea remain. Specifically:
   `grep -rn "dispatchEvent.*input.*bubbles" public/ts/`
   shows: chat-view-controller restoreDraft/hydrateDraft/
   restoreFailedPrompt (real value-sets, kept); multiline-input
   up-arrow recall (real value-set, kept); main.ts prompt-template
   apply (real value-set, kept); message-streaming dispatch-failure
   restore (real value-set, kept); cwd-input sites unaffected. NO
   synthetic-signal sites from `setResponseOptions`,
   `session.idle`, or `sessionTracker.onChange`.
2. `currentOptions` module-let removed; reads via
   `formStateStore.get().options`; writes via
   `formStateStore.set({options: ...})`.
3. `npm run build` and `npx vitest --run` green.
4. `tests/unit/form-state-store.test.ts` exists and covers: no-op
   on unchanged value, subscriber invocation on change, frozen
   array mutation throws in strict mode, multi-subscriber broadcast,
   unsubscribe.
5. Live smoke: typing, send, stop, response-option buttons rendered,
   busy indicator, slash commands, up-arrow recall, multi-line
   draft restore retains correct height — all work as before.
6. Line count within ±20 of baseline. (Removed dead state offsets
   added store module.)

R3 V1:
1. Exactly two `<textarea name="message">` in `public/index.html`,
   one per view.
2. Exactly two instances of `ChatFormController` constructed at boot.
   Each owns its own textarea, debounce timer, binding.
3. `ChatViewController.activeBinding` field removed. `activeForm`
   added.
4. `setFormEnabled` and any other `#chatForm` querySelector either
   removed or rewritten to use `chatView.getActiveForm()`.
5. Live smoke: every interactive gesture across both views works:
   focus follows view switch, paste, image upload via paste,
   slash/pound popups, autoresize, stop button, response options
   (chatting only), send via Enter, Shift+Enter newline, up-arrow
   recall per-view.
6. Bleed-bug regression test from Phase 1 either still passes against
   the new architecture, or is replaced with a per-form equivalent
   that is structurally impossible to fail (the per-form input
   listener cannot route to the wrong key because each listener
   knows its form's binding at registration time).

## Open questions

None remaining. All prior open questions resolved in §Design:

- ~~Q1: single sessionDrafts Map vs per-form draft state~~ →
  decided: Map stays on `ChatViewController`; both forms read/write
  via `chatView.getDraft/setDraft` helpers.
- ~~Q2: where does the submit handler live~~ → decided: stays at
  module scope in `message-streaming.ts` for R3 V1; relocation
  deferred to R3.5.

