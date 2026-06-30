# R3.5 — relocate per-form behaviour off module globals

**Status:** spec for review.
**Background:** R3 V1 shipped per-form `ChatFormController` instances
but deliberately left several module-level singletons in
`message-streaming.ts`, `multiline-input.ts`, and `image-paste.ts`
as "deferred." This week we hit three regressions of the same class
(two-textareas CSS, popup-wrong-textarea, popup-rebind defensive
guard) because those globals retroactively caught the second
instance R3 introduced.

R3.5 finishes the job: move the deferred per-form behaviour onto
the per-form controller (or a per-form auxiliary), eliminate the
"first caller wins, singleton wrong forever" hazard for popups, and
correctly scope steerCount + chatRegion + image state to the
chatting form.

Prerequisite reading: `chat-form-refactor.md` (R3 V1 spec),
`docs/archive/chat-draft-postmortem.md` (root-cause analysis).

## Goal

After R3.5, no module-level mutable in the chat-input layer holds
state that is conceptually per-form. The defensive hacks shipped
during R3 V1 (the `slashPopupBoundTo` / `poundPopupBoundTo`
textarea guards, the `getActiveForm()`-at-event-time hops in
`updateButton`/`wireFormSubmit`) collapse away when each form owns
its own popups, its own submit handler, and its own steer counter.

The visible behaviour is unchanged. The bug class — "second form
introduced, module-singleton captures wrong instance" — becomes
structurally impossible.

## Scope

In scope (each gets its own implementation section below):

- **R3.5a** — Lift the slash, pound, and picker popups off module
  scope. `ChatFormController` owns its own popup trio (or a single
  `FormPopups` helper instance per form).
- **R3.5b** — Move `steerCount` and the submit-handler core onto
  `ChatFormController`. The shared `sendMessage(form, opts)` helper
  stays at module scope for the network/streaming layer; per-form
  state moves.
- **R3.5c** — Move `chatRegion` ownership out of `setupFormHandler`.
  It is initialized once at boot in `main.ts` (or by
  `ChatViewController`) and accessed via a getter / DI. Becomes
  conceptually a global because there is only one `#chat`, but
  initialized exactly once at the right moment.
- **R3.5d** — Per-form `imageData` input. Move `image-paste.ts`'s
  hidden-input write to the *active form*'s input rather than
  `document.getElementById('imageData')`. Optionally, scope `images`
  state to the chatting session (clear on session-switch).
- **R3.5e** — Delete the defensive guards that R3 V1 + this week
  added: `slashPopupBoundTo`, `poundPopupBoundTo`,
  `getActiveForm()`-per-event lookups in `wireFormSubmit`/`updateButton`,
  the explicit isViewState guard in `updateButton` (per-form
  ownership eliminates the cross-view confusion that motivated it).

Out of scope:

- `formStateStore` shape changes. R1's singleton store is correct
  for chatting-only state and stays as-is. R3.5d's per-form
  imageData doesn't need a store.
- `sessionDrafts` Map on ChatViewController. The shared cache stays
  shared (sessions are shared concepts; per-form access via
  `getDraftCache`/`setDraftCache` is already correct).
- Slash/pound popup VISUAL design or trigger semantics. We're
  relocating ownership, not changing behaviour.
- File-cache (`cachedFiles` in `multiline-input.ts`). It's
  intentionally cross-form (cwd-keyed) and correct.
- `formStateStore`'s `sessionBusy` / `options` / `hasText` semantics.
  Unchanged.

## Non-goals

- Eliminating every module-level constant. `MAX_HEIGHT`,
  `MAX_IMAGES`, `SEND_TIMEOUT_MS`, `poundProviders` (an append-only
  registry) all stay where they are.

## Use cases (unchanged)

Same behaviour as R3 V1:
- Slash command in newchat / chatting works in either.
- Pound completion same.
- Sending steers a busy chatting session; steerCount drives the
  Stop button label.
- Image paste in chatting (newchat ignores).
- Send button enables/disables based on text + busy state.

## Design

### R3.5a — per-form popups

New file: `public/ts/chat-form-popups.ts`. One `FormPopups` class
per form, owned by `ChatFormController`.

