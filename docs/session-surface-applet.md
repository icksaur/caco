# Session-surface applet

A first-generation rich-interaction surface for Caco. Built on a two-party collaborative state model: an agent and a human mutate the same document, with safe concurrency.

This document is the design spec for the applet and the protocol it sits on. The underlying data-exchange protocol is described in [`collab-state-spec.md`](./collab-state-spec.md); this document specifies the concrete tool names, HTTP routes, storage layout, UI styles, and MVP scope.

## First principle: two-party mutable state

State has two authors and one document. The protocol must let either party read the other's changes as **structured mutations**, not by diffing.

- The agent does not diff prose; it reads a typed mutation list.
- The user does not see the agent's internal model; the UI is a deterministic render of the current state.
- A single optimistic-lock token (`dataToken`) prevents either side from clobbering the other.

The applet is the rendering and input surface. The state and protocol exist independently of which applet is rendering them — meaning the same document can later be visualized through different "styles" without changing the data.

## Goals

1. Let the agent push a structured document and have the user manipulate it without prose.
2. Let the user mutate the document and have the agent read **what changed**, not **what is now**.
3. The agent provides all rendering and interaction logic via `customScript`/`customStyle`. The applet is a shell.
4. Stay within Caco's existing applet/tool primitives — no new persistent infrastructure.

## Non-goals

- Real-time multi-user collaboration (only one human and one agent).
- Hosting arbitrary applets (Beta is constrained to a single HTML shell + agent JS).
- Replacing existing applets that do something specialized (`presentation`, `image-viewer`, `file-finder`).
- General data persistence beyond what session storage already provides.

## Data model

A single document per session, stored alongside other Caco session data at `~/.caco/sessions/<sessionId>/surface.json`. Accessed via `getSessionData(sessionId, 'surface')` and `setSessionData(sessionId, 'surface', ...)` from `src/storage.ts`. This keeps surface state next to the existing `roadmap.json`, `presentation.json`, and `notes.json`.

```json
{
  "dataToken": "a3f9c2",
  "style": "roadmap",
  "items": [
    { "id": "t1", "type": "task", "label": "Fix login bug", "status": "active" },
    { "id": "t2", "type": "task", "label": "Update docs",   "status": "done"   }
  ],
  "changes": {
    "t1": { "id": "t1", "type": "task", "label": "Fix login bug", "status": "done" }
  },
  "customScript": null,
  "customStyle": null
}
```

Fields:

- **`dataToken`** — opaque hash of the full document state including `changes`. Required by every mutation. First writer wins; second gets a stale error.
- **`style`** — UI style identifier. V1: `"roadmap"`. Beta: `"custom"`. More built-in styles may be added later.
- **`items`** — flat array of objects, each with a stable `id`. Field shape is style-defined.
- **`changes`** — human-side dirty map. Keyed by item ID. Value is the entire current object after the human's edits. At most one entry per ID. Agent writes do NOT touch `changes`.
- **`customScript`** — Beta only. Agent-authored JavaScript executed by the applet to render and wire interactions for `style: "custom"`.
- **`customStyle`** — Beta only. Agent-authored CSS scoped to the applet.

For V1, `customScript` and `customStyle` are always `null` and the applet rejects writes to them.

### Item identity

Every item has an `id` (stable, agent-assigned) and a `type` (style-defined enum). Items have no positional identity — order in `items[]` is meaningful for rendering but never used as identity. The `id` is the join key across all reads, writes, and mutations.

## HTTP API

