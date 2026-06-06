# chat-draft refactor

**Status:** spec for review.
**Background:** `docs/chat-draft-persistence.md` (the original feature spec) and
`docs/chat-draft-postmortem.md` (analysis of the bleed bug shipped on the
`chat-drafts` branch).

## Overview

The chat-drafts feature works, but the bug we just fixed
(`docs/chat-draft-postmortem.md`) exposed four architectural weaknesses in
the chat input layer:

1. DOM `input` events are used as an in-process event bus — synthetic
   `dispatchEvent('input')` calls signal "please recompute button state" to
   any listener that happens to be on the textarea.
2. Draft writes look up their key from a mutable global
   (`getActiveSessionId()`) at write time rather than capturing it at the
   moment the view bound to that key.
3. One textarea DOM element is shared across new-chat and chatting views;
   every transition is a manual save/restore around that mutable cell.
4. View transitions mutate the global into a transitional `null` state for
   ~10 lines of `showNewChat`, with no transactional boundary that
   downstream readers can observe.

The shipped fix (`lastSeenInputValue` guard at
[chat-view-controller.ts:155-168](../public/ts/chat-view-controller.ts))
patches the symptom. This refactor removes the underlying causes so the
class of bug becomes impossible.

## Scope

In scope:

- **QW1** — replace `setResponseOptions`'s `dispatchEvent('input')` hack
  with a direct call to the form-state recomputation routine.
- **QW2** — clarify `clearActiveSession()`'s transitional nature (rename
  or inline so future readers see the role).
- **QW3** — regression test for the original bleed bug.
- **R2** — capture the draft key at view activation into a
  `DraftBinding` rather than reading the global at every write.

Deferred to follow-up specs (referenced for context, NOT implemented here):

- **R1** (typed form-state store): larger refactor. Touches the
  message-streaming form lifecycle, the input listener wiring, and several
  unrelated callers of `setResponseOptions`. Worth doing, but a separate
  spec, separate review. QW1 lands the smallest piece (one of seven
  `dispatchEvent('input')` sites); R1 would generalize across the other
  six.
- **R3** (split textarea per view): largest change. Touches CSS,
  focus management, slash/pound popup wiring, and paste handling.
  R2 makes R3 substantially safer to attempt later by eliminating the
  shared-key problem; R3 then eliminates the shared-DOM problem.

Out of scope:

- New features beyond draft persistence.
- Server-side changes (`src/chat-draft-store.ts`, `src/routes/draft.ts`,
  `src/routes/sessions.ts` `/draft` routes). The bug was entirely
  client-side; the server tested out clean.
- Re-design of the WebSocket applet-state bus (different problem space).

## Goals

1. Delete the documented bug-trigger (the synthetic `input` event in
   `setResponseOptions`) so the postmortem's "future regression vector"
   list shrinks from seven to six.
2. Make the draft-key contract explicit and immune to mid-transition global
   mutation: writes for a given view go to a captured key, not a re-read
   global.
3. Lock the fix in with a regression test that fails on the pre-fix code
   and passes on the post-fix code.
4. Leave the `lastSeenInputValue` defensive guard in place; even after QW1
   removes the immediate trigger, the other six `dispatchEvent('input')`
   sites mean defence-in-depth is still warranted.

## Use cases

The user-visible behaviour is unchanged by every step of this refactor.
Each step preserves existing behaviour while removing a class of latent
bug. Concretely, after this refactor:

- Typing in session S, clicking new chat, typing in new chat: no cross-
  contamination of drafts. (Already true post-fix; refactor reinforces.)
- Click "send" mid-debounce: DELETE wins via the per-key promise queue.
- Reload mid-typing: last 0-1 s of typing lost (existing trade-off).
- Switch between sessions during a 1 s debounce window: flush-on-switch
  preserves the outgoing session's draft. (Already true post-fix.)

## Design

### QW1 — replace `setResponseOptions`'s synthetic input event

