# review — chat-form-refactor.md (R1 + R3) and plan.md (Phases 2 & 3)

Reviewer: spec-review pass, "did NOT write" path of
`~/.copilot/skills/review-spec/SKILL.md`. Quality bar:
`~/.copilot/skills/create-spec-plan/code-quality.md`.

Documents under review:
- `docs/chat-form-refactor.md` (spec)
- `plan.md` (Phases 2 and 3 — Phase 1 not under review)

Verdict: **Phase 2 has one BLOCKER (autoresize regression) plus
several IMPORTANT gaps. Phase 3 is under-specified in two structurally
important places (submit-handler relocation, responseOptions
duplication) and contains a workflow contradiction (branching off an
uncommitted Phase 1). Sonnet can execute Phase 2 after the BLOCKER is
fixed; Phase 3 needs more design before another agent can act on it.**

---

## BLOCKER

### B1. Removing `dispatchEvent('input')` breaks autoresize / slash / pound on every programmatic value-set

`public/ts/multiline-input.ts:68-72` attaches a SECOND `input`
listener on the chat textarea, distinct from message-streaming's
`updateButton` listener:

```ts
textarea.addEventListener('input', () => {
  autoResize(textarea);
  handleSlash(textarea, anchor);
  handlePound(textarea, anchor);
});
```

`autoResize` is **not exported** (`multiline-input.ts:206`,
inspected via `grep "export function" public/ts/multiline-input.ts`).

Plan steps 2.4.1, 2.4.2, 2.4.3, 2.4.4, 2.4.5, 2.4.6 all remove the
`dispatchEvent(new Event('input', { bubbles: true }))` and replace it
with a `formStateStore.set({ hasText: ... })` call. That fixes the
Send button, but it **silently breaks**:

- **Autoresize** on `restoreDraft` of a multi-line draft (e.g. user
  had pasted a 50-line snippet, switched sessions, switched back —
  textarea stays at 1 row, content scrolls).
- **Autoresize** on up-arrow recall of a multi-line message
  (`multiline-input.ts:101`).
- **Autoresize** on prompt-template apply (`main.ts:162`).
- **Autoresize** on `restoreFailedPrompt` (`chat-view-controller.ts:599`)
  and dispatch-failure restore (`message-streaming.ts:366`).
- Slash/pound popup re-evaluation in any of the above (less critical;
  programmatic restores rarely contain `/` or `#` triggers).

Plan step 2.4.4 hand-waves: *"Autoresize is called explicitly via the
existing autoresize helper if needed (search for autoResize in the
file)."* — but the helper is module-private and there is no exported
equivalent. Sonnet would either (a) skip it and ship a regression, or
(b) export `autoResize` and import it into five files, which is its
own coupling cost.

**Required fix:** the spec must decide on ONE of:

1. **Export `autoResize`** (and `resetTextareaHeight` is already
   exported), then add explicit `autoResize(textarea)` calls at each
   site where a programmatic value-set happens. Plan steps 2.4.1-2.4.6
   must list those calls.

2. **Keep the dispatchEvent** at programmatic-value-set sites and only
   delete it from the *synthetic-signal* sites
   (`setResponseOptions`, `session.idle`, `sessionTracker.onChange`).
   The bleed bug was caused by synthetic events that carried no value
   change; events that follow a real `textarea.value = X` write are
   semantically *real* inputs and should keep firing. Re-frame R1 as
   "delete synthetic-signal events", not "delete every dispatchEvent."

Option 2 is closer in spirit to "the listener fires only on real user
gestures" if "real" means "real value change" — and it preserves
correctness without exporting internals. Either way the spec must
choose and the plan must follow.

Acceptance criterion R1 #1 ("Zero `dispatchEvent('input')` calls on
the chat textarea") needs to be re-stated to match whichever option
is chosen.

---

## IMPORTANT

### I1. Plan step 2.2 misses two `currentOptions` write sites

`grep -n currentOptions public/ts/message-streaming.ts`:

```
39:  let currentOptions: string[] = [];           (decl)
50:  currentOptions = options;                    (setResponseOptions)
124: currentOptions = d.responseOptions;          (session.idle)
309: currentOptions.length > 0                    (updateButton read)
335: renderOptions(optionsEl, currentOptions, …)  (updateButton read)
364: currentOptions = [];                         (response-option click)
438: currentOptions = [];                         (submit handler)
```

Plan steps 2.2.1, 2.2.2, 2.2.3 cover lines 39, 49-54, 309, 335, 124.
**Lines 364 and 438 are not addressed.** Both are writes that must
become `formStateStore.set({ options: [] })`. Step 2.2.4
(`grep currentOptions; expect zero`) will catch the omission at
implementation time, but the plan as written tells Sonnet to leave
them; Sonnet then sees the grep fail and has to guess at the
replacement. Add explicit sub-steps 2.2.5 and 2.2.6.