```ts
export class FormPopups {
  readonly textarea: HTMLTextAreaElement;
  readonly anchor: HTMLElement;
  private slash: InputPopup | null = null;
  private pound: InputPopup | null = null;
  private picker: InputPopup | null = null;
  private poundAnchorPos = -1;
  private pendingPickerCmd: string | null = null;

  constructor(textarea: HTMLTextAreaElement, anchor: HTMLElement);

  /** Install input + keydown listeners. Called once by the form
   *  controller. */
  attach(): void;

  /** Trigger inspection — public so the controller can ask
   *  "is a popup currently visible?" for Enter handling. */
  isAnyVisible(): boolean;

  /** Open a slash-command picker (called from the controller's
   *  `tryExecuteSlashCommand` when the user typed `/cmd<enter>`
   *  with no args). FormPopups owns the lookup of the command
   *  registry — it calls `findCommand(cmdName)` and `cmd.picker()`
   *  itself, then renders the items in `this.picker`. The
   *  `onDismiss` callback restores `/cmdName ` into `this.textarea`.
   *  Controller-side callers only pass the command name. */
  openPicker(cmdName: string): Promise<void>;

  /** Forward a keydown event to whichever popup is visible. Returns
   *  true if the popup consumed the event. */
  handleKey(e: KeyboardEvent): boolean;
}
```

`ChatFormController.attach()` constructs `this.popups = new FormPopups(this.textarea, this.form.querySelector('.input-bar'))` and calls `this.popups.attach()`. The controller's keydown handler defers popup-key handling to `this.popups.handleKey(e)` if a popup is visible (Enter / arrows / Escape).

`multiline-input.ts` becomes a thin shell:
- `setupMultilineInput` deleted (replaced by per-form `attach()`).
- `autoResize` stays (utility used by both `FormPopups` and the
  controller).
- `resetTextareaHeight` MOVES into `ChatFormController` as a method
  (per R3.5e). The one external caller in `view-controller.ts:108`
  becomes `chatView.getActiveForm()?.resetTextareaHeight()`.
- `tryExecuteSlashCommand` MOVES onto `ChatFormController` (so it
  has direct access to `this.popups.openPicker`).
