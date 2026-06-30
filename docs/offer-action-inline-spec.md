# Spec: inline offer-action (remove the caco_offer_action tool call)

## Goal

Keep the "1–4 clickable next-step buttons" feature but stop paying for it as a
tool. Today `caco_offer_action` costs two things:

1. **Steady-state schema tax (the primary win):** 616 B (~154 tokens) of tool
   description + parameter schema sent and re-sent on **every** model turn, whether or
   not actions are offered. Removing the tool removes this from every turn forever.
   This is the honest, unconditional payoff.
2. **Per-offer round trip (secondary, conditional):** the tool is called at the end of
   a turn. In the worst case this forces one extra model invocation; but with
   `parallel_tool_calls` the call can ride alongside the final turn, so the marginal
   round-trip saving is small and not guaranteed. Treat this as a minor bonus, not a
   headline.

Non-goal: changing the UX. The pinned buttons above the input, the click-sends-the-
text behaviour, and persistence across session switch should be preserved.

## Current behaviour (the contract to preserve)

- Tool `caco_offer_action({ options: string[] })`, 1–4 items, ≤50 chars each.
- Handler writes `meta.responseOptions` (session-meta-store).
- On `session.idle` the client reads `responseOptions` from `/api/sessions/:id/state`
  and sets `formStateStore.options`; `chat-form-controller` renders
  `.response-option-btn` buttons (text = `data-prompt`, both escaped). Click sets the
  textarea to the option text and submits it as the next message.
- `responseOptions` is cleared on the next send and is restored on session switch
  (`chat-view-controller` reads `data.responseOptions`).
- The button label **is** the prompt — there is no separate label/payload today.

## Design — proposals

All proposals replace the tool with a convention the model emits inline, taught via
the system prompt (the user notes the model reliably follows tool/format
instructions, so schema enforcement is not required).

### Proposal A — fenced `caco-actions` block, parsed (RECOMMENDED)

The model ends its message with a fenced block, one option per line:

```` 
```caco-actions
Fix the failing auth test
Add a regression test for the parser
Refactor the duplicated helper
```
````

Parsing produces the same `responseOptions` the tool wrote; the block is stripped
from the rendered message and the existing pinned-button UI renders unchanged.

Two parse sites are possible (sub-decision, see Considerations):
- **A1 client-side:** the markdown `code()` renderer recognises the `caco-actions`
  language, renders nothing for it (no flicker), and on `finalize()` the client
  extracts the options and feeds `formStateStore` directly. Simplest; one place owns
  parse + strip + render. Loses cross-session persistence unless also posted back.
- **A2 server-side:** a dispatch hook scans the completed assistant message, extracts
  the block, writes `meta.responseOptions` (identical to today → persistence/restore
  preserved). The client still must hide the block for display (renderer returns
  empty for the `caco-actions` language).

Why fenced: unambiguous (never collides with prose or a real code sample of a
different language), atomic enough to survive streaming, trivial to strip, and it
feeds the **existing** pinned-button UI — identical UX to today.

### Proposal B — inline action links (the user's idea)

The model writes markdown links with a custom scheme, e.g.
`[Fix the test](caco-action:Fix%20the%20test)`. The client intercepts clicks on
`caco-action:` links and sends the decoded text.

Rejected as the highlight: (1) buttons would render **inline mid-message**, not
pinned at the input — a UX change; (2) links allow a label≠payload split, which is a
spoofing surface (a link reading "Cancel" could send "delete everything"); the
current feature has no such split; (3) custom-scheme links interact awkwardly with
DOMPurify allowlisting. Viable as a fallback but strictly worse than A on UX and
safety.

### Proposal C — single sentinel line

A one-line trailer, e.g. `::caco-actions:: Fix the test | Add a test | Refactor`,
parsed client-side. Lighter than a fenced block but fragile under streaming (partial
lines), and markdown may mangle `|`/`::`. Weaker than A for no real gain.

### Proposal D — hidden HTML-comment trailer