### I2. R1 array-equality contract: mutation hazard not addressed

Spec §"Phase R1" shows element-wise compare for `options` but
`get()` returns the underlying array by reference (`Readonly<FormState>`
is structural-only at compile time; runtime is the same array).
Subscribers can call `state.options.push(...)` and corrupt the store
in place — and the next `set({ options })` from outside will
short-circuit because the new array element-equals the corrupted
internal array.

Risks #2 names this risk vaguely ("two distinct-but-equal arrays
would trigger a notify") but addresses the wrong direction (false
positives, not silent mutation).

**Required fix:** spec must commit to one of:

- **Freeze on set:** `internal.state = { ...internal.state, options:
  Object.freeze(b.slice()) }`. Cheap; catches mutators at runtime in
  dev mode (TypeError on strict mode).
- **Clone on get:** `get()` returns a defensive copy. More expensive;
  subscribers that read on every change pay each time.
- **Read-only by convention, no enforcement:** then the spec must
  explicitly say so, and the unit test in Step 2.1.2 must include a
  case showing what "should not be done" so reviewers know.

A one-liner `Object.freeze(b)` inside `set` is the lowest-cost
option; it composes with `Readonly<>`.

### I3. R1 acceptance criterion #5 (net line reduction ~20-40) is not achievable

Hand count from the source files:

Removed (Phase 2):
- `let currentOptions` decl + 4 mutation sites: ~5 lines.
- 2× `const ta = …; ta?.dispatchEvent(…)` in message-streaming.ts: 4 lines.
- 3× same idiom in chat-view-controller.ts (restore/hydrate/failed): 3 lines.
- `multiline-input.ts:101` + `main.ts:162` + `message-streaming.ts:366` dispatchEvents: 3 lines.
- `suppressNextInput` field + guard branch (~5 lines).
- `lastSeenInputValue` field + guard branch (~3 lines).
- `refreshFormState` module-let + assignment (added in Phase 1, deleted in 2.2.1): 2 lines.
- Direct `updateButton()` call in `sessionTracker.onChange`: 1 line.
- Total removed: ~26 lines.

Added (Phase 2):
- `form-state-store.ts` module: ~35 lines per the spec template.
- 4-5 `import { formStateStore } from './form-state-store.js'`: ~5 lines.
- 6+ `formStateStore.set({ hasText: ... })` calls (5 sites for hasText, plus options): ~7 lines.
- `formStateStore.subscribe(() => updateButton())` + busy-update subscriber body: ~6 lines.
- If B1 fix-option-1 is chosen: 5 `autoResize(textarea)` calls + import: ~6 lines.
- Total added: ~55-60 lines.

Net: **+25 to +35 lines**, not −20 to −40. The new module pays for
itself in clarity, not LOC. Retarget acceptance #5 to: *"line count
within ±20 of baseline; new module justified by single-responsibility
of form state"* — or drop the criterion. As written it will fail and
mislead reviewers about whether Phase 2 succeeded.

### I4. Phase 3 branches off an uncommitted Phase 1

Plan step 1.5.4: *"STOP. Do NOT commit per implement-plan skill
rules. Hand back to the user."*

Plan Phase 2 preamble (line 237-239): *"Branch: new `chat-form-r1`
off the Phase-1 commit (assumed merged to master by this point)."*

These contradict. Phase 1 finishes uncommitted; Phase 2 cannot
branch off a commit that does not exist. The "assumed merged to
master by this point" parenthesis acknowledges a gap but doesn't
specify *who* makes that happen.

**Required fix:** add a Step 1.5.5 (or document at the top of
Phase 2): *"Before starting Phase 2: user reviews Phase 1 changes,
commits, opens PR, merges to master. New agent session begins
Phase 2 from a clean master checkout."* Same edit applies to the
Phase 2 → Phase 3 transition (Phase 2 ends at step 2.6.7 with the
same "do not commit" instruction).

### I5. R3 plan step 3.2.4 ("move setupFormHandler into ChatFormController.attach()") is under-specified

`setupFormHandler` (`message-streaming.ts:289-446`) is 158 lines and
has structural dependencies that the plan doesn't address:

1. **`chatRegion` initialization** (line 294):
   `chatRegion = new ChatRegion(regions.chat)`. There is exactly one
   `#chat` region. If both forms' `attach()` runs this, the second
   call overwrites the first. Plan must specify: this init goes in
   `main.ts` (or only `chattingForm.attach()` does it).

2. **`registerWsHandlers()`** (line 296): registers websocket event
   listeners. Single-shot — calling twice would double-dispatch every
   event. Same fix needed.

