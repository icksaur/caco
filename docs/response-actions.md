# Response actions (`caco-actions`)

End an assistant message with a fenced `caco-actions` block and Caco renders each
line as a clickable button pinned above the input. Tapping a button sends that
line verbatim as the user's next message. This replaces the old
`caco_offer_action` tool — no tool call, parsed from the message itself.

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
- 1–4 options; extras are dropped. Each ≤50 chars; longer is truncated.
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

## Implementation

- Parser: `src/offer-action-parse.ts` (`extractActionOptions`, final-trailer rule;
  `normalizeOptions` for the 1–4 / ≤50 validation).
- Server: `src/dispatch-events.ts` parses `assistant.message` content and writes
  `meta.responseOptions`.
- Client hide: `public/ts/markdown-renderer.ts` `code()` renderer + the streaming
  guard `stripStreamingActionBlock` in `public/ts/streaming-markdown.ts`.
- Buttons: `public/ts/chat-form-controller.ts` renders `.response-option-btn` from
  `responseOptions`; click sets the textarea and submits.