Trigger:
[`message-streaming.ts:49-54`](../public/ts/message-streaming.ts) and
[`message-streaming.ts:122-128`](../public/ts/message-streaming.ts) both
call `ta?.dispatchEvent(new Event('input', { bubbles: true }))` purely to
re-run `updateButton`
([`message-streaming.ts:301-340`](../public/ts/message-streaming.ts)). The
listener at
[`message-streaming.ts:344`](../public/ts/message-streaming.ts) was the
intended audience; the side-effect bleed into
[`chat-view-controller.ts onDraftInput`](../public/ts/chat-view-controller.ts)
was unintentional.

Fix shape — **option (b): capture-by-reference, not lift-to-module**.
Avoids introducing a new module-mutable DOM ref (`formEl`), which
would be exactly the global-state smell the postmortem flags.

1. At module scope (near the existing `currentOptions` let at line ~39):
   ```ts
   let refreshFormState: () => void = () => {};
   ```
2. Inside `setupFormHandler`, after the `updateButton` closure is
   defined and the input listener is attached, publish the reference:
   ```ts
   refreshFormState = updateButton;
   ```
3. Replace both `dispatchEvent('input')` calls
   ([line 53](../public/ts/message-streaming.ts) and
   [line 126](../public/ts/message-streaming.ts)) with
   `refreshFormState();`.
4. The textarea's own `input` listener (line 344) stays — real user
   input still drives form recomputation.

Properties of option (b) vs option (a) "lift to module":
- No new module-level mutable DOM reference (no `formEl`).
- `updateButton`'s closure over `form`, `steerCount` and `currentOptions`
  is preserved unchanged.
- The function-reference mutable (`refreshFormState`) is published
  once-then-stable; semantically a capture, not a state cell.
