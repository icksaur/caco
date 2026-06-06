# review v2 — chat-form-refactor.md + plan.md (second pass)

Reviewer: second-pass review against round-1 findings (B1, I1–I8,
N1–N5). Grounded against `public/ts/chat-view-controller.ts`,
`public/ts/message-streaming.ts`, `public/ts/multiline-input.ts`.

Documents under review:
- `docs/chat-form-refactor.md` (revised spec)
- `plan.md` (revised, Phases 2 and 3)

---

## Round-1 finding resolution

| ID | Finding | Status | Notes |
|---|---|---|---|
| B1 | Removing `dispatchEvent('input')` breaks autoresize | **Resolved** | Spec:155–184 reframes R1 as "delete synthetic-signal events only"; real-value-set `dispatchEvent` calls stay. Plan 2.0 scope clarification (plan:207–211) matches. Autoresize continues to fire via the kept `input` events. |
| I1 | `currentOptions` writes at lines 364/438 not in plan | **Resolved** | Plan steps 2.2.4 and 2.2.5 now explicitly cover both sites. Plan 2.2.1 (plan:231–244) inventories all write sites including 364 and 438. |
| I2 | Array mutation hazard in store | **Resolved** | Spec:109 initializes with `Object.freeze([])`. Spec:126 does `Object.freeze(b.slice())` on every set. Plan 2.1.1 (plan:215–218) says "Object.freeze(b.slice()) on stored options". Plan 2.1.2 (plan:223) adds test: "frozen array mutation throws in strict mode". |
| I3 | Net line-count target unattainable (−20 to −40) | **Resolved** | Spec acceptance R1 #6 (spec:619–620): "Line count within ±20 of baseline." Plan 2.5.3 (plan:394–395) confirms via `git diff --stat`. |
| I4 | Phase 2 branches off uncommitted Phase 1 | **Resolved** | Plan:192–198 adds explicit "Phase 1 → Phase 2 handoff" step: user reviews, commits, PR, merges to master. Plan:402–405 mirrors for Phase 2 → 3 handoff. |
| I5 | `setupFormHandler` move under-specified | **Resolved (deferred)** | Spec:219–226 explicitly scopes R3 V1 to NOT move setupFormHandler. The handler stays at module scope; relocation deferred to R3.5 (spec:366–384). Plan:414–419 matches. The six structural concerns (chatRegion, registerWsHandlers, steerCount, getActiveSessionId, isNewChat branch, setFormEnabled) are now out of scope. |
| I6 | `responseOptions` duplication unaddressed | **Resolved** | Spec:251 and 262–264: `#responseOptions` lives only in `chattingForm`. Plan 3.1.1 (plan:440–441): "No responseOptions div in newChat." |
| I7 | Paste / drag-and-drop wiring misdiagnosed | **Resolved** | Spec:361–364: document-level paste listener, no per-form wiring needed. No drag-drop handlers on the textarea exist today. Corrected diagnosis. |
| I8 | Spec open questions unresolved | **Resolved** | Spec:642–651: both open questions closed with decisions. Q1: Map stays on ChatViewController, helpers exposed. Q2: submit handler stays at module scope for R3 V1. |
| N1 | `chatFooter` post-refactor layout asymmetry | **Resolved** | Spec:266–271 explicitly calls out the layout delta and notes adHocBar stays put. |
| N2 | `bindForms` rationale | **Not addressed** | No note on why setter over constructor injection. Low priority; acceptable. |
| N3 | `getActiveForm()` undefined in plan | **Resolved** | Plan 3.3.1 (plan:513–518) defines `getActiveForm()` method. Spec:332–334 describes the method. |
| N4 | Factory vs singleton ambiguity | **Resolved** | Spec:402–415: explicit decision — singleton store, scoped to chatting form only. No factory. |
| N5 | Test inventory gaps | **Partially resolved** | Plan 2.1.2 (plan:220–227) covers store tests. Autoresize survival is covered in smoke (plan:391). No dedicated unit test for autoresize on programmatic set, but acceptable given the B1 fix preserves the existing mechanism unchanged. |

