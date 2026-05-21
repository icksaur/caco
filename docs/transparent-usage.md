# Transparent usage display

Show Copilot quota/budget usage prominently in Caco so the operator knows where they stand on the per-token billing model. Two text-only displays — top-right of the session list, bottom-left of the meta-context footer — kept in sync via synthetic events whenever Caco can plausibly observe a change.

## Why

Copilot is shifting from per-request to per-token billing. The premium-request multiplier visible in the model list (`models[].billing.multiplier`) is currently always `1x` because the per-request model treats most models uniformly; the per-token model will not. The operator needs to see consumption at a glance, not buried in a panel they have to open.

The SDK already provides the data. Caco already plumbs *some* of it. The gap is freshness and visibility, not the raw data.

## Goals

1. Surface remaining budget in both the session-list view and inside any open chat session, without making the operator click anything.
2. Refresh the displayed value at every point Caco can observe one has changed: page load, session idle, between turns, on session switch.
3. Plain text only. No charts, no meters. Operator can read it in 0.3 seconds.
4. Survive a server restart by showing the cached value with a "last fetched Nm ago" suffix until a fresh one arrives.

## Non-goals

- Per-model cost breakdown. Useful eventually; not v1.
- Historical graphs. The SDK doesn't expose history; building one is its own project.
- Spend forecasting. Premature given the billing model isn't fully live yet.
- Hard-cap enforcement. Caco does not stop dispatch on exhausted quota; the SDK does that.

## What the SDK provides today

Two relevant events fire during normal session dispatch. Both shapes verified in `@github/copilot-sdk` 0.3.0 generated types:

### `assistant.usage` (per-LLM-call)

Fires after every individual LLM API call (one per turn in a single-shot, multiple per turn when tools chain). Caco currently consumes the `quotaSnapshots` field in `src/dispatch-events.ts` and persists the first snapshot to `~/.caco/usage.json` via `src/usage-state.ts`.

Useful fields:

| Field | Type | Use |
|---|---|---|
| `quotaSnapshots[key].remainingPercentage` | 0.0–1.0 | The headline number. |
| `quotaSnapshots[key].usedRequests` | number | "X of Y requests used" detail. |
| `quotaSnapshots[key].entitlementRequests` | number | Total cap. |
| `quotaSnapshots[key].isUnlimitedEntitlement` | bool | Hide percentage; show "unlimited". |
| `quotaSnapshots[key].resetDate` | ISO date, optional | "resets May 31". |
| `copilotUsage.totalNanoAiu` | number | Per-call cost in AI Units (10⁻⁹). Not used today. Could be summed per session. |
| `cost` | number | Per-call multiplier cost. Currently always 1x. |
| `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` | numbers | Per-call token breakdown. Not currently used. |
| `model` | string | Per-call model id. |

The current implementation stores only `remainingPercentage`, `resetDate`, and the unlimited flag. That is sufficient for v1; the other fields are for follow-ups.

### `session.usage_info` (context window)

Fires when the context window changes. This is the *prompt size*, not the *quota*. Already plumbed and rendered in the context footer's existing context-usage indicator. Out of scope here except as a delivery vehicle (see below).

## Current state in Caco

- `src/usage-state.ts` — global `currentUsage`, persisted to `~/.caco/usage.json`. Loaded on startup. Updated from `assistant.usage` events.
- `src/routes/api.ts` — `GET /api/usage` returns the cached value.
- `public/ts/session-panel.ts` `loadUsage()` — fetches the API and renders into `#usageInfo` in the session-list view only. Called once when the session manager view is shown.
- `public/index.html:50` — `<div id="usageInfo" class="usage-info"></div>` in the session panel header area.
- `public/style.css:1382-1402` — color classes `usage-low` (≤25%) and `usage-critical` (≤10%).

**Gaps:**

1. Not displayed inside an active chat. Operator only sees usage on the session-list view.
2. Refreshed only when the session-list view is shown; never updated while the operator is in chat or between turns.
3. The cached `fromCache: true` flag is reset *only when an `assistant.usage` event fires server-side*. The client has no way to know the server got a new value without re-fetching.
4. The `currentUsage` is global to the server, not per-session. This is correct — quota is account-wide — but means there is exactly one number to render and it does not depend on which session is active.

