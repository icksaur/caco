# ask_user tool — SDK capability + Caco integration

Status: research (2026-07-05). Investigator: gpt-5.3-codex subagent + main-session
verification. All paths relative to the repo root; SDK paths under
`node_modules/@github/copilot-sdk/dist/`.

## What it is

The Copilot SDK has a built-in **`ask_user`** tool: the agent asks the human a
question mid-turn (optionally multiple-choice) and blocks on the answer.

| Aspect | Detail | Source |
|--------|--------|--------|
| Tool name | `ask_user` (capability string `ask-user`) | `toolSet.js:66-69`; `generated/rpc.d.ts:1200-1202` |
| Input | `question` (req), `choices?`, `allowFreeform?` (wire key `allow_freeform`, default true) | `types.d.ts:761-777` |
| Output | `answer`, `wasFreeform` | `types.d.ts:781-790` |
| Request event | `user_input.requested` — `requestId`, `question`, `choices?`, `allowFreeform?`, `toolCallId?` | `generated/session-events.d.ts:5791-5844` |
| Completion event | `user_input.completed` — `requestId`, `answer?`, `wasFreeform?` | `generated/session-events.d.ts:5846-5890` |
| Reply RPC | `session.ui.handlePendingUserInput({ requestId, response: { answer, wasFreeform } })` | `generated/rpc.js:1370-1376`; `rpc.d.ts:12745-12767,14605-14611` |
| Alt reply path | callback `onUserInputRequest` → JSON-RPC `userInput.request` | `client.js:1824-1826,1900-1913`; `session.js:745-755,809-817` |
| Related | `elicitation.requested`/`elicitation.completed` (form dialogs), gated by `onElicitationRequest` | `session-events.d.ts:5893-6013` |

## The decisive finding: ask_user is OPT-IN, and Caco never opts in

`ask_user` is **gated behind a handler that Caco does not provide**:

- `onUserInputRequest?: UserInputHandler` — *"When provided, enables the ask_user
  tool allowing the agent to ask questions."* (`types.d.ts:1535-1538`)
- Caco's create/resume options set **only** `onPermissionRequest: approveAll`
  (`src/session-manager.ts:766-773,987-992`); a repo-wide grep for
  `onUserInputRequest|askUser|ask_user|userInputRequest` across `src/` + `server.ts`
  returns **nothing**.

So the premise "it costs a lot of tokens every turn and we never use it" is **half
right**: we never use it (confirmed), but whether it costs per-turn tokens is **not
confirmed** — it may be gated out of the prompt entirely when the handler is absent.

### ✅ Resolved (2026-07-05): it IS sent, ~800 tok/turn
Confirmed via Caco's own per-turn tool-definition telemetry: `ask_user` is present in
the prompt tool block despite no `onUserInputRequest` handler, and measures ~800 tokens
(description + params + instructions). So it is genuine dead-weight per-turn tax.
**Action taken:** excluded via `builtin:ask_user` in `DEFAULT_EXCLUDED_BUILTINS`
(`src/tool-registry.ts`). Reversible by a config edit / `CACO_EXCLUDED_BUILTINS`, and
would be removed if Option A (below) is ever built.

Token-cost estimator for reference: `src/tool-size.ts:14-25` (`JSON.stringify(def).length / 4`).

## How Caco treats interactive events today (gaps)

| Path | State | Source |
|------|-------|--------|
| `onUserInputRequest` / `onElicitationRequest` | **not registered** (only `onPermissionRequest`) | `src/session-manager.ts:766-773,987-992` |
| Built-in exclusions | exclude only the shell family — NOT `ask_user` | `src/tool-registry.ts` `DEFAULT_EXCLUDED_BUILTINS` |
| `user_input.*` events | dropped by the event filter (whitelist lacks `question`/`answer`) | `src/event-filter.ts:32-42,79-81` |
| `elicitation.requested` | passes filter (has `message`) but no client renderer maps it | `public/ts/dom-regions.ts:92-159,697,701` |
| Existing "response options" UI | post-response buttons parsed from assistant output; NOT wired to ask_user | `src/dispatch-events.ts:126-137`; `public/ts/chat-form-controller.ts:136-146,201-207` |

## Options

### Option A — integrate (make ask_user work)
Caco is a web UI with the user present, so a true mid-turn clarification prompt could
be genuinely valuable (the post-response "response options" buttons don't cover
*blocking* in-turn questions).

- **Server:** register `onUserInputRequest` (or stop filtering `user_input.requested`
  and reply via `session.rpc.ui.handlePendingUserInput`); normalize to a Caco synthetic
  event. Files: `src/session-manager.ts`, `src/event-filter.ts`, `src/routes/websocket.ts`,
  `src/routes/session-messages.ts`.
- **Client:** pending-question UI state (`question`/`choices`/`allowFreeform`/`requestId`),
  reuse the chat-form/response-options button surface for choices + freeform, submit the
  answer, dismiss on `user_input.completed`. Files: `public/ts/message-streaming.ts`,
  `public/ts/chat-form-controller.ts`, state/store + types.
- **Effort:** medium (~6–10 files). Enabling the handler is what turns the tool on, so
  this both adds the feature AND (if it wasn't already sent) starts sending its schema.

### Option B — remove/defer
- If it IS being sent: exclude via `builtin:ask_user` in `DEFAULT_EXCLUDED_BUILTINS`
  (or `CACO_EXCLUDED_BUILTINS`) — plumbing already exists (`src/tool-registry.ts`,
  `server.ts`). Saves ~227 tok/turn (up to ~831 if instructions ride along).
- If it is NOT being sent (likely, given the opt-in gate): removal is a **no-op** —
  nothing to save; just document that it's gated off.
- Downside of excluding: forecloses any future mid-turn clarification without a re-add.

## Recommendation

1. **First, settle the open question** (is `ask_user` in the per-turn prompt block given
   no handler?). Cheap: inspect Caco's tool-definition token telemetry / prompt tool block.
2. **If it's dead weight in the prompt →** exclude it now (Option B); it's unused.
3. **If it's already gated off →** no token action needed; optionally pursue Option A
   later purely as a UX feature (blocking in-turn questions), which the current
   response-options surface does not provide.

Net: the token-savings motivation may evaporate once the opt-in gating is confirmed; the
lasting question is whether Caco *wants* a blocking clarification UX (Option A), which is
a medium, self-contained feature reusing the existing chat-form surface.