**Summary: All blockers and importants resolved. One nice-to-have
(N2) unaddressed — acceptable.**

---

## New findings from the 10 review points

### Point 1: `updateButton` re-querying `getActiveForm()` on every store change

**Severity:** IMPORTANT

**Problem:** Plan 3.4.3 (plan:601–617) says `updateButton`'s
`form.querySelector(...)` queries become
`chatView.getActiveForm()?.form.querySelector(...)`. Today,
`updateButton` (message-streaming.ts:301–340) is a closure that
captures `form` (line 298) once at setup time. After Phase 2,
`updateButton` becomes a store subscriber (plan 2.3.1, plan:305–310)
and fires on every `formStateStore.set(...)` — which includes every
`hasText` change (every keystroke), every `sessionBusy` toggle, and
every `options` update.

After Phase 3, if the closure-captured `form` is replaced with
`chatView.getActiveForm()?.form`, then every subscriber invocation
does a method call + nullable access. This is **not a perf problem**
— it's a pointer read, not a DOM query; `getActiveForm()` just
returns `this.activeForm` (plan:517). The method is O(1).

But the **real issue** is structural: `updateButton` also reads
`form.classList.toggle('busy', isBusy)` at line 331. After Phase 3,
which form gets the `busy` class? `getActiveForm()?.form` returns
whichever form is currently visible. If the user is in newChat view,
the chatting form's busy state still needs the `busy` CSS class so
that when the user switches back, the form looks correct. But
`getActiveForm()` returns the newChat form, so the busy class goes
on the wrong form.

This is mitigated by the fact that `chatView.setFormEnabled(false)`
at line 436 (called in the submit handler) already sets the busy
class. And `sessionTracker.onChange` in `registerWsHandlers`
(message-streaming.ts:167–171) calls `chatView.setFormEnabled(!state.busy)`.
So there are TWO paths setting busy state on the form: (a) the store
subscriber running `updateButton`, and (b) `setFormEnabled`.