`<!--caco-actions:["Fix the test","Add a test"]-->`. Exact JSON payload, naturally
invisible — but DOMPurify strips comments, so it must be parsed from the raw text
before sanitising, and authoring raw HTML/JSON is awkward for the model. More moving
parts than A for the same result.

## Recommended design: Proposal A, server-side parse (A2)

A2 is the literal "server sees it and does the equivalent of the tool call" the user
described, and it is the only option that preserves **persistence/restore** for free
(it writes the same `meta.responseOptions`). The client change is limited to hiding
the `caco-actions` code block during render.

Mechanics:
1. **System prompt:** replace the `caco_offer_action` nudge with the fenced-block
   convention + the same rules (1–4 options, ≤50 chars, self-contained instructions,
   no stop/cancel options).
2. **Server parse:** in `applyDispatchEventEffects` (the dispatch hook that already
   handles `assistant.usage`/tool-complete for D1 metrics), handle `assistant.message`
   — its `data.content` is the full assistant text (same field `delegate-tool` reads).
   Extract the last ```` ```caco-actions ```` block, apply the same validation/trim/
   truncation the tool did (`MAX_OPTIONS=4`, `MAX_OPTION_LENGTH=50`, drop blanks), and
   write `meta.responseOptions`. Reuse the existing clear-on-next-send logic untouched.
3. **Client hide:** the `marked` `code()` renderer returns empty output for language
   `caco-actions` so the block never appears in the transcript (covers streaming and
   final render). Pinned-button render/click pipeline is unchanged.
4. **Bake-in, then remove.** Ship the parser + prompt convention WITH the tool still
   registered for a bake-in period (dual-path: both the tool and the inline block write
   `meta.responseOptions`; whichever the model uses works). Only after the reliability
   benchmark (below) confirms the model emits the block correctly do we delete
   `caco_offer_action` + `createOfferActionTool` (file + server wiring) and the prompt's
   tool mention. The −616 B/turn lands at deletion; the bake-in de-risks it.

## Considerations

- **No schema enforcement.** The convention is taught only by the prompt. Mitigation:
  exact, copy-pasteable format in the prompt; the parser is strict (only a final-trailer
  `caco-actions` block counts) so stray prose never produces buttons. The user reports
  the model reliably follows such instructions; the no-regression oracle (below)
  measures it. **Residual failure modes (accepted, measured by the bake-in benchmark):**
  (a) model emits the block AND narrates the options in prose — harmless duplication;
  (b) model forgets the fence and writes a plain markdown list — no buttons render (graceful
  degrade, same as if it had skipped the tool); (c) model puts actions mid-message — the
  final-trailer rule ignores them (no buttons); (d) the block reappears as literal text
  in the model's OWN later context (history) — the prompt instructs it to treat a prior
  `caco-actions` block as already-rendered UI, not data to act on.
- **Streaming flicker — must be proven, not assumed.** Until the fence closes, an open
  ```` ```caco-actions ```` may render as a visible code block depending on `marked`'s
  incremental behaviour. The fix (hide any code block whose info-string starts with
  `caco-actions`, covering the open case) MUST ship with a test that drives the
  streaming renderer with a partially-streamed block and asserts nothing visible
  appears. If incremental `marked` can't suppress the open fence cleanly, fall back to
  buffering: don't render a trailing unterminated fence until finalize.