## Design

### Server side

Reuse `src/usage-state.ts` as-is. Add one new piece: a **synthetic broadcast** triggered whenever `currentUsage` actually changes.

In `src/dispatch-events.ts`, after the existing `updateUsage(quotaSnapshots)` call, broadcast a Caco-prefixed event to **all** connected clients regardless of which session they're viewing (quota is account-wide):

```ts
import { broadcastGlobalEvent } from './routes/websocket.js';

const { changed } = updateUsage(quotaSnapshots);
if (changed) {
  broadcastGlobalEvent({
    type: 'caco.usage',
    data: { ...getUsage() }
  } as SessionEvent);
}
```

This uses the existing `broadcastGlobalEvent` helper in `src/routes/websocket.ts` (the same one that powers `session.listChanged`, `extension.cssChanged`, and unobserved-tracker pings). On the client, subscribers attach via `onGlobalEvent(cb)` from `public/ts/websocket.ts` — already used by swarm-progress and extension-api.

In `src/usage-state.ts`, expose a tiny change predicate so we don't broadcast when nothing changed:

```ts
export function updateUsage(quotaSnapshots): { changed: boolean }
```

The `changed` flag lets the caller decide whether to broadcast. The simplest correct check is "remainingPercentage shifted by more than 0.1 percentage points OR resetDate changed OR isUnlimited flipped." This avoids spamming the WebSocket with no-op updates when multiple `assistant.usage` events fire within one turn with the same snapshot.

### Refresh triggers

Every place Caco can observe usage has potentially changed, the frontend re-queries `/api/usage`. The triggers are:

| Trigger | Source | Mechanism |
|---|---|---|
| Page load / F5 | Existing `loadUsage()` call in `showSessionManager()` | Already works |
| Session manager view shown | Same as above | Already works |
| `caco.usage` event received | Server pushes via WS after `assistant.usage` | New — add subscription in chat view |
| Session idle (no dispatch in flight) | `session.idle` event already drives form re-enable | Add cache refresh on `session.idle` |
| Session switch / `activateSession` | New trigger | Re-fetch as part of restore |
| WebSocket reconnect | Server may have updated while we were disconnected | Existing reconnect path; add a one-shot refresh |

The `caco.usage` push is the primary update path. The others are belt-and-suspenders for cases where the WebSocket missed something.

### Frontend rendering

**Two render sites, one data source.** A new module `public/ts/usage-display.ts`:

- Maintains a single in-memory copy of the latest usage info.
- Renders into every element with class `.usage-display` (initially two: `#usageInfo` in the session panel, and a new one in the meta-context footer).
- Subscribes via `onGlobalEvent(cb)` to receive `caco.usage` pushes from the server; also subscribes to the SDK `session.idle` event for belt-and-suspenders refresh; exposes `refresh()` for triggers that need to re-fetch.
- Throttle: at most one fetch per 5 seconds. The push event sets the value directly without fetch.

**Footer integration.** `public/index.html`'s `#contextFooter` gets a new child `<div class="usage-display" data-usage-display="footer">`. Position it bottom-left as specified. CSS reuses the existing `usage-info` color classes.

The footer cell should be compact — `42% remaining` is enough. The session-list cell can be longer — `42% of budget remaining · resets May 31`.

### Wire format

`caco.usage` event payload mirrors the `/api/usage` response:

```json
{
  "type": "caco.usage",
  "data": {
    "remainingPercentage": 42.7,
    "resetDate": "2025-05-31T00:00:00Z",
    "isUnlimited": false,
    "updatedAt": "2025-05-20T20:15:00Z",
    "fromCache": false
  }
}
```

`fromCache` is always false for push events. The frontend overwrites `currentUsage` and re-renders.

### Display rules

| State | Text | Class |
|---|---|---|
| Unlimited (no cache) | `Unlimited` | `.usage-info` |
| Unlimited (from cache) | `Unlimited (last fetched 5m ago)` | `.usage-info` |
| ≥25% remaining | `73% of budget remaining` | `.usage-info` |
| 10–25% | `18% of budget remaining` | `.usage-info.usage-low` |
| <10% | `4% of budget remaining` | `.usage-info.usage-critical` |
| No data | (empty) | `.usage-info` (hidden by `:empty`) |
| Has `resetDate` | append ` · resets May 31` | (any) |
| Footer rendering | drop the `of budget remaining` suffix | (any) |