- `registerPoundProvider` stays as a module-level append-only
  registry — popup instances read it on each show. Both per-form
  `FormPopups` instances share the same registry (correct;
  extensions don't know about per-form scoping).

Consequence: `slashPopup`, `poundPopup`, `pickerPopup`,
`poundAnchorPos`, `slashPopupBoundTo`, `poundPopupBoundTo`,
`_pendingPickerCmd` ALL get deleted from `multiline-input.ts`.
File goes from ~280 lines to ~50.

### R3.5b — per-form submit handler + steerCount

`message-streaming.ts` currently has `wireFormSubmit(form, updateButton)`
called for each form (`message-streaming.ts:372-477`). That helper is
~80 lines of submit logic with shared closures over module-level
`steerCount` and `submitting`.

**Concrete split** (each line in current `wireFormSubmit` placed
explicitly):

Stays at module scope (network / cross-form logic):
```ts
// message-streaming.ts (module scope)
export async function dispatchPrompt(args: {
  message: string;
  imageData: string;
  newChat: boolean;
  cwd?: string;
}): Promise<void> {
  const model = getSelectedModel();
  void streamResponse(args.message, model, args.imageData, args.newChat, args.cwd);
  // No await — streamResponse is fire-and-forget; the controller
  // resets its own submit state on its own schedule.
}

export async function dispatchSteer(sessionId: string, message: string): Promise<Response> {
  return fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: message, mode: 'immediate' })
  });
}
```

`tryExecuteSlashCommand` MOVES onto `ChatFormController` (per R3.5a;
clarifying the earlier ambiguity — R3.5a's reference to moving it
onto the controller is canonical, R3.5b does NOT keep it at module
scope).

Moves onto `ChatFormController` (per-form state + handler):
- `steerCount: number` (chatting only ever increments it; newchat's
  stays 0; harmless)
- `submitting: boolean`
- `handleSubmit(e)` — composes `this.tryExecuteSlashCommand`,
  `dispatchSteer` (with `this.steerCount++` + `this.refreshButton()`),
  `dispatchPrompt`, `this.refreshButton()`,
  `this.resetTextareaHeight()`, `removeImage()`, etc.
- `refreshButton()` — reads
  `formStateStore.get()` (chatting only — see subscription gating
  below); reads `this.textarea.value`; toggles
  `this.form.querySelector('.send-btn|.stop-btn|#responseOptions')`.
- The stop-button click listener (calls `/cancel` API) on the
  chatting form only (newchat has no session to cancel).
- The responseOptions click listener on the chatting form only
  (newchat has no options).

Stays at module scope (already correct):
- `streamResponse`, `setResponseOptions`, `setupFormHandler`'s
  `chatRegion`+ws init (moves to R3.5c), `formStateStore.subscribe`
  → forwards to the chatting form's `refreshButton`.

Sub-step: in `ChatFormController.attach()` for chatting only, do
`formStateStore.subscribe(() => this.refreshButton())`. NewChat's
form never subscribes. This deletes the `isViewState('chatting')`
guard at `message-streaming.ts:305`.

Caller migration:
- `message-streaming.ts:166-168` (busy-state push from
  `sessionTracker.onChange`) STAYS at module scope as a one-time
  subscription set up in `initMessageStreaming()` (per R3.5c). The
  store push is global; the chatting form's `refreshButton`
  reacts via the store subscription.

`submitting` and `steerCount` go from module-level mutables to
instance fields; no caller outside the controller reads them.

### R3.5c — chatRegion at boot

Currently `chatRegion` is initialized inside `setupFormHandler` as a
side effect. The chat region is conceptually one global object
(there is one `#chat` div). Move initialization to `main.ts` (or
`ChatViewController.init()`):

```ts
// message-streaming.ts (module scope)
export const chatRegion: ChatRegion = createChatRegion(regions.chat);

export function initMessageStreaming(): void {
  chatRegion.setupClickHandler();
  registerWsHandlers();
  sessionTracker.onChange(() => {
    const id = getActiveSessionId();
    const busy = id ? (sessionTracker.get(id)?.busy ?? false) : false;
    formStateStore.set({ sessionBusy: busy });
  });
}
```

`createChatRegion` constructs and returns the `ChatRegion`
instance. The `export const` form means `chatRegion` is initialized
exactly once at module-load time and is never undefined. The
existing `let chatRegion: ChatRegion;` declaration is REMOVED;
callers (`message-streaming.ts:68, 105, 106, 136, 154`) continue
to read it identically.

**Boot order in `main.ts`** (mandated, with a comment in main.ts
calling out the invariant):

```ts
// 1. Region registry (must be first — chatRegion depends on it)
initRegions();
// 2. View state from DOM
initViewState();
// 3. Module-streaming wiring: chatRegion is already initialized at
//    module-load; this hooks click handler + WS handlers + tracker.
initMessageStreaming();
// 4. Per-form controllers (need chatRegion to exist before any
//    WS event could be dispatched into the chat region)
const newChatForm = new ChatFormController(...);
const chattingForm = new ChatFormController(...);
chatView.bindForms({ newChat: newChatForm, chatting: chattingForm });
newChatForm.attach();
chattingForm.attach();
// 5. NOW connect the WebSocket — handlers were registered in step 3
connectWs();
```

The current main.ts ordering already has `setupFormHandler` before
`connectWs`; R3.5c preserves that invariant explicitly. The risk
the spec must address: if `createChatRegion(regions.chat)` runs
before `initRegions()` populates the regions registry, it crashes
or gets a stale reference. Solution: keep `createChatRegion` as a
function that runs at `initMessageStreaming()` time rather than a
top-level `export const`, OR document `initRegions()` as the
required prerequisite for importing this module's exports.

Pragmatic choice: `let chatRegion: ChatRegion;` stays as a typed
module field, but is assigned at the top of `initMessageStreaming()`
(line 1 of the function body). Callers still read it via
`chatRegion.foo` since it's set before any caller runs (because
all callers are dispatched from `registerWsHandlers`, which runs
on the same line). This is the *let* form but with a clear
invariant — initialized exactly once, exactly in
`initMessageStreaming`, exactly once at boot. The "or const" wording
from the prior draft is REMOVED.

Audit notes for the implementer:
1. `ChatViewController.activateSession`
   (`chat-view-controller.ts:149`) and the `sessionTracker.onChange`
   subscriber registered in `initMessageStreaming()` must not run
   before `initMessageStreaming()` itself. Today this is true
   because both are triggered by either user gesture (post-DOM-load)
   or WS events (post-connectWs). Add an inline comment in main.ts
   step 3 calling out the invariant.
2. `setupFormHandler` becomes a thin function that wires per-form
   submit/stop/responseOptions handlers on each form. With R3.5b
   moving the submit handler into ChatFormController.attach(),
   `setupFormHandler` may go away entirely. Verify: if no callers
   need it after R3.5b, delete it.

### R3.5d — per-form imageData input (Option B)