- **Parser robustness — final-trailer rule.** A block counts ONLY when it is the
  **final top-level content** of the message: the ```` ```caco-actions ```` fence, its
  lines, and its closing fence are the last non-whitespace text (optional trailing
  whitespace allowed). This rejects (a) a `caco-actions` sample quoted mid-explanation,
  (b) a block nested inside another fenced/quoted context, and (c) actions emitted
  before more prose. One option per non-blank line; a block with zero valid lines
  yields no buttons and no error. If somehow two qualify, only the final-trailer one is
  eligible (by definition at most one can be the trailer).
- **Persistence.** A2 preserves restore-on-switch (meta write). A1 would lose it
  unless the client posts the parsed options back — extra HTTP (cheap, non-LLM) — so
  A2 is preferred.
- **Round-trip win is conditional.** The per-offer round trip is saved only when the
  model would otherwise have called the tool as a separate step; the steady-state
  −616 B/turn is unconditional and is the larger, guaranteed win.
- **Backwards data.** Sessions with a persisted `responseOptions` from the old tool
  still render fine (same field). No migration needed.
- **Security.** A2 inherits the tool's exact trust model: button text = prompt, no
  label/payload split, so no spoofing surface (the key advantage over Proposal B).
  Options are escaped on render exactly as today.

## Acceptance

- **Parser oracle (independent):** a unit test feeds sample assistant messages (no
  block; one final-trailer block; a `caco-actions` block quoted mid-message that must
  NOT match; actions before more prose that must NOT match; block with
  blanks/overlong/>4 lines; CRLF line endings; leading/trailing whitespace; options
  containing markdown/backticks/pipes treated as literal text) and asserts the extracted
  options equal a hand-computed expected list, byte-for-byte identical to what
  `caco_offer_action` would have stored (shared fixtures with the tool's validation).
- **Escaping oracle:** an option containing HTML (`<img src=x onerror=alert(1)>`)
  renders as escaped text in the button, exactly as the tool path does — no new
  injection surface.
- **UI parity:** rendering a message with a `caco-actions` block shows the same pinned
  buttons as the tool did, the block text is absent from the transcript, and clicking
  sends the exact option text. Covered by a frontend test on the `code()` renderer +
  the existing button pipeline.
- **No-regression (behavioural):** run the fixed D1 benchmark (`docs/spec-budget.md`)
  plus a few "offer actions" prompts before/after; confirm the model emits the block
  when appropriate and tool-call/turn counts do not rise (buttons still appear).
- **Byte oracle:** `scripts/measure-tools.mts` shows `caco_offer_action` gone and the
  shipped total down by ~616 B.
- Gates: typecheck ×2, lint:strict, knip (no dead exports), full tests, build:client.

## Plan (ordered)

1. **Parser module** (`src/offer-action-parse.ts`): `extractActionOptions(message)`
   → `string[]` implementing the final-trailer rule + the tool's exact validation
   (trim, drop blanks, `MAX_OPTIONS=4`, `MAX_OPTION_LENGTH=50`). Factor the shared
   validation so the tool and parser cannot diverge. Unit tests first (the oracle,
   incl. all edge cases above).
2. **Server wire-up:** in `applyDispatchEventEffects`, on `assistant.message` pass
   `data.content` to the parser and write `meta.responseOptions`. Verify clear-on-next-
   send + restore-on-switch still hold. (Tool stays registered — dual-path bake-in.)
3. **Client hide + streaming proof:** `code()` renderer returns empty for info-strings
   starting with `caco-actions`; ship the streaming test that asserts an open/partial
   fence never renders visibly (buffer the unterminated trailing fence if needed).
   Frontend test for the closed-block + button pipeline + HTML-escaping oracle.
4. **Prompt:** add the fenced-block convention (exact format + the 1–4 / ≤50 / self-
   contained / no-stop-cancel rules) and the "treat a prior caco-actions block as
   already-rendered UI" note. Keep the tool nudge during bake-in.
5. **Reliability benchmark (gate):** run the D1 fixed benchmark + several "should offer
   actions" prompts; confirm the model emits a valid final-trailer block (buttons appear)
   without raising tool-call/turn counts or failures. Record before/after.
6. **Remove the tool (only if step 5 passes):** delete `src/offer-action-tool.ts` +
   server registration + prompt tool mention; update every doc that references it
   (`docs/archive/ui-session-interaction.md`, `docs/rich-interactions.md`, API.md, and the
   chat-form-refactor docs) and any skill. Re-measure with the byte oracle (−616 B).

A2 is the highlight; if step 3's streaming proof or step 5's reliability probe fails,
fall back to A1 (client parse + optional post-back) before considering Proposal B.
