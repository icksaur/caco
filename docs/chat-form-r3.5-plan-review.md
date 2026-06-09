# R3.5 Implementation Plan — Review

Scope: `plan.md` (R3.5 active plan) against the working tree at the
start of R3.5. Spec is `docs/chat-form-r3.5.md` (locked); spec review
already incorporated. This review walks the focus questions from the
user prompt and surfaces gaps that would cause a Sonnet executor to
get stuck or ship a regression.

Overall verdict: the plan is **close to executable** but has **three
BLOCKERs** that will produce broken behaviour or non-runnable tests
if executed verbatim, plus several IMPORTANTs that need a sentence or
two of clarification before handoff. None require respec — all are
plan-level edits.

---

## BLOCKERs

### B1. Nobody installs `autoResize` on the `input` event after R3.5a

`plan.md:42-47` (Step 1.1) defines `FormPopups.attach()` as:

> Inside the input listener: call the private `handleSlash` /
> `handlePound` methods.

— and nothing else. Step 1.2 (`plan.md:78-84`) adds a **keydown**
listener for Enter / ArrowUp on the controller. The existing
`ChatFormController.attach()` (`public/ts/chat-form-controller.ts:81-83`)
already installs an `input` listener for draft logic
(`this.onInput()`), which deliberately does **not** call
`autoResize`.

Current behaviour (`public/ts/multiline-input.ts:67-72`) calls all
three in one listener:

```ts
textarea.addEventListener('input', () => {
  autoResize(textarea);
  handleSlash(textarea, anchor);
  handlePound(textarea, anchor);
});
```

After Step 1.7 deletes `setupMultilineInput` and Step 1.5 removes
both calls to it from `main.ts`, **no input listener calls
`autoResize`**. The textarea will stop growing as the user types.
The spec at `docs/chat-form-r3.5.md:139-141` says "autoResize stays
(utility used by both FormPopups and the controller)" but the plan
never wires it back into an input event.

**Fix:** In Step 1.1, change `FormPopups.attach()`'s input listener
to call `autoResize(this.textarea)` as its first action (matching
current behaviour). Alternatively, extend `ChatFormController.onInput`
to call `autoResize(this.textarea)` before its draft logic — but
FormPopups is the natural owner because it already imports
`autoResize` per the same step.

### B2. Step 3.4 boot-order direction is wrong; `connectWs()` must MOVE

`plan.md:305-333` (Step 3.4) instructs:

> Connect WebSocket LAST.
> (Existing connectWs() call stays at its current later position.)

But the existing `connectWs()` call is at `public/ts/main.ts:116`,
**before** the form-controller construction (lines 146-152) and
**before** `setupFormHandler()` (line 153). There is no "later"
position — `connectWs()` is currently the EARLIEST of those calls,
followed by `await waitForConnect()` at line 117.

