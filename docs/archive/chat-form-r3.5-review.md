# R3.5 spec review

Reviewer: independent agent. Scope: `chat-form-r3.5.md` against
the current tree (`public/ts/multiline-input.ts`,
`public/ts/message-streaming.ts`, `public/ts/chat-form-controller.ts`,
`public/ts/image-paste.ts`, `public/ts/main.ts`,
`public/ts/extension-api.ts`).

Verdict: the structural thesis (lift per-form state off module
globals) is correct and well-motivated by the three regressions this
week. Three sections of the spec need substantive revision before
implementation. Several others need clarification.

## BLOCKERS

### B1 — R3.5d Option A contradicts the spec's own thesis

`chat-form-r3.5.md:236-243` recommends Option A: leave
`image-paste.ts:syncHiddenInput` (`image-paste.ts:119-122`) doing
`document.getElementById('imageData')`, and add a session-switch
clear.

The spec's stated goal (`chat-form-r3.5.md:22-32`): "no
module-level mutable in the chat-input layer holds state that is
conceptually per-form … the bug class — 'second form introduced,
module-singleton captures wrong instance' — becomes structurally
impossible."

Option A keeps exactly that pattern on the *writer* side. The reader
side was patched in R3 V1 by switching the submit handler to
`form.querySelector('input[name="imageData"]')`
(`message-streaming.ts:456`). The writer is still
`getElementById('imageData')`, which finds the chatting form's input
by id-uniqueness — an HTML invariant, not a structural guarantee.
The day someone adds a second `imageData` input (e.g. a future
third form, a templating change, a test fixture that mounts both
forms in isolation) the writer silently writes to the wrong one and
we have regression #4 of the same class.