The footer cell uses a condensed form because real estate is tight; the session-list cell uses the full form because there is room.

### CSS

No new CSS classes; reuse `.usage-info`, `.usage-low`, `.usage-critical`. Add one positioning rule for the footer cell — left-aligned, monospace not required, `var(--text-xs)` to stay quiet.

## Refresh frequency

Targeted, not periodic. No polling timer. The flow is:

1. Page load → REST fetch.
2. Server emits `assistant.usage` after each LLM call → server broadcasts `caco.usage` → client overwrites.
3. Session goes idle → client REST-fetches as belt-and-suspenders.
4. WebSocket reconnect → client REST-fetches.

Worst case staleness: the duration of one in-progress dispatch (until the next `assistant.usage` arrives). For the operator that's seconds to minutes — acceptable because they're watching the chat scroll past anyway.

## Failure modes

| Failure | Behavior |
|---|---|
| `assistant.usage` event lacks `quotaSnapshots` (e.g. some models) | Last known value remains displayed; `updatedAt` doesn't refresh. |
| Server has no cached value yet (first run) | Both cells render empty. CSS `:empty` hides them. |
| `/api/usage` 500s | Frontend logs and renders nothing. Existing cached value remains visible. |
| WebSocket disconnected | No pushes; reconnect triggers REST refresh. Cache still valid. |
| Multiple quota snapshots (multi-entitlement future) | v1 uses the first key (current behavior). A follow-up can pick the most-restrictive. |

## What ships in v1

The full feature, but additive — no existing behavior changes:

1. New: `caco.usage` synthetic event broadcast in `src/dispatch-events.ts` after `updateUsage()` returns `changed: true`.
2. New: `public/ts/usage-display.ts` — multi-target renderer subscribed to push + idle.
3. New: `<div class="usage-display">` in the context footer; route `loadUsage()` calls through the new module.
4. Existing: `src/usage-state.ts` gains a `changed` return value; otherwise unchanged.
5. Existing: session-list `loadUsage()` deletes its inline implementation and calls the shared module.

## What ships in a follow-up (sketch only — out of scope)

- **Per-session token totals.** Sum `inputTokens` + `outputTokens` per session. Show in session-list row.
- **Per-call cost.** Show `copilotUsage.totalNanoAiu` for the last assistant turn in the context footer (alongside the existing token-context indicator).
- **Multiple entitlements.** If `quotaSnapshots` has more than one key, pick the most-restrictive.
- **Reset countdown.** "resets in 9 days" instead of an absolute date.
- **Visual meter.** A horizontal bar inside the cells. Frontend-only feature.

These all build on the wire format already shipped in v1.

## Open questions

1. **What happens to `assistant.usage.cost` when the per-token model rolls out?** Today it is `1.0`. If the SDK reports fractional costs (e.g. `0.25` for a cached read), the existing event handler still works — we ignore `cost`. But if the SDK changes the **shape** of `quotaSnapshots` for per-token usage, this spec needs updating. Recommend rechecking the event shape once the per-token billing is live.
2. **`copilotUsage.totalNanoAiu` semantics.** "AI Units" is a Copilot-internal billing unit. Until there's an exchange rate documented, summing nanoAIU per session is informative but not actionable. Leave it for the follow-up.
3. **Footer placement.** Spec says bottom-left of the meta-context footer. The context footer currently shows context tokens and pinned-file lists. The usage cell goes at the start (left edge) on its own row, or as a small chip in the existing row. Implementer's choice — both look fine; the small chip is more compact.

## What is the simplest correct v1?

If the design feels too ambitious: the minimum that satisfies "kept in sync as much as we can" is:

1. Add the `caco.usage` server broadcast.
2. Subscribe to it in the existing chat-view bootstrap. On receipt, call the existing `loadUsage()` (which already renders).
3. Add the footer `<div class="usage-display">`. Have `loadUsage()` render to both targets.

That's it. The refresh-on-idle and refresh-on-reconnect triggers are nice-to-haves the design can include or defer.