The invariant Step 3.4 documents ("initMessageStreaming() must run
before connectWs() — registers the WS event handlers") is correct;
the *instruction* contradicts it. As written, an executor will leave
`connectWs()` at line 116 and `initMessageStreaming()` somewhere
after, leaving `registerWsHandlers()` unregistered when
`connectWs()` fires its first events.

**Fix:** Add an explicit step:

> Move `connectWs(); await waitForConnect();`
> (currently `main.ts:116-117`) to after
> `chattingForm.attach()` (current line 152). The new order is:
> `initRegions → initViewState → initMessageStreaming → construct controllers → bindForms → attach → connectWs → waitForConnect`.

Also confirm that nothing between the current line 116 (`connectWs`)
and line 156 (last `setupMultilineInput`) silently depends on WS
being already connected — `loadModels`, `loadSessions`, etc. are
async fetches over HTTP, so they're fine.

### B3. Step 6.3 (CSS regression test) and Step 6.1 (popup tests) require jsdom; project has none

`vitest.config.ts` sets `environment: 'node'`. `package.json` has no
`jsdom` or `happy-dom` dependency. The existing
`tests/unit/chat-form-controller.test.ts:28,92` explicitly notes
"jsdom is not configured in this suite; build a minimal stand-in"
and drives listeners manually.

Step 6.3 (`plan.md:466-473`) says:

> load `public/index.html` and `public/style.css` into jsdom […]
> Assert `getComputedStyle(chattingForm).display === 'none'`.

Step 6.1 (`plan.md:431-449`) drives `mousedown` events on popup DOM
elements that don't exist in node — `InputPopup` is a real DOM
construct.

**Fix:** Either

1. Add `jsdom` as a devDependency and switch the affected files via
   the `// @vitest-environment jsdom` directive (one-file scope).
   List the dependency add in Step 0.x. Update Step 6.4 to verify.
2. Or downgrade the CSS regression test to a parser-level check
   (parse `public/style.css` with a CSS AST library already in the
   dep tree, assert no rule with selector `form` sets
   `display: flex` without `:not([hidden])`).

The popup tests in 6.1 cannot reasonably avoid jsdom — go with
option 1.

---

## IMPORTANTs

### I1. `getCommands` import is missing from Step 1.1's lift list

`handleSlash` (`public/ts/multiline-input.ts:148`) calls
`getCommands()`. Plan Step 1.1 (`plan.md:51-53`) only names
`findCommand` as the symbol to import from `./command-registry.js`
for `openPicker`. Add `getCommands` to the import list explicitly,
otherwise the lifted `handleSlash` will reference an undefined
symbol and tsc will fail.

### I2. Step 1.1 file:line range is misleading

`plan.md:39,59,70` cites "lines 109-194" / "108-194" of
`multiline-input.ts` as the source of `handleSlash` / `handlePound`
/ `findPoundTrigger`. Actual ranges:

| symbol             | actual lines |
| ------------------ | ------------ |
| `findPoundTrigger` | 53-65        |
| `setupMultilineInput` | 67-106    |
| `handleSlash`      | 111-157      |
| `handlePound`      | 159-208      |
| `fetchProjectFiles` + cache vars | 32-51 |
| `autoResize`       | 210-215      |

The cited range misses `findPoundTrigger`, the cache vars, and
`fetchProjectFiles`; and stops mid-`handlePound`. The plan does
enumerate the symbols by name (so a careful executor will grep), but
fix the range to `32-65, 111-208` (and `210-215` for autoResize) so
the line numbers don't actively mislead.

### I3. Step 2 → Step 3 ordering: `sessionBusy` store flow has a gap

Step 2.3 (`plan.md:220-221`) instructs `refreshButton` to read
`isBusy` from `formStateStore.get().sessionBusy`. Step 2.5
(`plan.md:259-260`) deletes the existing
`sessionTracker.onChange(() => formStateStore.set({sessionBusy}))`
listener. Step 3.2 (`plan.md:285-296`) re-installs the equivalent
listener inside `initMessageStreaming`.

If Steps 2 and 3 land in separate commits, between them the
`sessionBusy` field of the store is never written, so `refreshButton`
will always see `false`. Smoke testing in Step 2.7 will pass while
the session is idle but fail on the "Steer a busy chatting session"
case.

**Fix:** Either (a) collapse Step 3.2's listener install into Step
2.4's `attach()` work (and have Step 3.2 just move the rest), or (b)
add an explicit note to Step 2.5: "Do not commit between Step 2 and
Step 3 — the sessionBusy listener move must land atomically with
its consumer." Option (a) is cleaner because it removes the implicit
inter-step coupling.

### I4. `_pendingPickerCmd` removal is correct; document it

The picker dismiss path question (Q3) checks out: in current code
(`public/ts/multiline-input.ts:246,253,260`), `_pendingPickerCmd` is
written but never **read** anywhere (it's dead state). The
`onSelect` / `onDismiss` closures in `openPicker` already capture
`cmdName` by closure, so the new `openPicker(cmdName)` per spec
§R3.5a covers restoration of `/cmdName ` on dismiss.

Add one sentence to Step 1.4 noting "`_pendingPickerCmd` is dead
state — never read; safe to delete with `pickerPopup`" so the
executor doesn't pause looking for what it tracked.

### I5. Step 4.5 chosen hook (sessionTracker.onChange) is broad

Plan Step 4.5 (`plan.md:377-388`) suggests `sessionTracker.onChange`
or "a new `chatView.onSessionChange` if one exists" for image
session-switch clear. Confirmed: `chatView.onSessionChange` does
**not** exist (`grep -rn "onSessionChange" public/ts/` matches only
`applet-runtime.ts`).

`sessionTracker.onChange` fires on **every** state change of every
session (busy flip, name edit, intent update, ...). The plan's
predicate (`getActiveSessionId() !== lastObservedSessionId &&
lastObservedSessionId !== null`) is sound but will iterate on every
tick. Acceptable, but consider adding `chatView.onActiveSessionChange`
since other modules (image-paste, future code) want exactly this
signal. Not a blocker; just call out the choice in the plan.

### I6. Step 6.2 imageData-isolation test needs a spy seam

The test "submit newchat form (mock dispatchPrompt); assert received
args include `imageData: ''`" requires `dispatchPrompt` to be
spy-able. Step 2.1 exports it as a module function from
`message-streaming.ts`; vitest can `vi.spyOn` an `import * as MS`
namespace. Confirm in Step 2.1 that the export is `export async
function dispatchPrompt` (not `const`) so the namespace is mutable
for the spy. The plan already shows it as `export async function` —
just add a note that the test depends on this form.

### I7. Step 2.3 must keep `computeFormState` import

Step 2.5 (`plan.md:251-264`) lists deletions in
`message-streaming.ts`. The plan does NOT say to remove the
`computeFormState` import (line 34), which is correct — Step 2.3's
`refreshButton` continues to use it (lifted from the closure body at
`message-streaming.ts:316`). But the controller now needs to import
`computeFormState` from `./form-state.js` directly. Add an explicit
line: "Step 2.3: `import { computeFormState } from './form-state.js'`
at the top of `chat-form-controller.ts`."

### I8. Step 4 backend audit — confirmed safe

Confirmed via `grep -n "router.post.*'/sessions'" src/routes/sessions.ts:195`:
the POST /api/sessions handler reads only
`{ cwd, model, description, parentSessionId, isSwarmSession, kind }`
from the body. The form is `novalidate` and the submit handler
builds the JSON body manually; the hidden `imageData` field is not
auto-included. Adding `<input type="hidden" name="imageData">` to
`newChatForm` is a no-op for the backend. ✅

---

## NICE-TO-HAVE

### N1. Consolidate per-step live smokes

Steps 1.11, 2.7, 3.6, 4.8, and 7.3 all describe manual smoke. Step
7.3 already covers the full set. Per-phase smokes are useful for
catching regressions early during implementation but they duplicate
7.3. Either keep them and reduce 7.3, or label them "developer
sanity, not gating".

### N2. Step 7.2 line-count target should include the new file

Step 0.2 baseline is four files (1074 lines). Step 7.2 lists five
files including the new `chat-form-popups.ts`. The "−50 to −100 net"
target was derived without the new file in the baseline; the new
file adds ~150 lines (estimate). Either restate the target as "net
delta across all five files" with a realistic number, or call out
that the target excludes the new file.

### N3. Step 2.4 stop-button handler could use `this.binding?.sessionId`

The plan keeps `getActiveSessionId()` inside the stop-button click
handler (Step 2.4, `plan.md:231-235`). For the chatting form,
`this.binding?.sessionId` is equivalent and removes one module
dependency. Not required — the active-session approach is correct
because there's only one chatting session at a time — but the
plan should note the deliberate choice so a reviewer doesn't flag
it.

---

## Cross-check: deletions in Step 2.5 / Step 1.7 are safe

Grepped (`wireFormSubmit | setupFormHandler | setupMultilineInput |
tryExecuteSlashCommand | resetTextareaHeight`) across `public/ts/`,
`src/`, `tests/`:

- `wireFormSubmit` — local to `message-streaming.ts`. ✅
- `setupFormHandler` — imported only by `main.ts:10`. Step 3.4 swaps
  it for `initMessageStreaming`. ✅
- `setupMultilineInput` — imported only by `main.ts:16`. Step 1.5
  removes both call sites; Step 1.7 removes the export. ✅
- `tryExecuteSlashCommand` — imported by `message-streaming.ts:23`.
  Step 1.8 replaces the call site; Step 1.7 removes the export. ✅
- `resetTextareaHeight` — imported by `message-streaming.ts:23` and
  `view-controller.ts:16`. Step 1.6 + Step 1.8 swap call sites; Step
  1.7 removes the export. ✅
- `computeFormState` — still used by the lifted `refreshButton`; the
  import must MOVE to `chat-form-controller.ts` (see I7).

No external consumer is left dangling.

---

## Plan executability summary

After the BLOCKERs above are addressed, the plan is executable
end-to-end by a Sonnet session without further guidance. The
ordering of phases (R3.5a → b → c → d → e → tests) is correct and
each phase ends in a build+test+smoke gate.

Required edits before handoff:

1. Step 1.1: add `autoResize(this.textarea)` to FormPopups input
   listener; add `getCommands` to import list; correct file:line
   citations.
2. Step 3.4: add explicit instruction to MOVE `connectWs()` +
   `waitForConnect()` from `main.ts:116-117` to after
   `chattingForm.attach()`.
3. Step 6: add jsdom devDependency and `// @vitest-environment jsdom`
   directives to `chat-form-popups.test.ts` and
   `css-regression.test.ts` (or drop the css-regression test in
   favour of a CSS-AST parser check).
4. Step 2.4 + Step 3.2: collapse the `sessionTracker.onChange →
   formStateStore.set({sessionBusy})` listener move so it lands
   atomically with `refreshButton`'s consumption of the new field.
5. Step 2.3: add an explicit `import { computeFormState }` line.
6. Add brief notes for I4, I5, I6, N3 so the executor doesn't
   second-guess intentional decisions.