All routes are session-scoped. The session ID lives in the path.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/sessions/:sessionId/surface` | Read full document. |
| GET | `/api/sessions/:sessionId/surface/changes` | Read only `changes` + `dataToken`. |
| POST | `/api/sessions/:sessionId/surface/mutate` | Agent applies `create` / `update` / `delete` and clears `changes` atomically. Requires `dataToken`. |
| POST | `/api/sessions/:sessionId/surface/clear-changes` | Agent acknowledges `changes` without writing. Requires `dataToken`. |
| PUT | `/api/sessions/:sessionId/surface/changes/:itemId` | Human-side mutation. Writes one entry into `changes`. Requires `dataToken`. |
| PATCH | `/api/sessions/:sessionId/surface/style` | Set `style`, optionally `customScript` / `customStyle`. Requires `dataToken`. (Beta) |
| DELETE | `/api/sessions/:sessionId/surface` | Discard the surface document. (Used by `caco_reset_surface`.) |

Every mutating route returns the new `dataToken` on success or `{ ok: false, reason: "stale", currentDataToken: "..." }` on token mismatch. `currentDataToken` lets the caller retry without an extra GET when only one item is in flight.

### Validation rules (server-side)

- `dataToken` must match the document's current token. Otherwise: `{ ok: false, reason: "stale", currentDataToken }`.
- For `PUT /surface/changes/:itemId`: the `itemId` MUST exist in `items[]`. If not (e.g. the applet is stale and references a removed item), respond `{ ok: false, reason: "unknown-item", currentDataToken }`. The applet treats `unknown-item` like `stale`: it refetches `/surface` and discards the local edit.
- For `mutate`: hard cap of 200 items after applying `create`/`delete`. Over-limit responds `{ ok: false, reason: "limit" }`.
- Body must validate against the schema (`id` present, `type` present, etc.). Invalid body responds `{ ok: false, reason: "invalid", errors: [...] }`.

### Concurrent-mutation resolution

The Express server processes requests serially (single Node event loop). When a human PUT and an agent mutate are both in flight, whichever arrives first is applied and rotates the token; the second receives `stale` (with `currentDataToken`).

- If the agent's `mutate` wins: `changes` is cleared atomically. The human's late PUT then writes its single entry into the now-empty `changes` and rotates the token. The agent's next `caco_get_surface_changes` reads it normally. No data loss.
- If the human's PUT wins: the agent's late `mutate` returns `stale`. The agent must follow the retry protocol below.

### Stale retry protocol (agent side — REQUIRED for the system prompt)

When `caco_mutate_surface` returns `stale`:

1. Call `caco_get_surface` to fetch the full document at the new token.
2. Re-decide intended `create` / `update` / `delete` against the new state. If the human's edits (now visible in `items[]` because `mutate` would have been blocked but PUT writes both `changes` and `items` — see below) make the original plan obsolete, adjust or abandon.
3. Retry `caco_mutate_surface` with the fresh `dataToken`.

(Implementation note: PUT writes ONLY into `changes`, not `items`. The agent's view of `items[]` is stable until the next `mutate`. So step 2 simplifies to "merge with the new `changes` map.")

The system prompt teaching MUST include this loop. The model only needs to remember the three steps; the tool descriptions reinforce them.

### Request / response shapes

**POST `/api/sessions/:sessionId/surface/mutate`**

```json
// Request
{
  "dataToken": "a3f9c2",
  "create": [{ "id": "t3", "type": "task", "label": "...", "status": "pending" }],
  "update": [{ "id": "t1", "label": "Fix login bug (clarified)" }],
  "delete": ["t2"]
}
// Success
{ "ok": true, "dataToken": "b71e44" }
// Stale
{ "ok": false, "reason": "stale", "currentDataToken": "c92155" }
```

`update` is a shallow per-item merge: missing fields are preserved, present fields overwrite. To clear a field, set it to `null`. To replace the whole item, `delete` then `create`.

**PUT `/api/sessions/:sessionId/surface/changes/:itemId`**

```json
// Request
{ "dataToken": "a3f9c2", "item": { "id": "t1", "type": "task", "label": "Fix login bug", "status": "done" } }
// Success
{ "ok": true, "dataToken": "b71e44" }
```

The full post-edit item is sent each time, matching the ledger semantics (last write wins per ID).

## Agent tools

All tools are prefixed `caco_`. They are thin wrappers over the HTTP routes; their parameters mirror the route payloads. The agent is given a `sessionId` automatically by Caco (current session), so it never has to specify it — except in the rare case of cross-session work, where the tool accepts an optional override.

| Tool | Route | Purpose |
| --- | --- | --- |
| `caco_get_surface` | GET `/surface` | Full document. |
| `caco_get_surface_changes` | GET `/surface/changes` | Human-side dirty map only. |
| `caco_mutate_surface` | POST `/surface/mutate` | Apply `create`/`update`/`delete`, atomically clearing `changes`. |
| `caco_clear_surface_changes` | POST `/surface/clear-changes` | Acknowledge `changes` without writing. |
| `caco_set_surface_style` | PATCH `/surface/style` | Change `style`, optionally provide `customScript`/`customStyle`. (Beta) |
| `caco_reset_surface` | DELETE `/surface` | Discard the document entirely. |

Tool descriptions in Caco's prompt assembly must teach the model the canonical flow:

1. At turn start (or before any surface action), call `caco_get_surface_changes`. If `changes` is non-empty, the user has edited the document; integrate those into your plan.
2. Either call `caco_mutate_surface(...)` (atomic write + ack) or `caco_clear_surface_changes(token)` (ack without write).
3. **On `stale` response**: call `caco_get_surface`, rebase your intended mutations against the new `items` + `changes`, then retry `caco_mutate_surface` with the fresh `dataToken`. Do NOT retry indefinitely — give up after two stale rounds and tell the user.
4. Emit a markdown link `[Open surface](/?applet=session-surface&session=<id>)` so the user can review.

The model only needs to remember **one read tool and one write tool** for the common case (`caco_get_surface_changes` → `caco_mutate_surface`). The rest are escape hatches.

### Reliability of the system-prompt nudge

System prompts are routinely skipped by long-conversation models. Fallback behavior when the agent forgets:

- The user's edits accumulate in `changes` safely. Nothing is lost.
- On the next call (whether prompted by the user typing or the agent voluntarily reading), the agent sees the full `changes` map.
- If the agent never reads, the user can type `check the surface` in chat — the human is the backstop.

A more aggressive mechanism (auto-injecting `caco_get_surface_changes` output into the turn preamble) is a candidate Future Extension if the nudge proves unreliable in practice.

## UI rendering

The applet is a **shell** — a container with known DOM anchors. The **agent** provides the rendering logic and interaction handlers via `customScript` and `customStyle` fields on the surface document. There are no built-in styles or baked-in renderers.

### Shell (constant)

```html
<div id="surface-root">
  <header id="surface-header">
    <h2 id="surface-title">…</h2>
    <div id="surface-actions"></div>
  </header>
  <div id="surface-items">
    <!-- one <div> per item, id="item-<itemId>" -->
  </div>