- Pre-init calls (synthetic-input fired before `setupFormHandler` runs)
  hit the no-op default, which is the correct semantics (pre-init the
  form doesn't exist anyway).

Both call sites are simple; no API change leaks outside
`message-streaming.ts`. The function name and call shape make it
obvious that "options changed → recompute the form" is a deliberate
cross-coupling, not a hidden side effect.

### QW2 — name `clearActiveSession()` for its actual role

Trigger:
[`app-state.ts:94-97`](../public/ts/app-state.ts) defines
`clearActiveSession()` whose only caller is `showNewChat`
([`chat-view-controller.ts:257`](../public/ts/chat-view-controller.ts)).
The name "clear" sounds like cleanup; the actual role is "we're transitioning
to new-chat and have temporarily released the active session."

Two acceptable shapes; pick one and write it down:

- (a) Inline the one-line assignment
  (`state.activeSessionId = null;`) into `showNewChat`, with a comment
  noting the transitional window and what re-binds it
  (`onNewSessionCreated`). Removes one indirection.
- (b) Rename to `releaseActiveSessionForNewChat()` so callers see the
  intent. Keep the function for now.

Recommendation: (b). Inlining (a) splits a clean state-mutation API across
two layers; renaming (b) makes the contract explicit while leaving the
encapsulation. Both prevent the historical misuse where a future caller
("just clear it temporarily") triggers the same class of bug.

### QW3 — regression test

Trigger: the original bug had no test, so the next of the six remaining
`dispatchEvent('input')` sites can resurrect it silently.

Test shape (Vitest, node env, mocked DOM via a stub textarea object):

1. Construct a `ChatViewController`.
2. Activate session `S1`. Stub the textarea so `getTextarea()` returns
   a fake `{ value }` object. Pretend a previous draft was typed:
   `cvc.sessionDrafts.set('S1', 'abc')` directly, or drive `onDraftInput`
   with a fake textarea.
3. Mock `chat-draft-api` so PUT/DELETE/GET are spies.
4. Call `cvc.showNewChat()`.
5. Assert: no call to `putDraft(null, ...)` with the prior session text.
   No call to `sessionDrafts.set(NEWCHAT_KEY, 'abc')`.

The test file already exists at
[`tests/unit/chat-view-controller.test.ts`](../tests/unit/chat-view-controller.test.ts);
add the case to its `chat-draft persistence` describe block.

### R2 — capture draft binding at activation

Trigger:
[`currentDraftScope()`](../public/ts/chat-view-controller.ts) (chat-view-controller.ts:131-135)
reads `getActiveSessionId()` at every `onDraftInput` call. Between
`clearActiveSession()` and any downstream-fired input event, the global
is `null` and the routing wins NEWCHAT_KEY by default. This is the second
root cause of the bleed bug; QW1 removes the trigger, R2 removes the
latent vulnerability so any future trigger has nowhere to land.

Design shape:

```ts
interface DraftBinding {
  sessionId: string | null;  // null = new-chat
  key: string;               // sessionId or NEWCHAT_KEY
}

// On ChatViewController:
private activeBinding: DraftBinding | null = null;

// In showChat: this.activeBinding = { sessionId, key: sessionId };
// In showNewChat: this.activeBinding = { sessionId: null, key: NEWCHAT_KEY };
// In onNewSessionCreated:
//   this.activeBinding = { sessionId, key: sessionId };
//   (replaces the prior new-chat binding the same moment the textarea
//   stops representing a new chat.)

// In onDraftInput: read this.activeBinding (not getActiveSessionId()).
// If null, bail.
```

Properties:

- The binding only changes when a view *explicitly* rebinds (i.e., when
  the view stack transitions). Mid-transition global mutations cannot
  affect it.
- `getActiveSessionId()` is still used elsewhere (footer rendering, WS
  subscription, etc.). R2 only owns the draft routing.
- Send-path code that needs the binding (`savePrompt`, `flushPendingDraft`)
  reads `this.activeBinding` and is unaffected by races against
  `clearActiveSession()`.

Three caller sites change:
[`showChat`](../public/ts/chat-view-controller.ts:283),
[`showNewChat`](../public/ts/chat-view-controller.ts:252),
[`onNewSessionCreated`](../public/ts/chat-view-controller.ts:478).
Plus the single internal caller of `currentDraftScope`:
[`onDraftInput`](../public/ts/chat-view-controller.ts:169).

`flushPendingDraft`, `scheduleDraftWrite`, and `savePrompt` deliberately
keep their existing key sources (`draftTimerKey` and explicit arguments)
because:
- `flushPendingDraft` flushes the OUTGOING key, which is `draftTimerKey`
  by construction (set when the timer was scheduled). The binding-at-
  activation contract is irrelevant — flush operates on whatever was
  in flight, regardless of what view is now active.
- `scheduleDraftWrite` and `savePrompt` take `sessionId` as explicit
  arguments from the caller (`onDraftInput` and the send path
  respectively). The binding contract is enforced at the *read-from-
  textarea* boundary in `onDraftInput`; downstream functions trust
  their arguments.

Tests:
- A test that simulates `showNewChat` firing a synthetic input event mid-
  transition (before `restoreDraft` clears the textarea); assert that no
  PUT to the prior session's key occurs. This is the structural
  counterpart to QW3.
- A test that simulates a slow `getDraft` GET: type in S1, switch to
  newchat, switch back to S1 before the GET resolves; assert the GET's
  result doesn't end up applied to whichever binding happens to be active
  at resolve time.

## Considerations

### Why not also do R1 + R3 in this spec?

Both are larger. R1 (typed form-state store) replaces the form-event
plumbing across `message-streaming.ts`, `chat-view-controller.ts`, and
the textarea listener. R3 (split textarea per view) restructures the
HTML and touches CSS, focus management, the slash/pound popups, and
paste handling. Splitting them out:

- Keeps this PR mergeable in a single review pass.
- Lets each future spec define its own contract (R1 = a typed store; R3 =
  per-view DOM ownership) without retro-fitting them onto this one.
- Validates the QW1+QW2+QW3+R2 set in production first; the canonical
  ledger above tells us which sites still need attention from R1.

Concrete reopen triggers:

- **R1 reopens if** any new `dispatchEvent('input')` site is proposed
  in code review, OR a regression in the chat-textarea input pipeline
  is observed in any of the six remaining sites, OR R3 is scheduled
  (R1 simplifies R3 by removing the implicit-event contract).
- **R3 reopens if** focus, paste, popup, or selection behaviour
  diverges between new-chat and chatting views in a way the shared-
  textarea workaround cannot bridge, OR a feature wants per-view
  textarea state (e.g. side-by-side composition with a session).

### Does QW1 + R2 obsolete the `lastSeenInputValue` guard?

R2 alone closes the known routing bug for the immediate trigger; the
guard remains as defence against future regressions in the six other
synthetic-input sites enumerated in §"Remaining `dispatchEvent('input')`
sites" below. Keep the guard. Reasoning:

- The guard is one boolean assignment + one early-return in
  `onDraftInput`. Cost-to-keep is near zero.
- The guard now protects against "some future synthetic-input site
  forgets the `suppressNextInput` guard or fires before
  `setActiveBinding` runs" — a speculative concern, but a real class
  of future regression.

The guard becomes structurally redundant only after R1 + R3 ship (R1
replaces the synthetic-input bus with a typed store; R3 removes the
shared textarea entirely).

### Remaining `dispatchEvent('input')` sites

Verified on branch `chat-drafts`. QW1 removes two; six remain on the
chat textarea, two are unrelated (cwd input).

| Site | Caller | User-driven? | Safe because |
|---|---|---|---|
| [message-streaming.ts:53](../public/ts/message-streaming.ts) | `setResponseOptions` | no | **REMOVED by QW1** |
| [message-streaming.ts:126](../public/ts/message-streaming.ts) | `session.idle` callback | no | **REMOVED by QW1** |
| [message-streaming.ts:366](../public/ts/message-streaming.ts) | dispatch-failure restore | no | R2 routes to correct sessionId; lastSeenInputValue if value matches |
| [chat-view-controller.ts:102](../public/ts/chat-view-controller.ts) | `restoreDraft` | no | `suppressNextInput` guard |
| [chat-view-controller.ts:251](../public/ts/chat-view-controller.ts) | `hydrateDraft` | no | `suppressNextInput` guard |
| [chat-view-controller.ts:599](../public/ts/chat-view-controller.ts) | `restoreFailedPrompt` | no | R2 routes to correct sessionId |
| [multiline-input.ts:101](../public/ts/multiline-input.ts) | up-arrow recall | yes | user-initiated; binding stable |
| [main.ts:162](../public/ts/main.ts) | prompt-template apply | yes | user-initiated; binding stable |
| [app-state.ts:190](../public/ts/app-state.ts) | cwdInput | n/a | different element |
| [model-selector.ts:151](../public/ts/model-selector.ts) | cwdInput | n/a | different element |

This is the canonical ledger for the follow-up R1 spec (typed
form-state store). When R1 lands, the user-driven sites stay (they
correctly model "value changed, recompute") and the no-user-driven
sites are replaced with explicit store updates.

### Test environment realities

The existing
[`tests/unit/chat-view-controller.test.ts`](../tests/unit/chat-view-controller.test.ts)
runs in Vitest's node environment (no DOM by default). New tests should
either:

- Drive `cvc` methods directly with stubbed textarea (the approach used
  by the existing "flushes pending debounced draft" and "skips PUT when
  draft exceeds cap" tests at lines 408-447).
- Or, if a more realistic DOM is needed, add `@vitest-environment jsdom`
  to the test file header. Prefer the stub approach to stay consistent.

### What this refactor does NOT defend against

- Server-side races on disk (already handled by `existsSync` + ENOENT
  catch in `setSessionDraft`).
- Multi-tab clobbering of the same session draft (last-writer-wins,
  documented in the original spec; same as before).
- The browser dropping `setTimeout` callbacks during tab freeze
  (out of scope for any of these refactors).

## Code analysis

Key code paths and what changes:

| File | Lines | Change |
|---|---|---|
| `public/ts/message-streaming.ts` | 49-54, 122-128 | QW1: replace `dispatchEvent('input')` with `refreshFormState()` |
| `public/ts/message-streaming.ts` | ~300-340 | QW1: lift `updateButton` to module scope or stash via a `refreshFormState` reference |
| `public/ts/app-state.ts` | 94-97 | QW2: rename `clearActiveSession()` to `releaseActiveSessionForNewChat()` |
| `public/ts/chat-view-controller.ts` | 257 | QW2: call the renamed function |
| `public/ts/chat-view-controller.ts` | 30-50, 131-135, 252, 283, 478 | R2: add `activeBinding` field, set in three activation paths, read in `onDraftInput` and `scheduleDraftWrite` |
| `tests/unit/chat-view-controller.test.ts` | end of `chat-draft persistence` describe | QW3 + R2: add three tests |

Trades:

- `updateButton` lifted to module scope: marginally less encapsulated
  but eliminates a closure-trap that already required the bug-prone
  `dispatchEvent('input')` workaround.
- `activeBinding` adds one field; deletes `currentDraftScope()` (and its
  global read). Net: -1 method, +1 field, simpler write paths.

## Risks and mitigations

1. **R2 changes the source of truth for the draft key.** A future contributor
   might add a draft-related callsite and reach for `getActiveSessionId()`
   out of habit. Mitigation: add a code comment at `currentDraftScope()`'s
   removal site naming the binding pattern, plus inline doc on
   `activeBinding`. The pattern is local to ChatViewController so the
   blast radius is small.

2. **QW1 changes `updateButton`'s visibility.** If `updateButton` becomes a
   module-scope function, anything else in `message-streaming.ts` that
   relied on its closure scope breaks. Mitigation: closure-only deps
   (`steerCount`, `chatRegion`, `currentOptions`) are already module-scoped
   (lines 38-39); the lift is mechanical.

3. **Regression: QW3 hard-codes assumptions about `onDraftInput` plumbing.**
   If a future refactor changes the input-listener path, the test could
   pass while failing to defend the invariant. Mitigation: write the test
   at the highest possible level (`cvc.showNewChat()` → assert no PUT), not
   against internal handlers. The test verifies behaviour, not structure.

4. **R2 surface area is smaller than it might appear.** `currentDraftScope`
   has exactly ONE caller today: `onDraftInput` at
   [chat-view-controller.ts:169](../public/ts/chat-view-controller.ts).
   `flushPendingDraft`, `scheduleDraftWrite`, and `savePrompt` deliberately
   use different key sources (`draftTimerKey` and explicit arguments)
   and must NOT be rewired to read `activeBinding` — see §Design for
   the reasoning. Mitigation: delete `currentDraftScope` outright;
   TypeScript surfaces the one caller. Plan step 3.7 spells this out.

5. **The renamed function (QW2) is a breaking API change for any external
   importers.** None exist today — `clearActiveSession` is only used by
   `showNewChat`. Mitigation: TypeScript catches any future import.

## Acceptance

1. `npm run build` and `npx vitest --run` pass with no new warnings.
2. New tests added to `tests/unit/chat-view-controller.test.ts` pass
   against post-refactor code. Pre-refactor failure is verified once,
   out of band: commit the refactor + tests, then `git worktree add
   /tmp/pre-refactor HEAD~N` for the right N, copy the new test cases
   into the worktree's test file, run `npx vitest --run` there. Test B
   must fail. The acceptance criterion is the post-refactor pass; the
   pre-refactor failure is a one-shot validation that doesn't recur
   in CI.
3. Live verification: open existing chat session, type, click new-chat,
   open browser network panel. Exactly one `GET /api/draft/newchat` on
   the first visit; no `PUT` until the user types in new-chat; no
   stale prior-session text bleeds in.
4. `code-quality.md` axes hit: less coupling
   (`setResponseOptions` no longer dispatches DOM events), less global
   state (draft key bound at activation, not re-read from a global),
   one-purpose classes (`ChatViewController.activeBinding` owns the
   binding, not several functions all reading the same global).

## Open questions

None.
