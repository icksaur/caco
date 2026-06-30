# Chat-Draft Bleed Bug — Postmortem & Code-Quality Review

## The Bug

When a user typed in an existing session and then clicked "new chat", their
session text was persisted to `~/.caco/drafts/newchat.txt`. Root cause:
`setResponseOptions([])` ([public/ts/message-streaming.ts:49-54](../public/ts/message-streaming.ts))
dispatches a synthetic `input` event on the chat textarea as a side-effect
signal to refresh button state. `ChatViewController.showNewChat()`
([public/ts/chat-view-controller.ts:265-293](../public/ts/chat-view-controller.ts))
calls `clearActiveSession()` *before* `setResponseOptions([])` and *before*
`restoreDraft()`. In that gap, the `input` listener fires with the prior
session's text still in `ta.value` and `getActiveSessionId() === null`, so the
draft key resolves to `NEWCHAT_KEY` and the wrong text is persisted. Shipped
fix: track `lastSeenInputValue` and bail when `ta.value` is unchanged
([chat-view-controller.ts:155-168](../public/ts/chat-view-controller.ts)).
That fix patches the symptom; the architecture still invites the same class
of bug.

## Code-Quality Principles Violated

Mapped against `~/.copilot/skills/implement-plan/code-quality.md`.

### "Relying on side effects" / "side effects"
- [message-streaming.ts:49-54](../public/ts/message-streaming.ts) —
  `setResponseOptions` fires `dispatchEvent('input')` purely to nudge an
  unrelated subscriber (`updateButton`, line 344) to recompute. The function's
  name advertises "set options"; its hidden contract is "also re-run every
  input listener on the chat textarea." That hidden contract is what bled into
  `onDraftInput`.
- [message-streaming.ts:122-128](../public/ts/message-streaming.ts) — same
  pattern inside the `session.idle` handler: mutate `currentOptions`, then
  fake an input event to force a re-render.
- [chat-view-controller.ts:102](../public/ts/chat-view-controller.ts),
  [251](../public/ts/chat-view-controller.ts),
  [599](../public/ts/chat-view-controller.ts) — `restoreDraft`,
  `hydrateDraft`, and `restoreFailedPrompt` all set `ta.value` then dispatch
  `input` to trigger autoresize/recall side effects. Each one needs a
  `suppressNextInput` guard to prevent feedback into itself.
- [multiline-input.ts:101](../public/ts/multiline-input.ts),
  [message-streaming.ts:366](../public/ts/message-streaming.ts),
  [main.ts:162](../public/ts/main.ts),
  [app-state.ts:190](../public/ts/app-state.ts),
  [model-selector.ts:151](../public/ts/model-selector.ts) — five more callers
  of the same "set value, dispatch input" idiom. Every one is a future
  regression vector for any new `input` listener.

### "Global state" / "mutable objects"
- [app-state.ts:32-40](../public/ts/app-state.ts) — `state.activeSessionId`
  is a module-level mutable read by every other module. There is no concept
  of "I am transitioning sessions"; readers see either the old value or
  `null` or the new value with no transactional boundary.
- [app-state.ts:94-97](../public/ts/app-state.ts) — `clearActiveSession()`
  flips it to `null` without any indication of *why* (transitioning to new
  chat vs. signing out vs. error recovery). `onDraftInput` cannot
  distinguish "user is genuinely starting a new chat" from "we're mid-
  teardown of the prior session."
- [chat-view-controller.ts:131-135](../public/ts/chat-view-controller.ts) —
  `currentDraftScope()` reads `getActiveSessionId()` at call time. The key
  that a `set()` writes under depends on a global that the caller does not
  pass and cannot pin.

### "Coupling" / "code must be kept in sync"
- The fact that `showNewChat` orders `clearActiveSession()` (line 270),
  `setResponseOptions([])` (line 276), and `restoreDraft(NEWCHAT_KEY)`
  (line 290) is load-bearing. Any future reorder, or any new step inserted
  between them that triggers an `input` event, re-introduces the bleed.
  Nothing in the type system or tests pins that ordering.
- `updateButton` depends on `currentOptions` (module-private in
  message-streaming) but is invoked via a DOM event, not a function call.
  The dependency is invisible to a reader of either file.

### "Only one way to do one thing"
- Three independent caches of "what the user has typed" coexist:
  `sessionDrafts` (Map, in chat-view-controller),
  `sessionPrompts` (Map, same controller, for failed-send recovery),
  and `ta.value` (DOM). All three must agree; nothing enforces it.
- "Restore textarea" is implemented twice with subtly different guards:
  `restoreDraft` ([:93-103](../public/ts/chat-view-controller.ts)) and
  `hydrateDraft` ([:247-252](../public/ts/chat-view-controller.ts)).

### "Wrong abstraction"
- One shared `#chatForm textarea[name="message"]` element backs two distinct
  views (new-chat and existing-session chat). Every transition has to
  manually scrub state across that shared element, and the scrubbing is
  what raced.

### "Strong typing catches issues at compile time"
- `currentDraftScope()` returns `{ sessionId: string | null, key: string }`.
  There is no type that says "this key is owned by this session at this
  moment." A `string` key threaded through `sessionDrafts.set/get`, the
  debounce timer, and `putDraft(sessionId, text)` provides zero compile-time
  protection against the wrong key being used.

## Root Architectural Issues