After Phase 3 V1, these paths can disagree about *which* form to
target. `setFormEnabled` (per plan 3.4.4, plan:619–627) also uses
`chatView.getActiveForm()?.form`, so both paths target the active
form. This means: if the user is in newChat view while a background
session finishes, `setFormEnabled(true)` targets the newChat form
(wrong — it's the chatting form that needs the busy class removed).

**Evidence:** message-streaming.ts:167–171 calls
`chatView.setFormEnabled(!state.busy)` keyed to
`sessionId === getActiveSessionId()`. After `showNewChat()`,
`getActiveSessionId()` returns null (chat-view-controller.ts:270
calls `clearActiveSession()`). So the guard `sessionId === getActiveSessionId()`
is false when in newChat, and the `setFormEnabled` call is skipped.
**This is actually correct** — the busy state update is suppressed
when in newChat. When the user switches back via `activateSession`,
the session re-resumes and the state is reloaded fresh.

But `updateButton` via the store subscriber has NO such guard. The
`sessionTracker.onChange` at plan 2.3.3 (plan:326–338) pushes
`sessionBusy` into the store regardless of which view is active.
The store subscriber fires `updateButton`, which queries
`getActiveForm()?.form` — which is the newChat form. It toggles
`form.classList.toggle('busy', isBusy)` on the newChat form. That's
cosmetically wrong but likely invisible (newChat never shows a busy
state). Still, the `busy` class on the newChat form is a lurking
issue.

**Suggested fix:** Plan 3.4.3 should specify: `updateButton`'s store
subscriber should guard with
`if (chatView.getViewState() !== 'chatting') return;` before doing
any DOM work. This is cheap (one comparison) and prevents stale DOM
writes to the wrong form. Add a one-liner to step 3.4.3.

Alternatively, the `sessionTracker.onChange` subscriber in step 2.3.3
should guard on `getActiveSessionId()` being non-null before setting
`sessionBusy` — matching the existing guard at line 168. This is
arguably cleaner: the store reflects reality (no active session =
not busy), and `updateButton` doesn't need to guard.

**File:** `plan.md:326-338` and `plan.md:601-617`

---

### Point 2: `sessionTracker.onChange` + `getActiveForm()` when in newChat view

**Severity:** NICE-TO-HAVE (resolved by Point 1 fix)

**Analysis:** After Phase 3 V1, `sessionTracker.onChange` fires the
store subscriber (plan 2.3.3), which fires `updateButton`. If the
user is in newChat view while a session finishes in the background:

- `getActiveSessionId()` is null (cleared by `showNewChat`).
- The `sessionTracker.onChange` at plan 2.3.3 computes
  `busy = id ? ... : false`, so `sessionBusy = false`.
- The store may already have `sessionBusy: false` → no-op (store
  dedup). No subscriber fires. Correct.

If a session transitions busy→idle while the user is in newChat:
the `sessionTracker.onChange` at message-streaming.ts:167 (inside
`registerWsHandlers`) checks `sessionId === getActiveSessionId()`.
`getActiveSessionId()` is null; the callback session is non-null.
Guard fails. `setFormEnabled` is not called. Correct.

The plan 2.3.3 subscriber is a separate `sessionTracker.onChange`
registration (plan:326–338). This one does NOT guard on
`sessionId === getActiveSessionId()`. It reads the global
`getActiveSessionId()` which is null → `busy = false` →
`formStateStore.set({ sessionBusy: false })` → likely a no-op
(already false). Correct.

**Verdict:** No bug here. The store's dedup semantics make this a
no-op in the newChat case. The concern from point 1 (busy class on
wrong form) is the only real issue, and it's cosmetic. Resolved by
Point 1's suggested fix.

---

### Point 3: `responseOptions` rendering when in newChat view

**Severity:** NICE-TO-HAVE

**Analysis:** After R3 V1, `#responseOptions` exists only in
`chattingForm` (spec:251, plan:440–441). `updateButton` calls
`document.getElementById('responseOptions')` at
message-streaming.ts:305. The chatting form is hidden when in
newChat view, but the element is still in the DOM (`hidden` class
on the parent `#chat` div uses CSS `display: none`, not DOM
removal). So `getElementById` finds it, `renderOptions` writes
to it, but it's invisible. Correct.

Should the subscriber bail when in newChat? Not needed — the work
is wasted but cheap (the element exists, rendering to a hidden
subtree is fast, and the browser doesn't layout/paint hidden
elements). The Point 1 guard (`if (chatView.getViewState() !== 'chatting') return`) in `updateButton` would also skip this path,
making it a two-for-one fix.

The spec/plan don't need to address this separately. The Point 1
fix covers it.

---

### Point 4: `hasText` staleness when in newChat view

**Severity:** IMPORTANT

**Problem:** After Phase 2, the textarea `input` listener at
plan 2.3.2 (plan:317–320) sets `formStateStore.set({hasText: ...})`.
After Phase 3 V1, this listener is installed by
`ChatFormController.attach()` (plan 3.2.2, plan:474–478). The plan
says "chatting form only" for the `hasText` store update — newChat's
listener doesn't set `hasText` in the singleton store.

This means: when the user types in newChat, `hasText` in the store
retains whatever value it had from the last chatting-form interaction.
Does anything care?

`updateButton` cares. It reads `hasText` (via `computeFormState`)
to decide whether to show Send/Steer/Stop. But `updateButton` only
runs via: (a) the textarea input listener on the chatting form (gone
when in newChat), (b) the store subscriber, (c) direct calls inside
the submit handler.

The store subscriber fires on store changes. When in newChat, the
only store changes come from `sessionTracker.onChange` (pushing
`sessionBusy`). If `sessionBusy` changes while in newChat,
`updateButton` fires, reads stale `hasText`, and applies button
state to whichever form `getActiveForm()` returns (the newChat form).
This would set the newChat form's send/stop button visibility based
on stale `hasText` from the chatting session.

**However:** the newChat form's submit handling is independent. The
Send button in newChat is a standard submit button; its visibility
is not governed by `updateButton` today (it always shows). Wait —
actually, `updateButton` DOES query `form.querySelector('.send-btn')`
and sets its display. After Phase 3, `getActiveForm()?.form` in
newChat returns the newChat form. So `updateButton` would toggle
the newChat form's Send button based on stale `hasText`.

**But:** per Point 1/Point 2 analysis, when in newChat
`getActiveSessionId()` is null, `sessionBusy` is false, and the
store likely already has `sessionBusy: false`. The store dedup
prevents `updateButton` from firing. So in practice this is a
non-issue **except** in the narrow window where a session goes
idle while the user is in newChat (one store change to
`sessionBusy: false` — but it's likely already false).

**This is the same issue as Point 1.** The fix is the same: guard
`updateButton`'s subscriber or guard the store push.

**Verdict:** Covered by Point 1's suggested fix. The spec/plan
should state explicitly (as a design note) that the singleton
`formStateStore` is scoped to the chatting view and `updateButton`
must not run against the newChat form. The spec's §"Per-form store
vs singleton store" (spec:402–415) says this conceptually but
doesn't connect it to the `updateButton` guard.

**Suggested fix:** Add one sentence to spec §"Per-form store vs
singleton store": "Consequence: `updateButton`'s store subscriber
must guard on `getViewState() === 'chatting'` before doing DOM work;
when in newChat, the store's values are stale for the visible form
and must not be applied."

Add the guard to plan step 3.4.3.

**File:** `docs/chat-form-refactor.md:402-415`, `plan.md:601-617`

---

### Point 5: Textarea `input` listener lifecycle across Phase 2 → Phase 3

**Severity:** NICE-TO-HAVE (informational — correctly handled)

**Analysis:** Tracing the listener lifecycle:

**End of Phase 2:** The textarea `input` listener at
message-streaming.ts:344 is augmented (plan 2.3.2, plan:317–324) to:
```ts
textarea.addEventListener('input', () => {
  formStateStore.set({ hasText: textarea.value.trim().length > 0 });
  updateButton();
});
```
Plus the draft listener from `ChatViewController.ensureDraftListener`
(chat-view-controller.ts:140–146). Plus the autoresize/slash/pound
listener from `setupMultilineInput` (multiline-input.ts:68–72).

Three listeners on one textarea. All correct.

**End of Phase 3 V1:** Plan 3.4.3 (plan:614–615) removes the line
344 `addEventListener` call. The `hasText` sync moves into
`ChatFormController.attach()` (plan 3.2.2, plan:475–477) — chatting
form only. The `updateButton` subscriber is now driven by the store
(plan 2.3.1). `setupMultilineInput` is called per-form (plan 3.4.1,
plan:588–589).

Resulting listeners per form:
- **Chatting form:** (a) `ChatFormController.attach()` listener sets
  `hasText` + handles draft input. (b) `setupMultilineInput` listener
  drives autoresize/slash/pound. `updateButton` runs via store
  subscriber, not via direct listener. ✓
- **NewChat form:** (a) `ChatFormController.attach()` listener handles
  draft input only (no `hasText` — plan 3.2.2 says "chatting form
  only"). (b) `setupMultilineInput` listener drives
  autoresize/slash/pound. ✓

The `ensureDraftListener` from ChatViewController is removed (plan
3.3.7, plan:567–569). ✓

**Verdict:** Listener wiring is correct. No issue.

---

### Point 6: Plan step 2.4.3 `suppressNextInput` actionability

**Severity:** IMPORTANT

**Problem:** Plan 2.4.3 (plan:359–378) says:

> "Sonnet: try removal first; the test suite will tell you."

This is an improvement over the round-1 wording, but there's a
subtlety the plan misses. After R1, `suppressNextInput` guards
`onDraftInput` against echoing restore-driven `dispatchEvent('input')`
calls. With `lastSeenInputValue` removed (step 2.4.2), the ONLY
remaining guard against restore-echo is `suppressNextInput` itself.

The plan's logic at 2.4.2 (plan:349–357) argues that spurious fires
of `onDraftInput` with the same value are "observably no-op" because
they "write the same key/value pair and re-arm the same timer with
the same payload." This is true for the Map write (idempotent) and
the timer (re-arms to the same effect). **But** the timer re-arm
means a new `setTimeout` is scheduled — extending the debounce
window. If `restoreDraft` fires 3 times in rapid succession (e.g.
view transitions), each fires `onDraftInput`, each re-arms the
timer. The final PUT lands 1s after the LAST fire, not 1s after the
first. This is actually fine — it's correct debounce behaviour.

The `isWithinCap` check (chat-view-controller.ts:178) is also
idempotent on repeated calls with the same value.

**Verdict:** The plan's logic is sound. The wording "try removal
first; the test suite will tell you" is actionable enough — Sonnet
removes, runs tests, keeps or reverts. The test suite covers the
critical paths. **Resolved — no change needed.** (Upgrading from
round-1 assessment.)

---

### Point 7: Plan step 3.2.6 two-instance isolation test and singleton store

**Severity:** IMPORTANT

**Problem:** Plan 3.2.6 (plan:502–509) lists a test:

> "Two-instance isolation: typing in instance A does not affect
> instance B's binding or timer."

With a singleton `formStateStore`, both instances write to the same
store. The test as described only checks "binding or timer" — which
ARE per-instance (per the `ChatFormController` design). So the test
claim is correct for what it tests.

**But** the chatting form's `attach()` listener calls
`formStateStore.set({hasText: ...})` (plan 3.2.2). If both instances
somehow call `attach()` with `hasText` sync (they shouldn't — only
chatting form does), they'd collide on the singleton store. The plan
says "chatting form only" for `hasText`, so this shouldn't happen.

The test should verify: typing in the newChat instance does NOT
call `formStateStore.set({hasText: ...})`. This would catch a
regression where someone adds `hasText` sync to the newChat
controller.

**Suggested fix:** Add to test 3.2.6: "Verify newChat instance
`attach()` does NOT call `formStateStore.set` on input." This is a
one-line mock assertion.

**File:** `plan.md:502-509`

---

### Point 8: `getLastInput()` per-form awareness after R3 V1

**Severity:** IMPORTANT

**Problem:** `chatView.getLastInput()` (chat-view-controller.ts:609–613)
reads `getActiveSessionId()` and returns the prompt/draft for that
session. `setupMultilineInput` calls it at multiline-input.ts:97 on
up-arrow.

After R3 V1, `setupMultilineInput` is called per-form (plan 3.4.1,
plan:588–589). The newChat form gets its own keydown handler calling
`chatView.getLastInput()`. But `getLastInput()` returns `''` when
`getActiveSessionId()` is null (line 611). In newChat view,
`getActiveSessionId()` IS null. So up-arrow in newChat always
returns empty. **This is the existing behaviour** — up-arrow recall
was always session-scoped, and newChat has no session.

Is this correct? The spec says (spec:87): "Up-arrow recall: per-view
(each view's last input)." This implies newChat should recall its
own last input. But newChat's "last input" became a session on send
— so `sessionPrompts.get(newSessionId)` holds it, not anything
keyed to newChat.

The plan doesn't address this. `getLastInput()` should arguably
have a newChat path that returns the last newChat-originated prompt.
But this is a **pre-existing behaviour** — up-arrow in newChat
doesn't work today either (same code path, same null check). The
spec's "per-view" language is aspirational, not a regression.

**Suggested fix:** Either (a) update spec:87 to say "Up-arrow recall:
per-session (newChat has no session, so up-arrow is a no-op there)"
to match reality, or (b) add a plan step to make `getLastInput()`
newChat-aware by storing the last newChat prompt separately. Option
(a) is honest and zero-cost. Option (b) is scope creep for R3 V1.

**File:** `docs/chat-form-refactor.md:87`, `plan.md:592-599`

---

### Point 9: Inter-phase handoff instructions for automated agents

**Severity:** NICE-TO-HAVE

**Analysis:** Plan steps 1.5.4 (plan:189), 1.x (plan:194–198),
2.5.5 (plan:400), and 2.x (plan:404–405) use the pattern:

> "STOP. Do NOT commit per implement-plan skill rules. Hand back to
> the user."

and:

> "Before starting Phase N: USER reviews..."

The STOP instruction is clear — any agent following implement-plan
skill rules knows to halt at an explicit STOP. The "USER reviews"
preamble is also clear: it's a precondition that the agent cannot
satisfy.

**However:** if an agent processes the plan top-to-bottom without
reading ahead, it might start Phase 2 steps without checking the
preamble. The preamble is a `[ ]` checkbox (plan:194), which looks
like a task to execute. The text says "USER reviews" which is
unambiguous.

**Suggested improvement:** Add a `---` horizontal rule + bold header
before each phase's preamble. The plan already has this (plan:200,
407). No change needed — the structure is clear enough.

**Verdict:** No issue. The handoff pattern is well-structured.

---

### Point 10: Remaining ambiguities for Sonnet executing the plan

**Severity:** IMPORTANT (two items)

**10a. `form.classList.toggle('busy', isBusy)` at line 331 — which
form after Phase 3?**

As discussed in Point 1, `updateButton` toggles `busy` on the form.
After Phase 3, `form` is `chatView.getActiveForm()?.form`. Plan
3.4.3 (plan:610–612) says:

> "updateButton's form.querySelector queries become
> chatView.getActiveForm()?.form.querySelector(...). Same pattern."

This tells Sonnet to mechanically replace `form` with
`chatView.getActiveForm()?.form`. Sonnet will do so, including for
`form.classList.toggle('busy', isBusy)`. This works but has the
Point 1 issue (wrong form when in newChat). Sonnet won't add a view
guard unless told.

**Suggested fix:** Plan 3.4.3 should add: "Add
`if (chatView.getViewState() !== 'chatting') return;` at the top
of `updateButton`. The store is chatting-scoped; `updateButton`
must not apply state to the newChat form."

**10b. `resetTextareaHeight` in `multiline-input.ts:213-219` still
queries `#chatForm`.**

Plan 3.4.2 (plan:592–599) refactors `setupMultilineInput` but does
not mention `resetTextareaHeight` (multiline-input.ts:213–219). That
function queries `#chatForm textarea[name="message"]`:

```ts
export function resetTextareaHeight(): void {
  const textarea = document.querySelector('#chatForm textarea[name="message"]') ...
```

After Phase 3, `#chatForm` no longer exists. Plan 3.4.5 (plan:629–638)
lists `#chatForm` queries to fix but does NOT list
`multiline-input.ts:214`. It lists `multiline-input.ts:45, 63, 214,
237, 238` — wait, it DOES list line 214. Reading again:

> "`multiline-input.ts:45, 63, 214, 237, 238` — addressed by 3.4.2
> above."

But plan 3.4.2 only says to refactor `setupMultilineInput`'s
signature and internal queries. `resetTextareaHeight` is a separate
exported function (not inside `setupMultilineInput`). Plan 3.4.2
says "Search for other internal queries (`grep -n "#chatForm"
public/ts/multiline-input.ts`) and convert." This grep would find
line 214, but Sonnet needs to know what to replace it WITH.

`resetTextareaHeight` is called from:
- `view-controller.ts:95` (on `setViewState('newChat')`)
- `message-streaming.ts:386, 396, 410, 416, 442` (after clearing
  the textarea on send/slash/steer)

After Phase 3, the caller should reset the ACTIVE form's textarea.
The function should take a `textarea` arg, OR query
`chatView.getActiveForm()?.textarea`.

**Suggested fix:** Plan 3.4.2 should explicitly address
`resetTextareaHeight`: either (a) change its signature to take a
`textarea` arg and update all callers, or (b) rewrite it to use
`chatView.getActiveForm()?.textarea`. Option (b) is simpler for R3
V1 since the callers in message-streaming.ts don't have a textarea
reference handy.

Also: `tryExecuteSlashCommand` (multiline-input.ts:229–268) at lines
237–238 queries `#chatForm`. Plan 3.4.5 says "addressed by 3.4.2"
but `tryExecuteSlashCommand` is also NOT inside `setupMultilineInput`.
The plan should call this out explicitly.

**File:** `plan.md:592-599`, `multiline-input.ts:213-219, 237-238`

---

## Summary

| # | Point | Severity | Verdict |
|---|---|---|---|
| 1 | `updateButton` + `getActiveForm()` wrong-form risk | IMPORTANT | Plan 3.4.3 needs viewState guard |
| 2 | `sessionTracker.onChange` in newChat view | NICE-TO-HAVE | Store dedup makes it a no-op; covered by #1 fix |
| 3 | `responseOptions` rendering when in newChat | NICE-TO-HAVE | Invisible but harmless; covered by #1 fix |
| 4 | `hasText` staleness when in newChat | IMPORTANT | Same root cause as #1; needs spec + plan note |
| 5 | Textarea listener lifecycle Phase 2 → 3 | NICE-TO-HAVE | Correctly handled, no issue |
| 6 | `suppressNextInput` actionability | Resolved | Plan wording is actionable enough |
| 7 | Two-instance isolation test + singleton store | IMPORTANT | Test should assert newChat doesn't set `hasText` |
| 8 | `getLastInput()` per-form awareness | IMPORTANT | Spec says "per-view" but code returns '' for newChat; fix spec wording or defer |
| 9 | Inter-phase handoff clarity | NICE-TO-HAVE | Already clear, no change needed |
| 10a | `updateButton` viewState guard missing from plan | IMPORTANT | Same fix as #1 |
| 10b | `resetTextareaHeight` + `tryExecuteSlashCommand` still query `#chatForm` | IMPORTANT | Plan 3.4.2 doesn't explicitly address these standalone functions |

### Required changes before Phase 3 is executable

1. **Plan 3.4.3:** Add `if (chatView.getViewState() !== 'chatting') return;`
   guard at top of `updateButton`. This resolves points 1, 2, 3, 4,
   and 10a in one line. (Points 1 + 4 are IMPORTANT.)

2. **Plan 3.4.2:** Explicitly address `resetTextareaHeight` (line
   214) and `tryExecuteSlashCommand` (lines 237–238) as standalone
   functions that also query `#chatForm`. Specify the replacement
   strategy (take args or use `getActiveForm()`). (Point 10b,
   IMPORTANT.)

3. **Plan 3.2.6:** Add test case: "newChat controller's `attach()`
   input listener does NOT call `formStateStore.set`." (Point 7,
   IMPORTANT.)

4. **Spec line 87:** Change "Up-arrow recall: per-view (each view's
   last input)" to "Up-arrow recall: per-session (newChat has no
   session; up-arrow is a no-op there)" — or add a plan step to
   implement per-view recall. (Point 8, IMPORTANT.)

Phase 2 is executable as-is. Phase 3 needs items 1–4 above before
Sonnet can execute without guesswork.
