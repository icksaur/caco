# Response actions (`caco-actions`)

## Goals

End an assistant message with a fenced `caco-actions` block; Caco renders each line as a clickable button pinned above the input. Tapping a button sends that line verbatim as the next user message. Replaces the old `caco_offer_action` tool — no tool call, no schema, parsed from the message body itself.

## Format

````
```caco-actions
Fix the failing auth test
Add a regression test for the parser
Show the git diff
```
````

- The block must be the **last** thing in the message (a final trailer). A
  `caco-actions` block quoted mid-message, or with prose after it, is ignored — it
  renders as nothing and produces no buttons.
- One option per non-blank line.
- 1–4 options; extras are dropped. **Keep each option short — aim for one scannable line
  (~40–60 chars) so the button reads at a glance.** Hard cap 200 chars (longer is
  truncated); treat 200 as a ceiling, not a target. The button shows a shortened label
  (ellipsis) with the full text on hover, and clicking sends the full (≤200-char) text.
- Each option is a complete, self-contained instruction the agent can act on
  immediately. Not "next bug" or "tell me more" — ask those in prose.
- Omit stop/pause/done/cancel options.

## When to offer

Whenever a turn ends with 1–4 concrete next steps the user is likely to pick.

**Trigger phrase:** when the user says **"offer actions"** (or just **"actions"**),
always end that reply with a `caco-actions` block.

## Behaviour

- The block text is hidden from the transcript (closed blocks via the markdown
  renderer; an unclosed/partial block is suppressed during streaming).
- Options persist on `meta.responseOptions` and are restored on session switch,
  cleared on the next send.
- A prior `caco-actions` block already in the conversation is already-rendered UI —
  do not act on it as data.

## Design

- Parser: `src/offer-action-parse.ts` (`extractActionOptions`, final-trailer rule;
  `normalizeOptions` for the 1–4 / ≤200 validation).
- Server: `src/dispatch-events.ts` parses `assistant.message` content and writes
  `meta.responseOptions`.
- Client hide: `public/ts/markdown-renderer.ts` `code()` renderer + the streaming
  guard `stripStreamingActionBlock` in `public/ts/streaming-markdown.ts`.
- Buttons: `public/ts/chat-form-controller.ts` renders `.response-option-btn` from
  `responseOptions`; click sets the textarea and submits.

## Acceptance

- Observable: Agent ends a message with a `caco-actions` block → 1–4 buttons appear above the input. Clicking a button sends it verbatim and clears the buttons. Block text hidden from rendered transcript.
- Budgets: 1–4 options, ≤200 chars each. Block suppressed during streaming (no flicker).
- Gates: `npm run build`, `npm test` green.
- Oracles: `tests/unit/offer-action-parse.test.ts` (parse + normalization); `tests/unit/streaming-action-block.test.ts` (stream suppression); `tests/unit/response-option-html.test.ts` (button rendering).

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Parser: extractActionOptions, final-trailer rule, normalizeOptions | `src/offer-action-parse.ts` | `tests/unit/offer-action-parse.test.ts` |
| 2 | Suppress block during streaming | `public/ts/streaming-markdown.ts` | `tests/unit/streaming-action-block.test.ts` |
| 3 | Hide closed block in rendered transcript | `public/ts/markdown-renderer.ts` | `tests/unit/response-option-html.test.ts` |
| 4 | Parse assistant.message, write meta.responseOptions | `src/dispatch-events.ts` | `tests/unit/dispatch-events.test.ts` |
| 5 | Render buttons; click → send + clear | `public/ts/chat-form-controller.ts` | visual: buttons appear, click sends |
