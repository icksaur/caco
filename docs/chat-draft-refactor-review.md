# chat-draft refactor — spec + plan review

Reviewing `docs/chat-draft-refactor.md` (spec) and `plan.md` (impl plan)
against `~/.copilot/skills/create-spec-plan/code-quality.md` and the
review-spec / implementation-plan skills.

Scope verified against the actual code on branch `chat-drafts`:
`public/ts/message-streaming.ts`, `public/ts/chat-view-controller.ts`,
`public/ts/app-state.ts`, `tests/unit/chat-view-controller.test.ts`.

---

## BLOCKER

### B1. Spec Risk #4 and plan step 3.7 over-state `currentDraftScope` callers

Spec [chat-draft-refactor.md:213](chat-draft-refactor.md) says:

> Plus the internal callers of `currentDraftScope` (lines 132, 199, 213).

Spec [chat-draft-refactor.md:320-323](chat-draft-refactor.md) (Risk #4):

> `currentDraftScope` is called from `onDraftInput`, `scheduleDraftWrite`,
> `flushPendingDraft`, and `savePrompt`. All four need to read the binding.

Plan [plan.md:115-123](../plan.md) lists `onDraftInput` and `flushPendingDraft`
as known callers.

Reality (verified by `grep currentDraftScope public/ts/chat-view-controller.ts`):
`currentDraftScope` has **exactly one caller** — `onDraftInput` at
[chat-view-controller.ts:169](../public/ts/chat-view-controller.ts).
`flushPendingDraft` reconstructs `sessionId` from `this.draftTimerKey`
([chat-view-controller.ts:222-231](../public/ts/chat-view-controller.ts)),
`scheduleDraftWrite` takes `sessionId`/`key` as arguments
([chat-view-controller.ts:191](../public/ts/chat-view-controller.ts)),
and `savePrompt` takes `sessionId` as an argument
([chat-view-controller.ts:582](../public/ts/chat-view-controller.ts)).

Impact: the spec mis-states the surface area of R2 (it's *smaller* than
advertised — one call site, not four). Sonnet executing step 3.7 will reach
for `flushPendingDraft` and find no `currentDraftScope` call to replace,
and may then guess at "should I rewire flushPendingDraft to read
activeBinding instead of draftTimerKey?" — the answer is **no**, because
`draftTimerKey` correctly remembers the OUTGOING key after a transition
(activeBinding will have already flipped to the INCOMING key by the time
the timer fires for the prior key on a switch). The plan needs to spell
this out, or Sonnet will likely break the flush semantics.

**Fix:** rewrite Risk #4 and step 3.7. State that R2 has one production
caller. Add an explicit note that `flushPendingDraft`, `scheduleDraftWrite`,
and `savePrompt` deliberately keep their existing key sources
(`draftTimerKey` and explicit arguments) because the binding-at-activation
contract is only relevant at the read-from-textarea boundary.

### B2. Plan step 4.3 ("verify against stashed pre-refactor tree") is infeasible as written

Plan [plan.md:173-176](../plan.md):

> Run both tests against a stashed pre-R2 working tree (git stash, then
> verify Test B fails because pre-R2 reads getActiveSessionId() and routes
> wrong). Restore the refactor with git stash pop.

`git stash` will stash the test additions alongside the production-code
changes (they're in the same modified file
`tests/unit/chat-view-controller.test.ts`). The tests therefore won't
exist in the stashed state and cannot "fail" — they'll be absent. Spec
acceptance criterion #2 ([chat-draft-refactor.md:332-334](chat-draft-refactor.md))
has the same flaw.

**Fix:** either (a) commit the tests first, then `git stash` only the
production changes via `git stash --keep-index` after staging the tests
(awkward), or (b) commit tests and production code separately, then
`git revert --no-commit` the production commit, run tests, `git reset
--hard` to restore. Reword the acceptance criterion to: "Commit the new
tests, revert the production-code commits in a worktree, run the tests
in that worktree, confirm Test B fails." Or use `git worktree add` for a
clean pre-R2 checkout and copy the test file in by hand.

### B3. Test B has no debounce handling and will not fail on pre-R2 code as written

Plan [plan.md:159-169](../plan.md) Test B:

> - Call `(cvc as any).onDraftInput()` with stub textarea returning
>   `{ value: 'typed' }`.
> - Assert: the resulting `putDraft` call (if any) targets 'S1', NOT
>   null.

`onDraftInput` calls `scheduleDraftWrite` which does `setTimeout(..., 1000)`
([chat-view-controller.ts:198](../public/ts/chat-view-controller.ts)).
The `putDraft` call lives inside that timer. Synchronously after the
`onDraftInput()` call, `putDraft` has not been invoked yet — the
assertion would pass on both pre- and post-R2 code (because the spy has
zero calls in both worlds), making the test useless. The existing
"flushes pending debounced draft" test
([chat-view-controller.test.ts:406-424](../tests/unit/chat-view-controller.test.ts))
works because `flushPendingDraft` calls `putDraft` synchronously; Test B
goes through the debounce path.

**Fix:** either (a) use `vi.useFakeTimers()` + `vi.advanceTimersByTime(1000)`
before the assertion, or (b) assert directly on observable state that
changes synchronously — e.g. `cvc.sessionDrafts.get('s1') === 'typed'`
and `cvc.sessionDrafts.has(NEWCHAT_DRAFT_KEY) === false`, plus the
internal `draftTimerKey === 's1'`. Approach (b) is robust to the
scheduling shape and matches existing test style (see line 423's
`internal.draftTimer` peek).

---

## IMPORTANT

### I1. Plan step 1.1 introduces a new module-mutable singleton (`formEl`) when option (b) avoids it

Spec [chat-draft-refactor.md:108-115](chat-draft-refactor.md) explicitly
offers two shapes:

> 1. Move `updateButton` from being a local closure inside `setupFormHandler`
>    to module scope. Either by lifting it out, or by capturing a reference
>    into a module-scope `let refreshFormState: () => void = noop;` that
>    `setupFormHandler` reassigns on init.

Plan [plan.md:16-33](../plan.md) chose option 1 (lift) and as a consequence
needs to introduce `let formEl: HTMLFormElement | null = null;` plus a
null-guard in every call. This is itself a code-quality regression of
exactly the type the postmortem flags
([postmortem.md:48-57](archive/chat-draft-postmortem.md) — "global state / mutable
objects"): a new module-level mutable singleton holding a DOM ref.

Option (b) from the spec is strictly cleaner:

```ts
let refreshFormState: () => void = () => {};

export function setupFormHandler(): void {
  // ...
  const form = document.getElementById('chatForm') as HTMLFormElement;
  if (!form) return;
  const updateButton = (): void => { /* unchanged body, still closes over form */ };
  refreshFormState = updateButton;          // publish for external callers
  textarea.addEventListener('input', updateButton);
  // ...
}
```

- No new DOM-holding mutable.
- `updateButton`'s closure over `form` is preserved (the very property
  that the current code relies on; verified body at
  [message-streaming.ts:301-340](../public/ts/message-streaming.ts) closes
  only over `form`, plus the already-module-level `steerCount` and
  `currentOptions` at lines 37-39 — Risk #2 is correctly assessed).
- The function-reference mutable is published-once-then-stable; it's a
  capture, not a state cell.
- No `formEl === null` early-return needed — pre-init calls hit the
  no-op default, which is the correct semantics anyway.

**Fix:** Plan step 1.1 should adopt option (b). Update plan 1.2/1.3 to
call `refreshFormState()` (unchanged). This is a Sonnet-actionable
rewrite; the spec already endorses it.

### I2. Plan step 3.4 has a self-contradicting justification

Plan [plan.md:95-102](../plan.md):

> In `showNewChat` (~line 252), add immediately after
> `flushPendingDraft()` (BEFORE `releaseActiveSessionForNewChat()`,
> so the binding is set while the old global is still meaningful for
> `flushPendingDraft`)

But `flushPendingDraft()` is called *before* `setActiveBinding(null)`
in the same step — so the "binding is set while flush runs" clause is
backwards. And `flushPendingDraft` doesn't read the binding *or* the
global at all
([chat-view-controller.ts:222-231](../public/ts/chat-view-controller.ts)):
it reads `this.draftTimerKey` and reconstructs `sessionId` locally.

The actual reason to place `setActiveBinding(null)` before
`releaseActiveSessionForNewChat()` is the very point of R2: making the
binding flip happen as part of the view-transition contract, not as a
side effect of a global mutation. That's the *contract*, not a
race-window concern.

Cross-checking the other two paths:
- showChat (step 3.3): `flushPendingDraft()` then `setActiveBinding(sessionId)`.
  `flushPendingDraft` flushes the OUTGOING key (correct, before binding
  flips). ✓
- onNewSessionCreated (step 3.5): `setActiveBinding(sessionId)` first,
  then everything else including `deleteDraft(null)` for the consumed
  newchat key. ✓ — but note this method does NOT call
  `flushPendingDraft`. With R2, that's still fine because the prior
  binding was `{null, NEWCHAT_KEY}` and `draftTimerKey === NEWCHAT_KEY`
  is explicitly cancelled at line 498. Worth a sentence in the spec.

**Fix:** rewrite the parenthetical in plan 3.4 to say "so the binding
flip is part of the view-transition step, not a side effect of the
global mutation." Drop the false claim about flushPendingDraft.

### I3. Spec's R2 caller list (line 213) cites wrong line numbers

[chat-draft-refactor.md:213](chat-draft-refactor.md):

> Plus the internal callers of `currentDraftScope` (lines 132, 199, 213).

Lines 132, 199, 213 in `chat-view-controller.ts` are: the body of
`currentDraftScope` itself (132), inside `scheduleDraftWrite`'s setTimeout
(199), and inside `cancelDraftTimer` (213). None call `currentDraftScope`.
This is a documentation defect that will confuse Sonnet. Covered also by
B1.

### I4. Plan step 1.5 references a debugging `console.log` that may not exist

Plan [plan.md:46-49](../plan.md):

> Console should show NO `[chat-draft] onDraftInput` fire from
> `setResponseOptions` (only from real user keypresses). Remove the
> temporary `console.log` in `onDraftInput` if still present in the
> working tree.

`grep -n "chat-draft.*onDraftInput" public/ts/chat-view-controller.ts`
returns no results on the current branch. Either this log was already
removed, or it was never committed. Either way, the plan step is
ambiguous — Sonnet might add then remove a log just to satisfy the
verification step. Drop the step or rephrase as "if any `[chat-draft]`
debug logs exist in `onDraftInput`, leave them or remove them per
session preference."

### I5. The spec is incomplete on remaining `dispatchEvent('input')` sites (focus area 10)

Spec says "six remaining sites" twice ([refactor.md:74-76, 247-249](chat-draft-refactor.md))
but never enumerates them. The postmortem does, partially. For R1 to be
plannable as a follow-up spec, this spec is the natural place to record
the canonical ledger. Verified set on `chat-drafts` branch:

| Site | Surface | User-driven? | Currently safe because |
|---|---|---|---|
| [message-streaming.ts:53](../public/ts/message-streaming.ts) | chat textarea | no (setResponseOptions) | **removed by QW1** |
| [message-streaming.ts:126](../public/ts/message-streaming.ts) | chat textarea | no (session.idle) | **removed by QW1** |
| [message-streaming.ts:366](../public/ts/message-streaming.ts) | chat textarea | no (restore on dispatch failure) | sets value to prior prompt; lastSeenInputValue + R2 catch it |
| [chat-view-controller.ts:102](../public/ts/chat-view-controller.ts) | chat textarea | no (restoreDraft) | `suppressNextInput` guard |
| [chat-view-controller.ts:251](../public/ts/chat-view-controller.ts) | chat textarea | no (hydrateDraft) | `suppressNextInput` guard |
| [chat-view-controller.ts:599](../public/ts/chat-view-controller.ts) | chat textarea | no (restoreFailedPrompt) | R2 routes to correct sessionId |
| [multiline-input.ts:101](../public/ts/multiline-input.ts) | chat textarea | yes (slash-command apply) | user-initiated, binding stable |
| [main.ts:162](../public/ts/main.ts) | chat textarea | yes (paste/recall path) | user-initiated, binding stable |
| [app-state.ts:190](../public/ts/app-state.ts) | cwdInput | n/a (different element) | not the chat textarea |
| [model-selector.ts:151](../public/ts/model-selector.ts) | cwdInput | n/a | not the chat textarea |

That's **6 chat-textarea sites remaining after QW1** (3 controller +
`message-streaming.ts:366` + 2 user-driven multiline/main). The cwdInput
sites are unrelated. Including this table in the spec under
"Considerations" makes the R1 ledger concrete and the
defence-in-depth argument for `lastSeenInputValue` (focus area 6) more
defensible.

---

## NICE-TO-HAVE

### N1. `lastSeenInputValue` is structurally redundant after R2 — call it out explicitly

Focus area 6. The spec keeps the guard "as defence-in-depth"
([refactor.md:74-76, 242-254](chat-draft-refactor.md)). Verified analysis:
after QW1 + R2, the remaining synthetic-input sites that hit the chat
textarea either (a) use `suppressNextInput` (restoreDraft, hydrateDraft)
or (b) write the correct new value (`val !== lastSeenInputValue` is the
*expected* state and the routing via `activeBinding` is now correct).
So `lastSeenInputValue` no longer protects against any specific known
bug — it protects against "some future synthetic-input site forgets the
`suppressNextInput` guard." That's a real but speculative concern.

This is judgment-call territory, not a defect. The spec's stance is
defensible; just be honest that the guard is now *belt over a fixed
belt*, not *belt + suspenders* against an actual hole. A one-line update
to §"Does QW1 + R2 obsolete the `lastSeenInputValue` guard?" stating
"R2 alone closes the known routing bug; the guard remains as defence
against future regressions in the six other synthetic-input sites
above" would be honest and complete.

### N2. Spec doesn't define reopen conditions for R1/R3 (focus area 8)

[refactor.md:46-54](chat-draft-refactor.md) defers R1/R3 with a "validate
in production first" rationale ("no further regressions in 30 days").
That's a vague trigger. Make it concrete:

- R1 reopens if: any new `dispatchEvent('input')` site is added in
  review, OR a regression in the chat-textarea input pipeline is
  observed, OR R3 is scheduled (R1 simplifies R3).
- R3 reopens if: focus / paste / popup behaviour diverges between
  new-chat and chatting views in a way that the shared-DOM workaround
  can't bridge.

This is the difference between "deferred" and "punted."

### N3. Plan step 3.8 is confusingly worded

[plan.md:125-131](../plan.md):

> `savePrompt` (~line 478ish, the one that takes `sessionId` as an
> argument): leave the argument as the truth (caller-provided), but
> ALSO clear `this.activeBinding` if its sessionId matches — actually
> NO: savePrompt is called on send-time when the binding is still
> active. ...

The "actually NO" mid-paragraph self-correction is hard to follow.
Rewrite as: "`savePrompt` (line 582) takes `sessionId` explicitly and
needs no change. The caller's `sessionId` equals `activeBinding.sessionId`
in the happy path; the binding stays valid through the send. No
action."

Also fix the line reference: `savePrompt` is at line 582, not 478.

### N4. Step 1.1's `formEl === null` early-return doesn't compose with step 1.2/1.3

If step 1.1 is kept (rather than adopting option (b) per I1), the
defensive `if (!formEl) return;` in `refreshFormState` means QW1's
behavioural fix — "options changed, recompute button state" — is
silently dropped if `setResponseOptions` fires before `setupFormHandler`.
That can happen during early bootstrap. Pre-refactor,
`dispatchEvent('input')` would also be a no-op if the textarea didn't
exist, so behaviour is preserved — fine. But worth a one-line comment
in the plan so Sonnet doesn't try to "improve" the early-return.

Adopting I1 (option b) sidesteps this entirely.

---

## What I verified (positive findings)

- QW1 closure-deps analysis is correct (spec Risk #2, focus area 5).
  `updateButton`'s body at
  [message-streaming.ts:301-340](../public/ts/message-streaming.ts) closes
  over `form` only; `steerCount` (line 38), `currentOptions` (line 39),
  `chatRegion` (line 37) are already module-scoped; everything else is
  an import. Lift is mechanical.
- Spec's framing of the four architectural issues (focus area 4) is
  honest. R2 addresses #2 fully and #4 partially (only for the draft
  routing — the broader global-mutation surface is unchanged, and the
  spec acknowledges this at lines 203-204). #1 and #3 are explicitly
  deferred. Honest deferral, not avoidance.
- showChat ordering (plan step 3.3): `flushPendingDraft()` then
  `setActiveBinding(sessionId)` is correct.
  [chat-view-controller.ts:466-482](../public/ts/chat-view-controller.ts).
- onNewSessionCreated ordering (plan step 3.5): setting binding first is
  correct given that the next-line operations include
  `deleteDraft(null)` for the consumed newchat key.
  [chat-view-controller.ts:488-500](../public/ts/chat-view-controller.ts).
- QW3's "test at the highest level, not internal handlers" guidance
  (Risk #3) is sound and matches the existing test style at
  [chat-view-controller.test.ts:406-424](../tests/unit/chat-view-controller.test.ts).
- Acceptance criterion #1 (build + tests clean) is unambiguous.
- Acceptance criterion #3 (live-trace verification) is concrete and
  matches the bug repro path.
- The spec correctly identifies that the server side is clean and
  out-of-scope.

---

## Summary

3 BLOCKERs (B1 incorrect caller list / scope drift, B2 stash-verification
mechanic broken, B3 Test B doesn't actually fail on pre-R2 code),
5 IMPORTANTs (mostly plan-actionability cleanups), 4 NICE-TO-HAVEs.

After fixing B1–B3 and ideally I1 (adopt option (b) for the
function-reference instead of `formEl` mutable), the spec+plan are
solid and Sonnet-actionable. The underlying refactor design is sound:
R2 plus QW1 plus QW3 close the documented bug class and leave a clean
ledger for R1/R3 follow-ups.