3. **`steerCount`** (line 38, mutated at 397, 411, 417, 437): only
   meaningful for the chatting form. Either move to `chattingForm`
   instance state, or leave module-scoped with a guard.

4. **`getActiveSessionId()` reads** at lines 306, 352, 379: per
   spec §"Risks #6", `ChatFormController` *must not* call
   `getActiveSessionId()`. Plan should state explicitly: chatting
   form's submit handler uses `this.binding.sessionId`; new-chat
   form's handler ignores it (no session yet). This resolves
   review point 9 in the prompt — but currently the plan only says
   "queries become `this.form.*` references" which is silent on
   `getActiveSessionId()`.

5. **`isNewChat = isViewState('newChat')` branch** (line 429): the
   chatting form's submit handler doesn't need this branch (always
   false); the new-chat form's handler doesn't need it (always
   true). The handler bodies diverge cleanly — but the plan says
   "the handler logic stays". Specify: extract the common send path
   into a helper; each form's handler calls it with its own
   sessionId/cwd.

6. **`chatView.setFormEnabled(false)`** at line 436: per-form too.
   View-controller.ts:65-79's `setFormEnabled` queries
   `#chatForm` — after Phase 3 this querySelector dies (no element
   with that id). `setFormEnabled` must be moved or rewritten.

Plan step 3.2.4 ("Expose hooks the controller calls into
ChatViewController... The handler logic stays; just queries become
this.form.* references") understates this work by an order of
magnitude. Spec open question #2 calls it "the largest structural
change in R3" but the plan doesn't acknowledge that. Add explicit
sub-steps 3.2.4.1 through 3.2.4.6 covering the six points above.

### I6. R3 responseOptions duplication is unaddressed

Plan step 3.1.1 duplicates the `responseOptions` div into both
forms. Spec §"What about the `currentOptions` module-level let"
(line 339-342) acknowledges "response options only make sense for
the chatting view — new-chat shows them too currently, but the only
call sites are from message-streaming which is chat-driven" — but
makes no decision.

The newChatForm's `responseOptions` div is dead DOM (no code ever
writes options to it; no session is active there). It should not
be duplicated.

**Required fix:** Plan step 3.1.1 should say: only `chattingForm`
gets `<div id="responseOptions">`. newChatForm omits it. The per-
form store's `options` field then only matters in the chatting
controller; newChatForm's subscriber that renders options is a
no-op or absent.

Bonus: if response options are chatting-only, the store's `options`
field doesn't need to be per-form either — but per-form stores are
fine, just makes new-chat's a degenerate case. Acceptable.

### I7. R3 spec misdiagnoses paste / drag-and-drop wiring

Spec §"Drag-and-drop, paste, image upload" and Risks #4 say these
"attach to the textarea today" and "become per-form attachments".

Actual code (verified via
`grep -rn "paste\|dragover\|drop" public/ts/`):

- `image-paste.ts:18`: `document.addEventListener('paste', ...)` —
  **document-level**, not textarea-attached. No per-form change
  needed.
- No `dragover` / `drop` handlers on the chat textarea exist
  today. (session-panel.ts has drag handlers but for the session
  list, not the chat input.)

Plan step 3.2.1 says `attach()` installs "input, keydown, submit,
paste handlers". The paste handler doesn't exist on the textarea;
listing it implies work that isn't there.

**Required fix:** spec must correct the diagnosis. paste already
works regardless of which textarea is in the DOM (document-level
listener), so no per-form wiring is needed. Drop the per-form
"paste handler" item from `attach()` and from Risks #4. Optionally,
spec could note that document-level paste means image-paste
already survives R3 trivially.

### I8. R3 spec leaves open question #2 unresolved

Spec §"Open questions" #2 (where the submit handler lives) is
written as a recommendation, not a decision: *"Recommendation: move
into ChatFormController.attach()..."*. Plan step 3.2.4 acts on the
recommendation as if it were decided.

The spec must promote the recommendation to a decision before
review-pass approval. If it stays "open", a future agent reading
the spec alone (without plan.md) would have to redecide.

Also: spec open question #1 (single `sessionDrafts` Map vs per-form
draft state) has a recommendation that the plan never references.
Plan step 3.3.3 says "Remove `activeBinding`, ... `onDraftInput`
from ChatViewController" but doesn't say what happens to
`sessionDrafts`. Per spec open question #1 it should stay on
ChatViewController. Plan should say so explicitly.

---

## NICE-TO-HAVE

### N1. `chatFooter` becomes asymmetric after R3