</div>
```

For every item in `items[]`, the applet renders a `<div id="item-<itemId>" data-type="<type>"></div>`. The agent's `customScript` decides what to put inside each div.

### Agent-provided rendering

The agent supplies `customScript` and optionally `customStyle` via `caco_mutate_surface`. The applet:

1. Injects `customStyle` into a scoped `<style>` element inside the applet container.
2. Evaluates `customScript` as the body of an IIFE with the following bindings:
   - `surface` — `{ items, dataToken, style, changes }` (read-only snapshot, refreshed on every state update).
   - `root` — the `#surface-root` element.
   - `mutateChange(itemId, fullItem)` — wraps the human-side PUT route. Returns a promise resolving to `{ ok, dataToken? }`. Updates the local `surface` snapshot on success. On `stale` or `unknown-item`, the helper does a GET-and-refresh internally.
   - `appletAPI` — the standard Caco applet API.
3. Calls a global `render(surface)` function the script must define. `render` is called on initial mount and again on every change (agent push or user PUT response).

The agent is free to:
- Build any DOM inside `<div id="item-<itemId>">` or directly in `root`.
- Attach listeners that call `mutateChange(...)` to send user edits.
- Use any Caco theme CSS variables (`var(--color-text)`, `var(--color-accent)`, etc.).

The agent must **not**:
- Make external network requests (CSP prevents this).
- Touch global state outside the applet container.

`customScript` is preserved in `surface.json` and re-evaluated whenever the applet mounts, so it survives session restore and server restart.

### Fallback rendering (no customScript)

When `customScript` is null (agent only populated items without rendering logic), the applet renders a minimal default: each item's `label` or `id` as text inside its div. This is a diagnostic view, not a feature — the agent should provide `customScript` for any interactive surface.

### Example: roadmap-style surface

An agent can build a roadmap renderer entirely via `customScript`:

```javascript
// customScript — agent provides this
function render(surface) {
  var statusIcons = { pending: '○', active: '◐', done: '●', blocked: '⊘' };
  root.innerHTML = '';
  surface.items.forEach(function(item) {
    var merged = surface.changes[item.id] || item;
    var div = document.createElement('div');
    div.className = 'step step-' + (merged.status || 'pending');
    div.innerHTML = '<span class="badge">' + (statusIcons[merged.status] || '○') + '</span> ' +
      '<span>' + (merged.label || merged.id) + '</span>';
    div.querySelector('.badge').onclick = function() {
      var order = ['pending', 'active', 'done', 'blocked'];
      var next = order[(order.indexOf(merged.status || 'pending') + 1) % 4];
      mutateChange(item.id, Object.assign({}, merged, { status: next }));
    };
    root.appendChild(div);
  });
}
```

This replaces what was previously a built-in renderer — it's now just an example agents can adapt.

## Scope

### Done (backend — keep as-is)

1. ✅ Storage: `~/.caco/sessions/<id>/surface.json`. Schema validator. Token computation.
2. ✅ HTTP routes: GET full, GET changes, POST mutate, POST clear-changes, PUT change.
3. ✅ Tools: `caco_get_surface`, `caco_get_surface_changes`, `caco_mutate_surface`, `caco_clear_surface_changes`.
4. ✅ System-prompt addition teaching the read-changes-then-mutate flow.
5. ✅ Tests: `surface-store.test.ts` (249 lines).