1. **DOM events used as an in-process event bus.** The codebase uses
   `dispatchEvent(new Event('input'))` as the canonical way to say "form
   state changed, re-render." This conflates user gestures with internal
   notifications. Any listener that cares about user intent (draft
   persistence, slash-command popups, autoresize on real typing) cannot
   distinguish the two and has to invent its own filter
   ([chat-view-controller.ts:155-168](../public/ts/chat-view-controller.ts)).
   The bug we shipped a fix for is exactly this class.

2. **Implicit-key writes against a global.** The draft-write path is
   "compute the key from the current global, then write." There is no
   place where a session ID is *captured* at activation and bound to
   subsequent writes. `clearActiveSession()` therefore acts as a silent
   key-rebinding for every in-flight or about-to-fire write
   ([chat-view-controller.ts:131-135, 157-189](../public/ts/chat-view-controller.ts)).

3. **Shared DOM element across views.** One textarea, two views
   (new-chat, chatting). Every transition is a manual save/restore around
   that single mutable cell. Two textareas (or a per-view component that
   owns its own textarea) would make the bug structurally impossible:
   there would be no "current key" to race against, because the new-chat
   textarea simply would not exist while the user was typing in a session.

4. **Mid-transition global mutation.** `showNewChat` performs ~10 steps
   while `activeSessionId` is `null`. Anything that reads the global in
   that window sees a state that does not correspond to any user-visible
   moment ([chat-view-controller.ts:265-293](../public/ts/chat-view-controller.ts)).
   There is no notion of "I am in transition; reject queries" or
   "the transition is a transaction; observers see only before/after."

## Recommendations

### R1 — Replace DOM-event signalling with a typed store/subscribe
**Effort:** medium (1-2 days).
**Prevents:** the entire class of "synthetic input event causes side effect
in unrelated listener."

Concrete shape:
```ts
// public/ts/form-state-store.ts (new)
type FormStateInputs = { options: string[]; busy: boolean; text: string };
const subs = new Set<(s: FormStateInputs) => void>();
export const formStateStore = {
  set(partial: Partial<FormStateInputs>) { /* merge + notify */ },
  subscribe(fn: (s: FormStateInputs) => void) { subs.add(fn); /* … */ },
};
```
- `setResponseOptions` becomes `formStateStore.set({ options })`. No DOM
  event. The textarea listener stays *only* for real user input.
- `updateButton` subscribes to `formStateStore` instead of listening on
  `input`.
- Delete the `dispatchEvent('input')` line at message-streaming.ts:53 and
  :126, and the matching `suppressNextInput`/`lastSeenInputValue` guards
  in chat-view-controller.ts.

### R2 — Capture the draft key at activation, never from a global
**Effort:** small (half-day).
**Prevents:** "global mutated between when the user typed and when the
debounced write fired."

Concrete shape: a tiny `DraftBinding` object created when a view activates,
holding `{ key, sessionId }`. `onDraftInput` reads from `this.activeBinding`
(set in `showNewChat` / `showChat` / `onNewSessionCreated`), not from
`getActiveSessionId()`. `clearActiveSession()` becomes irrelevant to draft
routing because the binding only changes when a view explicitly rebinds.
Files: [chat-view-controller.ts:131-189](../public/ts/chat-view-controller.ts).

### R3 — Split the textarea per view (or own it via a per-view component)
**Effort:** medium-large (2-3 days; touches CSS, focus management,
slash/pound popups, paste handling).
**Prevents:** any future "transition forgot to scrub state X" bug, by
deleting the shared-mutable-cell that all transitions race around.

Two `<textarea>` elements, one inside the new-chat view, one inside the
chat view. Hidden views' textareas are not in the focus path and not
observed. Drafts are read/written against `view.textarea` directly, so
there is no global "the textarea." `restoreDraft`, `hydrateDraft`, and the
`suppressNextInput` guard become unnecessary because no view ever has to
overwrite a textarea that another view has been typing into.

## Quick Wins

### QW1 — Delete the `dispatchEvent('input')` hack in `setResponseOptions`
Replace [message-streaming.ts:49-54](../public/ts/message-streaming.ts) and
[:122-128](../public/ts/message-streaming.ts) with a direct call to the
already-defined `updateButton()` (lift it out of `setupFormHandler` to
module scope, or expose it via a small `formUi.refresh()` export). Two-line
change. Removes the original trigger of the bug class entirely. Effort: 30
minutes. The `lastSeenInputValue` guard in chat-view-controller can stay as
defence-in-depth.

### QW2 — Make `clearActiveSession()` take a reason, or remove it
[app-state.ts:94-97](../public/ts/app-state.ts). Either:
(a) inline the one-line assignment into `showNewChat`, making it obvious
that the global is in a transitional state from there until
`onNewSessionCreated`; or
(b) give it a parameter (`'transition' | 'logout'`) so readers can branch.
Even just renaming to `clearActiveSessionForNewChat()` reduces the chance a
future caller misuses it. Effort: 15 minutes.

### QW3 — Add a unit/integration test that locks in the fix
The bug had no test. Add one to whichever harness already covers
chat-view-controller (Playwright or DOM-jsdom unit). Scenario: type "abc"
in session S1; call `chatView.showNewChat()`; assert that no PUT to
`/api/draft/newchat` occurs and that `~/.caco/drafts/newchat.txt` is
unchanged. Effort: 1-2 hours. Without this, any of the other six
`dispatchEvent('input')` call sites can resurrect the bug silently.