After Phase 3, `#chatFooter` contains only `#adHocBar` and
`#contextFooter`. It's still styled as a chat footer, but the form
is gone from it — the chatting form floats inside `#chat`, above
the footer. New-chat view has its own form but no adHocBar (the
adHocBar lives in chatFooter, which is only shown in the chat
view). This is arguably fine — adHocBar is session-scoped, new-chat
has no session — but the spec should at least call out the layout
delta. A one-paragraph note under §"Phase R3" explaining what
`#chatFooter` looks like post-refactor (and that adHocBar stays
where it is, since image-paste already addresses it via
`document.getElementById('adHocBar')`) would prevent Sonnet from
"helpfully" duplicating it into both views.

### N2. `bindForms` API is a serviceable choice; document the alternative

Plan step 3.3.2 introduces
`chatView.bindForms({ newChat, chatting })`. This is two-way
coupling (forms know controller via hooks; controller knows forms
via this setter). An alternative is constructor injection: forms
constructed in `main.ts`, passed into `new ChatViewController(...)`.
That's a larger change (ChatViewController is currently an exported
singleton: `chat-view-controller.ts:` last line presumably exports
`chatView`). The setter approach keeps the singleton intact, which
is consistent with the rest of the codebase. Accept the
recommendation; a one-line note in the spec acknowledging
"singleton compatibility is why we use a setter, not constructor
injection" would future-proof the design rationale.

### N3. R3 `getActiveForm()` helper is mentioned in Risks #5 but not in plan

Risks #5 proposes `getActiveForm()` on ChatViewController. Plan
step 3.3.4 says "Update all `getTextarea()` callers to use
`this.activeForm?.textarea`, where activeForm is whichever form's
view matches `getViewState()`." But `activeForm` isn't defined
anywhere as a field or accessor. Add: "Implement
`ChatViewController.getActiveForm()` as a getter that returns
`getViewState() === 'chatting' ? this.chattingForm : this.newChatForm`."

### N4. Per-form store via factory: small spec/plan inconsistency

Spec §"Phase R3" line 281-289 says R1 stays per-form: *"there's ONE
store but state-by-form: `Map<view, FormState>`. Recommended: one
store per controller (instance-level)"* — then introduces
`createFormStateStore()`. Plan step 3.2.2 says "Refactor to export
factory in addition to (or instead of) the singleton."

"In addition to or instead of" is ambiguous. Pick one:

- **Replace the singleton entirely** in Phase 3. Clean. Forces all
  callers to take a store reference. More files touched.
- **Keep the singleton and add the factory.** Two ways to do the
  same thing → violates code-quality rule "only one way to do one
  thing".

Recommend: replace the singleton. Each `ChatFormController`
constructs its own; subscribers in message-streaming.ts that today
import the singleton get refactored to receive a store reference
from the controller they're attached to.

### N5. Test inventory misses two real tests

Spec §"Test environment" lists unit + integration tests but doesn't
mention:

- A test that exercises the autoresize fix (whichever option from
  B1 is chosen). Particularly important since the bug surface
  here is "draft restored, textarea didn't grow" — easy to miss
  in smoke testing.
- A test that asserts the store does *not* notify on duplicate
  set (the no-op-on-unchanged-value contract). Plan step 2.1.2
  mentions it; spec should too.

---

## Summary

| Area | Severity | Item |
|---|---|---|
| Autoresize lost after removing dispatchEvent | BLOCKER | B1 |
| `currentOptions` writes at 364/438 not in plan | IMPORTANT | I1 |
| Array mutation hazard in store | IMPORTANT | I2 |
| Net line-count target unattainable | IMPORTANT | I3 |
| Phase 2 branches off uncommitted Phase 1 | IMPORTANT | I4 |
| `setupFormHandler` move under-specified | IMPORTANT | I5 |
| `responseOptions` duplication unaddressed | IMPORTANT | I6 |
| Paste / drop wiring misdiagnosed | IMPORTANT | I7 |
| Spec open questions unresolved | IMPORTANT | I8 |
| `chatFooter` post-refactor layout note | NICE | N1 |
| `bindForms` rationale | NICE | N2 |
| `getActiveForm()` undefined in plan | NICE | N3 |
| Factory vs singleton ambiguity | NICE | N4 |
| Test inventory gaps | NICE | N5 |

**Phase 2 is executable by Sonnet after B1, I1, I2, I3, I4 are
resolved.** B1 in particular is a real semantic break that smoke
testing would catch but only if the smoke tester knows to paste a
multi-line draft, switch sessions, and switch back.

**Phase 3 is not yet executable by Sonnet without guesswork.** I5,
I6, I7, I8 leave too many structural decisions to the implementer.
Recommend a second spec/plan pass for Phase 3 before handing off,
or scope Phase 3 down to "HTML split + per-form draft binding" and
defer the `setupFormHandler` relocation to a Phase 4.