### Needs rework (applet — subtractive change)

The current `applets/session-surface/script.js` ships a baked-in roadmap renderer with status cycling. This must be replaced with the agent-driven shell described above.

**Remove:**
- `statusOrder`, `nextStatus()`, `statusClass()` — hardcoded status cycling
- `renderItem()` — baked-in badge + label renderer
- `cycleStatus()` — click handler that cycles status enum
- Status-badge CSS (`.status-done`, `.status-active`, etc.)

**Add:**
- `customScript` evaluation: IIFE wrapper with `surface`, `root`, `mutateChange`, `appletAPI` bindings
- `customStyle` injection: scoped `<style>` element
- `render(surface)` callback invocation on mount and on every state change
- Fallback rendering when `customScript` is null (minimal text dump)

**Keep:**
- `fetchSurface()` — REST client for loading the document
- `putItem()` — human-side PUT route wrapper (becomes `mutateChange` binding)
- `onStateBus()` — session change / event listeners
- Token management / stale handling
- Toast notifications

**Estimated diff:** ~-120 lines (remove renderer), ~+50 lines (add eval shell). Net subtraction.

### Future

- Multi-document surfaces per session (slug-keyed).
- WebSocket push instead of polling on agent side.
- Migration from `update_roadmap` storage into surface.

## Open questions resolved

- **Tool naming**: prefixed `caco_`.
- **URI shape**: `/api/sessions/:sessionId/surface[...]`.
- **Rendering model**: agent-driven via `customScript`/`customStyle`. No built-in styles.
- **Relationship to existing roadmap**: parallel. Surface is independent of `getSessionRoadmap`.

## Code analysis

Existing primitives the applet leans on:

- `applets/<slug>/` directory with `meta.json` + `content.html` + `script.js` + `style.css` — see `applets/file-finder/`.
- Applet runtime — `public/ts/applet-runtime.ts` exposes `appletAPI.sendAgentMessage` (used to notify the agent after a user PUT, see Submission below).
- Per-session disk state — `~/.caco/sessions/<id>/` is already the home for `roadmap.json`, `presentation.json`, `notes.json`, etc. `surface.json` joins them via the existing `getSessionData` / `setSessionData` helpers.
- HTTP routing — Express routes in `src/routes/sessions.ts`. New routes follow the existing session-scoped pattern.
- Tool registration — Caco tools are declared in `src/applet-tools.ts` and similar registries. The four new tools follow the same shape.
- DOMPurify — vendored at `/dompurify.min.js`, available globally in the applet's execution context as `window.DOMPurify`. Used to sanitize the `description` field in the roadmap style.

New code (estimated):

- `src/surface-store.ts` — read/write/token logic (~150 lines).
- `src/routes/surface.ts` — five HTTP routes (~120 lines).
- `src/surface-tools.ts` — four agent tools (~80 lines).
- `applets/session-surface/meta.json` (~25 lines), `content.html` (~30 lines), `script.js` (~250 lines for MVP — roadmap style only), `style.css` (~120 lines).

### Applet `meta.json` (MVP)

```json
{
  "slug": "session-surface",
  "name": "Session Surface",
  "description": "Two-party collaborative surface. Agent pushes structured items; user manipulates them.",
  "params": {},
  "agentUsage": {
    "purpose": "Open after pushing a roadmap-style document via caco_mutate_surface. The user can cycle item statuses; you read their edits via caco_get_surface_changes."
  },
  "stateSchema": {
    "get": null,
    "set": null
  }
}
```

`stateSchema` is null because session-surface uses its own collab-state API (`caco_*_surface`), not the generic `set_applet_state` / `get_applet_state` mechanism. The applet does not register state with the generic applet-state store.
- System prompt addition (~80 words).
- Tests: `tests/unit/surface-store.test.ts` for token behavior, mutate/clear semantics; route test verifying stale rejection.

## Submission flow

For V1, every user PUT to `/surface/changes/:itemId` is **silent on the chat channel** — no agent message is posted. The agent picks up changes on its next read.

To keep the user oriented, the applet shows a small footer hint when there are unacknowledged local changes:

> *Agent will see your changes on its next response. Send a chat message to wake it now.*

The hint clears when the applet sees an empty `changes` map on its next refresh (i.e., the agent has acknowledged via `mutate` or `clear-changes`).

Rationale: cycling a status is a low-friction action. A chat message per click would clutter the conversation. The agent's normal pattern is to call `caco_get_surface_changes` at turn start; the hint tells the user when the next turn will arrive.

For Beta, the script can optionally call a debounced helper that posts:

```
[applet:session-surface] surface updated.
```

Or it can stay silent. Author's choice per script.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Agent ignores `changes` | System-prompt nudge at the top of every turn instructs to call `caco_get_surface_changes`. Failure mode is safe — the document just accumulates dirty entries until the next mutation clears them. |
| Agent emits invalid schema | Validator runs server-side on every mutation. Reject with explicit error so the agent can self-correct. |
| `customScript` errors | CSP blocks external requests. Errors thrown during eval/render are caught and shown in the applet as an error pane. |
| Token collisions | Token is 12-character truncation of SHA-256; collision probability negligible for single-session scope. |
| Concurrent user clicks | The applet serializes user PUTs locally (queue-based). Each click waits for the previous PUT's response before sending. Stale or `unknown-item` responses trigger a single GET-and-retry. |
| 200-item cap | Surface document is hard-capped at 200 items server-side. Over-limit mutations return `{ ok: false, reason: "limit" }`. |
| Lost state across server restart | `surface.json` is persistent on disk — survives restart. |

## Testing

### `tests/unit/surface-store.test.ts` — pure store + token logic

1. `computeToken` is deterministic for identical canonical JSON.
2. `computeToken` changes when any field changes (items, changes, style).
3. `computeToken` is stable under key reordering (canonical serialization).
4. Empty document round-trips through `get` / `set` unchanged.
5. `mutate` with `create` adds items and rotates token.
6. `mutate` with `update` shallow-merges fields, preserves omitted, rotates token.
7. `mutate` with `delete` removes items and ALSO removes their entry from `changes` (orphan cleanup).
8. `mutate` clears `changes` to `{}` on success (atomicity — even if no item was actually changed).
9. `mutate` with stale token does NOT mutate state and does NOT clear `changes`.
10. `mutate` over the 200-item cap returns `limit` and leaves state unchanged.
11. `mutate` with invalid item body returns `invalid` with field-level errors and leaves state unchanged.
12. `putChange` writes a single entry, rotates token, leaves `items` untouched.
13. `putChange` for unknown item ID returns `unknown-item` and leaves state unchanged.
14. `putChange` overwrites a prior entry for the same ID (last write wins).
15. `clearChanges` empties `changes` and rotates token.
16. `clearChanges` with stale token is a no-op.

### `tests/unit/surface-routes.test.ts` — Express route layer

1. GET `/surface` returns 404 when no document exists.
2. GET `/surface` returns the full document after a `set`.
3. GET `/surface/changes` returns only `{ dataToken, changes }`.
4. POST `/mutate` with correct token applies and returns new token.
5. POST `/mutate` with stale token returns 200 with `{ ok: false, reason: "stale", currentDataToken }` (not a 4xx — protocol-level error).
6. POST `/mutate` validates body shape; missing `dataToken` → 400.
7. POST `/clear-changes` clears `changes` only.
8. PUT `/changes/:itemId` writes only into `changes`, not `items`.
9. PUT `/changes/:itemId` for unknown ID returns `{ ok: false, reason: "unknown-item", currentDataToken }`.
10. PUT `/changes/:itemId` with stale token returns `stale` with `currentDataToken`.
11. All mutating routes reject when session does not exist (404).
12. Concurrent simulation: two `mutate` POSTs with the same starting token — exactly one wins, the other returns `stale`.

### `tests/unit/surface-tools.test.ts` — agent tool wrappers

1. `caco_get_surface` returns the route payload verbatim.
2. `caco_get_surface_changes` returns the route payload verbatim.
3. `caco_mutate_surface` forwards body and returns route response.
4. `caco_clear_surface_changes` forwards `dataToken` and returns route response.
5. Each tool injects the current session ID into the route URL (auto-`sessionId` behavior).
6. Each tool surfaces network errors as tool errors (not silent).

### Manual checklist

- Agent populates items + customScript, applet renders via agent's render() function.
- User interacts via agent-provided handlers, mutateChange() sends PUTs, agent reads changes.
- Stale tab race: two browser tabs on same session; edit in tab A; tab B gets `stale` and refreshes.
- Restart durability: interact, restart server, refresh — state + customScript preserved on disk.
- Footer hint: after user edit, footer shows unack count; after agent mutate/clear, hint clears.
- No customScript: applet shows minimal fallback text (item labels only).

## Future extensions

- Agent-provided example library (common patterns like roadmap, kanban, form) as skill docs.
- Multi-document surfaces per session (slug-keyed: `/api/sessions/:id/surface/:slug`).
- WebSocket push of updates instead of polling on the agent side.
- Migration from `update_roadmap` storage into surface document for sessions that opt in.