The motivation paragraph in R3.5d ("image paste is chatting-only by
product design") is the same shape of argument R3 V1 used to defer
the popup globals — "only one form is active at a time, it's fine"
— and that reasoning is what produced the three regressions R3.5
exists to prevent.

Required change: recommend **Option B**, with the writer routing
through `chatView.getActiveForm()?.form.querySelector('input[name="imageData"]')`
or (better) holding a direct reference set by the chatting form's
controller at attach time. Drop the id attribute; use `name=` only.
The session-switch clear from Option A is still wanted on top of
Option B (it addresses a different bug — image leaking across
session switches — not the wrong-form bug).

If Option A really is preferred (e.g. for landing-size reasons),
the spec must acknowledge explicitly that R3.5d is leaving one
known instance of the structurally-impossible-after-R3.5 invariant
violation in place, and file the follow-up.

### B2 — R3.5b boundary is unspecified

`chat-form-r3.5.md:143-169` says "the shared
network/streaming logic — `streamResponse`, `tryExecuteSlashCommand`,
`setResponseOptions`, the busy-state push — stays at module scope.
Only the form-specific state (steerCount, submitting, button
toggling) moves."

Walking the actual 80 lines of `wireFormSubmit`
(`message-streaming.ts:372-477`) against that statement, the
classification is ambiguous for several blocks:

| Block | Lines | Per-form? | Module? | Spec says |
|---|---|---|---|---|
| stop-button click → cancel API | 375-380 | per-form (button ref) | logic is global | unclear |
| responseOptions click handler | 382-394 | per-form (container + textarea) | `formStateStore.set` is global | unclear |
| `submitting` guard | 396, 400 | per-form | — | "moves" ✓ |
| slash dispatch + reset | 408-415 | calls global `tryExecuteSlashCommand` + `resetTextareaHeight` | — | spec also moves `tryExecuteSlashCommand` per R3.5a, contradicting "stays at module scope" |
| steer branch | 419-449 | per-form (steerCount, input, submitting) | fetch + showToast are global | "moves" ✓ |
| isNewChat / cwd composition | 451-464 | reads global `getNewChatCwd`/`isViewState` | — | unclear |
| `chatView.setFormEnabled(false)` | 466 | global | — | "stays" implicit |
| `removeImage()` | 473 | global writer (image-paste) | — | unclear; tied to B1 |
| `streamResponse(...)` | 475 | module | — | "stays" ✓ |

Without an explicit line-by-line split in the spec, the implementer
will guess. The risk is that they leave too much in the module
function and re-create the cross-form coupling, or they move too
much and lose the shared streaming abstraction.

Required change: replace the prose in `R3.5b` with a concrete
target signature for what stays at module scope, e.g.

```ts
// message-streaming.ts (module scope)
export async function dispatchPrompt(opts: {
  message: string;
  imageData: string;
  newChat: boolean;
  cwd?: string;
}): Promise<void> { ... }   // wraps streamResponse + setHasImage cleanup

export async function dispatchSteer(sessionId: string, message: string): Promise<Response> { ... }
```

…and state that `ChatFormController.handleSubmit` composes these
plus its own `steerCount`/`submitting`/`refreshButton` calls. Then
the spec is unambiguous.

Also note: the spec's R3.5a moves `tryExecuteSlashCommand` to the
controller (`chat-form-r3.5.md:132-136`), but R3.5b lists it
under "stays at module scope" (`chat-form-r3.5.md:167`). Pick
one. Per-controller is right (it needs `this.popups.openPicker` —
see Q6 below).

### B3 — R3.5c boot order under-specified; existing init-race carries over

Spec (`chat-form-r3.5.md:198-217`) says "Move initialization
to `main.ts` (or `ChatViewController.init()`)" and "Mitigate by
calling `initMessageStreaming()` after DOM-ready in `main.ts`
(which is where `setupFormHandler` is called today — same timing)."

That is necessary but not sufficient. Today, `setupFormHandler`
(`main.ts:153`) runs at a specific point in the DOMContentLoaded
sequence; `chatRegion` is `let`-declared at module scope
(`message-streaming.ts:38`) and assigned only inside
`setupFormHandler`. Any of `chatRegion.removeThinking()`,
`removeStreamingCursors()`, `finalizeReasoning()`, `renderEvent()`
called by `handleEvent` between WS connect and `setupFormHandler`
running would throw `Cannot read properties of undefined`. Today
this works because `connectWs` is called after `setupFormHandler`
in main.ts — but that's an implicit invariant, not enforced.

R3.5c moves `chatRegion` init out of the form layer. The spec
must:

1. State explicitly that `initMessageStreaming()` MUST run before
   `connectWs()` / `waitForConnect()`, and add an assertion or
   an explicit ordered-init comment in `main.ts`.
2. Prefer the `export const chatRegion = createChatRegion()` form
   (the spec lists this as optional at line 215). With `const` and
   eager init, the unreachable-before-boot crash class disappears.
   The "or stays a `let`" alternative is strictly worse and should
   be removed.
3. Audit `ChatViewController.activateSession`
   (`chat-view-controller.ts:149`) and the
   `sessionTracker.onChange` subscriber it triggers to confirm
   nothing touches `chatRegion` before `initMessageStreaming()`
   could plausibly have run. (Today: `activateSession` is awaited
   from router/applet code paths that all post-date
   `setupFormHandler`. After R3.5c, ChatViewController is
   constructed at module-load — verify it does not eagerly touch
   `chatRegion`. It currently does not, but the spec should
   document the invariant.)

Required change: in R3.5c, add a "Boot order" subsection with the
exact `main.ts` sequence (initRegions → initMessageStreaming →
form controllers attach → connectWs), and mandate `const` over
`let` for chatRegion.

## IMPORTANT

### I1 — FormPopups wrapper is the right call, but the picker external-trigger path needs spelling out

Q1 (FormPopups vs three separate). The wrapper is justified: all
three share `(textarea, anchor)`, all three need the same input +
keydown install, and all three need `isAnyVisible()` for Enter
gating (`multiline-input.ts:79-89`). Three classes would triplicate
that boilerplate inside `ChatFormController`. Wrapper is not
premature — it has a single coherent responsibility ("popup trio
attached to one textarea") and the interface in
`chat-form-r3.5.md:99-122` is small. Keep it.

Q6 (picker external trigger). After R3.5b moves the submit handler
onto the controller, the picker invocation path becomes:

```
ChatFormController.handleSubmit
  → this.tryExecuteSlashCommand(message)
    → if (cmd.picker && !args.trim()) this.popups.openPicker(cmd.name)
```

The spec lists `openPicker(cmdName: string): Promise<void>` on
FormPopups but doesn't say how FormPopups gets the `items` list.
Currently `tryExecuteSlashCommand` calls `cmd.picker()`
(`multiline-input.ts:247`). Either:
  - FormPopups does `findCommand(cmdName)` itself and calls
    `cmd.picker()` — cleaner, and FormPopups already knows about
    the command registry conceptually.
  - The controller passes the items in:
    `openPicker(cmdName, items)`.

Spec should pick one. The first is preferred (keeps the controller
thin and lets `openPicker` own the popup lifecycle including
`onDismiss` restoring `/cmdName ` into `this.textarea`).

### I2 — Test cases must enumerate the three regressions

Q9. Spec (`chat-form-r3.5.md:341-343`) says "new
`chat-form-popups.test.ts` covers the trio of popups (mirror of
existing pound/slash tests if any — currently none; add coverage)."
That's not enough. The whole motivation of R3.5 is that these three
specific bug shapes recurred. The test list should enumerate them
as named cases so a future regression has a named, owned test:

1. **two-textareas-CSS**: when both forms exist in the DOM, only
   the active form's textarea receives autoresize; the inactive
   form's textarea does not mutate height when the active one
   resizes. (Failure mode this week: shared `autoResize` triggered
   on wrong textarea.)
2. **popup-wrong-textarea**: trigger slash popup in form A, switch
   to form B, type `/`, select an item — insertion lands in B's
   textarea, not A's. (Failure mode this week: closure-captured
   textarea was form A's.)
3. **defensive-rebind**: trigger slash popup in form A's textarea
   without dismissing, then trigger it again from form B's
   textarea — second trigger rebinds (or A and B each own
   independent popup instances and B's instance fires; either is
   acceptable structurally, but the test must assert which).
4. **per-form steerCount isolation** (R3.5b): increment chatting's
   steerCount via steer, assert newchat's stop button label
   unaffected.
5. **per-form refreshButton gating** (R3.5b): store change for
   `options: ['x']` only updates the chatting form's
   `#responseOptions`, not newchat's.
6. **imageData isolation** (R3.5d, regardless of A/B): paste image
   in chatting, submit newchat — newchat POST body has empty
   `imageData`.

Required change: replace `chat-form-r3.5.md:341-343` with the
above enumeration.

### I3 — R3.5e: one guard removal is conditional on B1

Guards listed for deletion at `chat-form-r3.5.md:251-262`:

- `slashPopupBoundTo` / `poundPopupBoundTo` and the rebuild-on-mismatch
  branch — safe to delete after R3.5a. ✓
- `if (!isViewState('chatting')) return` in `updateButton`
  (`message-streaming.ts:305`) — safe after R3.5b's per-form
  subscription gating. ✓
- `chatView.getActiveForm()?.form.querySelector(...)` in
  `wireFormSubmit` / `updateButton` — replaced by `this.form.*`. ✓
- `let pickerPopup`, `let _pendingPickerCmd` — deleted by R3.5a. ✓

Not listed but worth checking:

- `image-paste.ts:syncHiddenInput`'s `getElementById('imageData')`
  is the writer-side global lookup. If R3.5d stays Option A (see
  B1), this guard cannot be deleted. If Option B is adopted, it
  can. Either way the spec should mention it explicitly.
- `resetTextareaHeight` (`multiline-input.ts:217-223`) reads
  `chatView.getActiveForm()?.textarea` — another get-at-event-time
  global lookup. Once R3.5b moves the callers (`message-streaming.ts:411,421,435,441,472`)
  onto the controller, callers can do `this.textarea.style.height
  = 'auto'` directly. The spec's R3.5a (`chat-form-r3.5.md:131-134`)
  alludes to this ("becomes `ChatViewController.resetActiveTextareaHeight()`
  or moves into the form controller") — pick the latter and add
  it to R3.5e's deletion list. There's also one external caller in
  `view-controller.ts:108` (`grep -n` confirms) — that one needs a
  replacement (probably `chatView.getActiveForm()?.resetTextareaHeight()`).

## NICE-TO-HAVE

### N1 — `registerPoundProvider` is correctly out of scope

Q7. Confirmed: `poundProviders` is an append-only module registry
(`multiline-input.ts:36, 225-231`) consumed by extension-api
(`extension-api.ts:12, 148-149`). After R3.5a, both per-form
`FormPopups` instances read the same registry on each `show()`.
Both forms see the same provider list, which matches extension
intent (extensions don't know about chat-input forms). No
per-form scoping needed. Spec already gets this right at line 136.

### N2 — `setupMultilineInput` / `resetTextareaHeight` / `tryExecuteSlashCommand` are internal

Q10. External (extension) surface confirmed: only
`registerPoundProvider` crosses into `extension-api.ts`. The other
three are internal (`message-streaming.ts`, `view-controller.ts`,
`main.ts` only). So renaming/relocating them is safe; no
`@deprecated` shim needed. Spec says "no external API changes" —
true if we restrict "external" to extension-facing. Worth one
sentence in the spec confirming this.

### N3 — Net line claim is plausible

Q8. Rough numbers:
- `multiline-input.ts`: ~270 → ~50 = **−220**
- new `chat-form-popups.ts`: **+~150**
- `chat-form-controller.ts`: handleSubmit + steerCount +
  refreshButton ≈ **+~100**
- `message-streaming.ts`: `wireFormSubmit` + `updateButton`
  removed ≈ **−110**; `initMessageStreaming` extracted ≈ neutral
- guard deletions, isViewState removals: **−15**

Net: roughly −95. Spec's −50 to −100 estimate is realistic; lean
toward the upper end.

### N4 — Timing question

Q12. Three regressions in one week of the same class is a clear
"do it now" signal. The spec is mechanical relocation onto
existing structure (R3 V1 already did the conceptual split), so
risk is bounded. No reason to defer; deferring means a fourth
regression of the same class while paying defensive-patch interest.

### N5 — Self-containment

Q11. Spec correctly references prereqs
(`chat-form-r3.5.md:18-19`). A fresh agent can execute from
the spec + the two referenced docs without conversation history.
Acceptable.

## Summary

Fix B1 (Option B for imageData), B2 (concrete line-by-line split
for R3.5b with a target module-scope signature), and B3 (explicit
boot order + `const chatRegion`) before implementation. Address
I1–I3 as part of the spec edit pass. N1–N5 are confirmations and
small clarifications.

Once B1–B3 are revised the spec is implementable as-is.
