# Background Agent Visual Discriminator

## Goals

Work done by background `task`-tool sub-agents (explore, code-review, general-purpose, etc.) streams into the same chat as the primary session. Its assistant messages and tool calls render identically to primary content, so the two are visually indistinguishable. Add a 5px purple vertical bar on the left edge of every chat box that originates from a sub-agent, making background work immediately recognizable.

## Design

SDK events from a sub-agent carry a **top-level `agentId`** field (sibling to `type`/`data`), confirmed empirically. `renderEvent` in `dom-regions.ts` reads `event.agentId`; `ElementInserter.getElement` takes `agentId`, tags created outer boxes with `dataset.agentId`, and **refuses to reuse a box across an `agentId` boundary** — without this guard, a sub-agent box would merge into a preceding primary box. A primary → sub-agent → primary interleave yields three separate boxes: unmarked, marked, unmarked. CSS `::before` on `[data-agent-id]` renders the 5px bar using the existing `var(--purple)` palette variable (no per-theme additions). The server already forwards top-level `agentId` in both the live broadcast path and history replay (`readLastTurns` does a full `JSON.parse`).

## SDK signal (answer to "does the SDK flag these?")

Yes. SDK events from a sub-agent carry a **top-level `agentId`** (sibling to
`type`/`data`), documented under `includeSubAgentStreamingEvents` in the SDK
types. Distribution in a real session (`400c723d`):

| event type            | with agentId (sub-agent) | without (primary) |
|-----------------------|--------------------------|-------------------|
| assistant.message     | 2325                     | 13490             |
| tool.execution_start  | 4824                     | 14081             |
| user.message          | 0                        | 924               |

`user.message` never carries one (prompts are primary). `subagent.started` /
`subagent.completed` lifecycle events also carry `agentId` + `agentName`.

### Rejected signals
- **`parentAgentTaskId`**: also tags the primary session's own roadmap/continue
  prompts (365 in one session) — false positives. Not used.
- **`getSessionMeta(fromSession).kind === 'agent'`**: forked/dispatched sessions
  store `kind: 'interactive'` explicitly, so the `parentSessionId → 'agent'`
  derivation never fires; gate was almost never true. Also a per-message
  cross-session disk read. Removed.
- **`.agent-message` only** (`[agent:id]` cross-session messages): correct for
  `send_caco_message`/swarm, but misses `task`-tool sub-agents entirely (the
  common case). Kept as an additional marked surface, not the primary signal.

## Implementation

| File | Change |
|---|---|
| `public/ts/types.ts` | `SessionEvent` gains optional top-level `agentId` |
| `public/ts/dom-regions.ts` | `renderEvent` reads `event.agentId`; `ElementInserter.getElement` takes `agentId`, tags created outer boxes with `dataset.agentId`, and **refuses to reuse a box across an agentId boundary** |
| `public/style.css` | `[data-agent-id]` / `.agent-message` get `position: relative` + a `::before` 5px bar colored `var(--purple)` |
| `public/style.css` (only) | bar uses each theme's existing `var(--purple)` palette variable — no per-theme additions |

The server already forwards top-level `agentId`: both the live path
(`broadcastEvent` → `enrichUserMessageWithSource` returns non-user events
unchanged) and history replay (`readLastTurns` does a full `JSON.parse`) preserve
it.

### Why the reuse guard matters
`getElement` reuses the last child of a matching CSS class. A sub-agent's
`assistant.message` / `tool.*` events share the same outer classes
(`assistant-message`, `assistant-activity`) as primary. Without the guard, a
sub-agent box would merge into the preceding primary box (and mis-mark it). The
`agentId` guard makes each agent's run form its own container, so the bar maps
1:1 to "events by that background agent." A primary → sub-agent → primary
interleave yields three boxes: unmarked, marked, unmarked.

## Acceptance

- Observable: background `task`-tool sub-agent messages and tool calls have a visible 5px purple bar on their left edge; primary messages have none. Visual signoff required.
- Budgets: n/a (pure client-side CSS + one field read per event).
- Gates: `npm run build:client`, full tests (`npm test`).
- Oracles: `tests/unit/dom-regions.test.ts` — sub-agent message box tagged `data-agentId`; primary box untagged; primary/sub-agent/primary interleave splits into 3 separate boxes; consecutive same-agent events reuse one box. By-construction: server path unchanged (agentId forwarded transparently).

## Notes / future

- To color swarm vs delegate vs task differently, branch on `agentId`/event
  metadata in the CSS/attribute. Not needed today (single purple).
- `caco_session_delegate` posts a plain prompt (no `source: 'agent'`), so its
  replies render as normal `user.message` and won't get a bar. Separate follow-up
  if delegate visibility is wanted.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Add optional `agentId` to `SessionEvent` type | `public/ts/types.ts` | by-construction |
| 2 | `ElementInserter.getElement` takes `agentId`, tags outer boxes with `dataset.agentId`, reuse guard across boundary | `public/ts/dom-regions.ts` | `dom-regions.test.ts`: tagging + 3-box split + same-agent reuse |
| 3 | CSS `::before` 5px bar on `[data-agent-id]` using `var(--purple)` | `public/style.css` | visual signoff |