Today: only `chattingForm` has `<input type="hidden" id="imageData">`.
`image-paste.ts:syncHiddenInput` writes to
`document.getElementById('imageData')` — a module-global DOM lookup
that finds the chatting form's input by id-uniqueness. This is
exactly the writer-side pattern the spec's thesis exists to
eliminate: any future second `imageData` input (third form, test
fixture, templating change) silently writes to the wrong one.

Adopt **Option B**:

- HTML: each form gets `<input type="hidden" name="imageData">`
  (no `id`). NewChat's input always stays empty (no paste handler
  attaches to newchat).
- `image-paste.ts` writes via
  `chatView.getActiveForm()?.form.querySelector('input[name="imageData"]')`.
  Better: have the chatting `ChatFormController` expose its own
  imageData input as `chattingForm.imageDataInput` set at attach
  time; image-paste reads it via `chatView.getChattingForm()?.imageDataInput`.
  Avoids any document-wide query.
- The submit handler reads via `form.querySelector('input[name="imageData"]')`
  (already done in R3 V1's BLOCKER fix; unchanged).

ALSO add an explicit session-switch clear (orthogonal to Option B
— addresses a different bug, image leaking across session switches
inside chatting view):

- Hook into `chatView.onSessionChange` (or
  `sessionTracker.onChange`) to call `removeImage()` when the
  active session changes. Guard against null→id transitions so the
  initial session activation doesn't clear before-paste images.

After R3.5d: `image-paste.ts:syncHiddenInput`'s
`getElementById('imageData')` is REPLACED, not retained. R3.5e's
guard-deletion list includes this writer-side global lookup.

`image-paste.ts:14-15`'s module-level `widgetHandle` and
`widgetSessionId` STAY — they represent the single ad-hoc bar
widget per active session, which is fundamentally a global UI
concept (one bar at a time, one active session at a time).

### R3.5e — delete defensive guards

After R3.5a-d:
- `slashPopupBoundTo`, `poundPopupBoundTo` (added this week) —
  DELETE. Per-form popups can't be misbound.
- `if (slashPopup) slashPopup.hide()` rebuild branch (added this
  week) — DELETE. Same reason.
- `if (!isViewState('chatting')) return` in `updateButton`
  (`message-streaming.ts:305`) — DELETE. Only the chatting form's
  `refreshButton` subscribes to the store.
- `chatView.getActiveForm()?.form.querySelector(...)` lookups
  inside `wireFormSubmit`/`updateButton` — REPLACE with
  `this.form.*` on the controller (mechanical after R3.5b moves
  the handlers onto ChatFormController).
- `let pickerPopup`, `let _pendingPickerCmd` in
  `multiline-input.ts` — DELETE (per-form on `FormPopups`).
- **`image-paste.ts:syncHiddenInput`'s
  `getElementById('imageData')`** — REPLACED via R3.5d's per-form
  controller reference.
- **`resetTextareaHeight` in `multiline-input.ts`** (currently calls
  `chatView.getActiveForm()?.textarea`) — DELETE. Move into
  `ChatFormController` as a method; submit-path callers (5 sites
  in `message-streaming.ts`'s steer/send branches, which move to
  the controller via R3.5b) call `this.resetTextareaHeight()`
  directly. The one external caller in `view-controller.ts:108`
  (`setViewState('newChat')` path) becomes
  `chatView.getActiveForm()?.resetTextareaHeight()`.

## Considerations

### Why now vs later

Three regressions in one week, all the same root cause. The
defensive patches we shipped this week are working — but they add
local complexity (boundTo guards, viewState checks, query-at-event-
time lookups) to compensate for the wrong ownership. Each defensive
patch is ~5-15 lines; the R3.5 refactor deletes more lines than it
adds (estimate net −80 lines once popups + steerCount + submit
handler move).

### Risks of R3.5

The R3 V1 split was the structural change. R3.5 is mostly
mechanical lifting onto an existing class. Risk lower than R3 V1.

**Risk 1**: per-form popups duplicate state. Two `slashPopup`
instances exist (one on each form's `FormPopups`). Costs ~negligible
DOM (popups are lazily created on first trigger; newchat's may
never be created). Benefit: insertion lands in the right textarea
by construction.

**Risk 2**: `tryExecuteSlashCommand` moves from module function to
controller method. Callers (currently: only the submit handler in
`message-streaming.ts`) need updating. With the submit handler
also moving to the controller per R3.5b, the call site becomes
`this.tryExecuteSlashCommand(message)` — local. Coupled migration.

**Risk 3**: chatRegion init moving to boot might run before
`#chat` exists in DOM. Mitigate by calling `initMessageStreaming()`
after DOM-ready in `main.ts` (which is where `setupFormHandler` is
called today — same timing).

**Risk 4**: per-form `steerCount` means the stop button on the
newChat form never shows "(N)" steers. Correct — newchat doesn't
steer. Behaviour unchanged.

**Risk 5**: image-paste session-clear (R3.5d). If we add a
`session-state-tracker.onChange` hook that clears `images` when
the active session changes, we need to be careful not to clear
during in-flight paste-then-send (the send handler is what triggers
the implicit session activation for new chats). Mitigate by only
clearing when the *new* session ID differs from the prior tracked
one (not on null-to-id transitions).

### Backwards compatibility

No URL routes, persistence formats, or external APIs change. The
applet-state shape stays the same. Existing tests for
`ChatFormController` and `formStateStore` need updates to cover the
new per-form popups / submit handler.

## Acceptance

1. `npm run build` and `npx vitest --run` green with no new
   warnings.
2. `grep -rn "slashPopupBoundTo\|poundPopupBoundTo" public/ts/`
   returns zero matches.
3. `grep -rn "!isViewState('chatting')" public/ts/message-streaming.ts`
   returns zero matches in `updateButton`'s body.
4. `multiline-input.ts` is reduced to ≤80 lines (currently ~280,
   target after popup extraction).
5. Live smoke:
   - Slash command works in both forms.
   - Pound completion works in both forms.
   - Slash picker (`/cmd` with picker) works in both.
   - Steering a chatting session shows "(N)" on Stop in chatting
     form only.
   - Paste image in chatting → image renders in adHocBar. Switch
     to newchat → paste does nothing (no widget). Switch back to a
     different session → previous session's images do not leak in.
   - Send via Enter, Shift+Enter newline, response-option click,
     up-arrow recall — all work in both forms.
6. Updated tests with named cases for the regressions this week:

   `tests/unit/chat-form-popups.test.ts` (NEW):
   - **popup-wrong-textarea**: open slash popup in form A's textarea
     (selection happens via mousedown on a popup item); switch to
     form B's textarea and re-trigger; assert the second selection's
     `onSelect` callback inserts into form B's textarea, never form
     A's. Pre-R3.5 this fails (closure captured A's textarea).
   - **defensive-rebind unnecessary**: each `FormPopups` instance
     owns its own popups; trigger in A then trigger in B; assert
     two distinct popup DOM elements exist (or that re-trigger on
     the same instance reuses the same DOM node — implementation
     choice; the test asserts WHICH behaviour is structural).
   - **picker external trigger**: call
     `formPopups.openPicker('test-cmd')` directly; assert items
     load via `findCommand('test-cmd').picker()` and a selection
     inserts `/test-cmd id ` into the bound textarea.
   - **Escape closes popup, leaves textarea intact**.
   - **`registerPoundProvider` items appear in both forms' pound
     popups** (provider is shared, not per-form).

   `tests/unit/chat-form-controller.test.ts` (ADD):
   - **per-form steerCount isolation** (R3.5b): construct two
     `ChatFormController` instances; call chatting's
     `dispatchSteer` path so its `steerCount` increments; assert
     newchat's `refreshButton` does not render `(N)`.
   - **refreshButton store-gating** (R3.5b): subscribe to the
     singleton store from the chatting form; push
     `{options: ['x']}` to the store; assert chatting's
     `#responseOptions` renders 'x' but newchat's does not (newchat
     never subscribed).
   - **imageData isolation** (R3.5d): set chatting form's
     `imageData` input value via `image-paste` simulation; submit
     newchat form; assert the streamResponse call (mock) receives
     `imageData: ''`.

   `tests/unit/css-regression.test.ts` (NEW — for the
   two-textareas CSS bug class):
   - **two-textareas-CSS regression**: load `index.html` + `style.css`
     in jsdom; toggle `hidden` on `chattingForm`; assert
     `getComputedStyle(chattingForm).display === 'none'`. This
     catches the bare `form { display: flex }` regression and any
     future selector that would override `[hidden]`.
   - **bare-tag-selector audit**: enumerate the known tag selectors
     that are intentionally global (`button`, `h1`, etc.) and
     assert no NEW bare-tag selector matches `.chat-form` or its
     descendants. (Optional; this is more a lint than a test.)

7. Net line count negative (target: -50 to -100 lines).

## Open questions

None — design follows R3 V1's pattern (move per-form state onto
ChatFormController). All ambiguities resolved by treating it as
mechanical relocation.
