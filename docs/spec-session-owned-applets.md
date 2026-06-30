# Session-Owned Applets

## Goals

Every session owns its active applet. Switching sessions restores that session's last-active applet. Closing and reopening a session resumes you to exactly where you were — chat scrollback **and** applet panel.

This aligns the UI hierarchy with the data model: session-list (left) → chat-view (middle) → applet-view (right). Sessions own everything to their right.

## Design

`SessionMeta` gains `activeApplet?: string` and `appletParams?: Record<string, string>`. On session switch the resume response includes these fields; the client loads the saved applet or defaults to `session-context`. Two persistence layers coexist: `panelHidden` is a global UI preference (not session-scoped, stored in `~/.caco/preferences.json`); `activeApplet`/`appletParams` are per-session in `meta.json`. Opening an applet calls `POST /api/applets/:slug/load` with `sessionId`; the server persists the applet identity to that session's meta before returning content. A new `DELETE /api/sessions/:id/applet` endpoint clears the active applet. Explicit open (link click, slash command) overrides `panelHidden=true`. URL format adds `?session=<id>&applet=<slug>&<params>`; old `?applet=` URLs remain valid against the active session.

## Mental model

Today: the applet panel is a global view. Sessions and applets are orthogonal.

Proposed: the applet panel belongs to the active session. Each session has a "last-active applet" stored in its metadata. Session switch swaps the applet.

## Two applet patterns (informational, not enforced)

To help authors and agents choose, `APPLETS.md` documents two coexisting patterns:

**URL-stateful applets** — their full display state is encoded in URL params. Reload the URL and you get back what you saw. Examples today: `file-finder` (with `root`), `text-editor` (with `path`), `html-viewer` (with `path`), `git-diff` (with `path` + `file` + `staged`).

**Session-stateful applets** — their state lives in `~/.caco/sessions/<id>/` and they have no URL params. The applet reads from session storage on load. Examples today: `session-context` (reads roadmap, notes, files for active session), `presentation` (reads session-scoped presentation data).

**Mixed applets are allowed.** An applet can use URL params for navigation (path) and session storage for sticky state (collapse, sort). The two patterns are guidance, not constraints.

Why call this out: when an applet uses URL params, the chat can generate a link that re-creates the exact view. When an applet uses session storage, links can't carry state — `?applet=session-context` opens whatever the session has stored.

## Data model

### SessionMeta additions

```typescript
interface SessionMeta {
  // ... existing fields ...
  activeApplet?: string;                  // slug, e.g., "git-status"
  appletParams?: Record<string, string>;  // URL params for that applet
}
```

When the user opens an applet while in a session, these fields are updated. When the user closes the applet panel manually, `activeApplet` is cleared.

Initial value for old sessions: undefined. On first restore, default to `session-context` (always a useful starting point — shows files, roadmap, notes, activity).

## URL convention

### New format

```
/?session=<id>&applet=<slug>&<applet-params...>
```

Session is the primary key. Applet and its params follow.

### Backward compatibility

Old URLs still work:

| Old URL | Behavior |
|---------|----------|
| `/?applet=foo&path=x` | Opens applet using current active session. Saves to session's meta. |
| `/?applet=foo` (no session) | Same — uses active session or creates new chat. |
| `/?session=A` (no applet) | Switches to session A. Restores A's saved applet (or session-context). |
| `/` (no params) | Default app load. Restores last active session, which restores its applet. |

### Cross-session links

Agent-generated links should use the new format when targeting a specific session:

```markdown
[Open git status](/?session=abc-123&applet=git-status&path=/repo)
```

Without `session=`, the link uses the active session (current behavior).

## Panel visibility: hide vs. clear

Two distinct user intents need clear semantics:

**Hide** — temporarily collapse the panel. State preserved. The existing applet toggle button does this (`view-controller.ts hideAppletPanel`/`showAppletPanel`). Session switch loads new content, but does NOT force-show if user has hidden it.

**Clear** — explicitly drop the active applet. `activeApplet` and `appletParams` removed from session meta. Panel becomes empty. Today there is no clear affordance — this spec adds one.

**Persistence model:**
- `panelHidden` is **global** (UI preference in `~/.caco/preferences.json`). It survives session switches and reloads. It is *not* tied to a session.
- `activeApplet`/`appletParams` are **per-session** in `meta.json`. Each session owns its applet content.

**Interaction matrix:**

| `panelHidden` | Session has `activeApplet` | Result on switch |
|---|---|---|
| false | yes | Panel shown, applet loaded |
| false | no | Panel shown, session-context loaded as default |
| true | yes | Panel stays hidden. Applet loads in DOM (ready to show). |
| true | no | Panel stays hidden. session-context preloads. |

**Opening an applet from chat** (clicking a link, slash command) overrides `panelHidden=true` — explicit intent unhides.

**Toggle button** (current applet button): toggles `panelHidden`. Does not modify session meta.

**Clear affordance** (new): an "×" button on the panel header, or `/applet-clear` slash command. Calls `DELETE /api/sessions/:id/applet`. Drops content + hides panel.

## Behavior on session switch

1. User clicks a different session in the session-list.
2. Caco resumes the new session. Resume response includes `activeApplet` and `appletParams`.
3. Caco loads the new session's applet:
   - If `activeApplet` is set → `loadApplet(slug, params)`.
   - Otherwise → `loadApplet('session-context', {})`.
4. Panel visibility respects `panelHidden` (global preference) — the applet loads in the DOM either way; the panel shows only if not hidden.
5. URL updates to reflect new session + applet.

The previous session's applet is destroyed via the normal applet lifecycle.

## Behavior on applet open

1. User clicks an applet link, types a slash command, or navigates within an applet.
2. Applet loads as today.
3. Server writes `{ activeApplet: slug, appletParams: params }` to the active session's `meta.json`.
4. URL reflects the new state.
5. If `panelHidden=true`, opening via explicit user action sets `panelHidden=false`.

## Behavior on applet clear (new)

1. User clicks "×" on the applet panel header (or `/applet-clear`).
2. Frontend calls `DELETE /api/sessions/:id/applet`.
3. Server clears `activeApplet` and `appletParams` from session meta.
4. Frontend hides the panel and updates URL (drops applet portion).
5. On next session switch back, default `session-context` loads (since meta is empty).

Hide and clear are now distinct: hide preserves state for later; clear destroys state.

## Behavior on session creation

New sessions have no `activeApplet`. On first activation:
- Default to `session-context` for the applet panel.
- This gives the user immediate access to roadmap, files, notes for the new session.
- Panel respects the user's manual show/hide preference (set elsewhere).

## Browser history

Each session switch and each applet change pushes a history entry. Back button:
- If the previous entry differs in `session=`, switch sessions (and restore that session's applet).
- If the previous entry differs only in `applet=`, switch applet within the same session.
- The two cases are handled by the same routing logic — read both params from the URL on `popstate`.

## API changes

### Modified: `POST /api/applets/:slug/load`

Already exists; loads applet content. Add behavior:
- Accept body `{ urlParams: Record<string, string>, sessionId?: string }` (today body has `urlParams`; add `sessionId`).
- If `sessionId` is present, persist `{ activeApplet: slug, appletParams: urlParams }` to that session's `meta.json` before returning content.
- Frontend (`router.ts loadApplet`) must include the active session ID in the body.

Response shape unchanged.

### New: `PATCH /api/sessions/:id/applet`

For runtime URL param changes that don't re-load the applet. Called from `navigateAppletUrlParam` / `updateAppletUrlParam` whenever an applet mutates its own URL.

Body: `{ appletParams: Record<string, string> }`.

Server writes `appletParams` into session meta. `activeApplet` is not changed (stays the current slug).

Calls are debounced on the frontend (300ms) to avoid disk thrash on rapid param changes (e.g., search input).

### Modified: `POST /api/sessions/:id/resume`

Already exists. Add `activeApplet` and `appletParams` to the response:

```typescript
{
  // ... existing fields ...
  activeApplet?: string | null;
  appletParams?: Record<string, string> | null;
}
```

### New: `DELETE /api/sessions/:id/applet`

Called when the user explicitly clears the applet. Removes `activeApplet` and `appletParams` from session meta. Frontend then hides the panel.

## Param drift: keeping `meta.appletParams` in sync

URL-stateful applets navigate via `navigateAppletUrlParam` and `updateAppletUrlParam` (in `applet-runtime.ts`). These currently mutate the URL without calling `/api/applets/.../load`. Without intervention, `meta.appletParams` would drift from the actual URL — "resume to exactly where you were" would break for the most common URL-stateful flow.

**Mechanism:** modify `navigateAppletUrlParam` and `updateAppletUrlParam` to call `PATCH /api/sessions/:id/applet` after every URL change. Calls are debounced (300ms trailing edge) to coalesce rapid typing (e.g., search input changes).

**On the server side:** the PATCH endpoint is cheap (one meta.json write). Debouncing prevents disk thrash.

## Reconciling with `src/applet-state.ts`

`applet-state.ts` already maintains an in-memory `activeSlugs` map keyed by sessionId, set when applets load and read by tools like `caco_applet_usage`. The new persistent `meta.activeApplet` overlaps in purpose.

**Decision:** `meta.activeApplet` is the source of truth. `activeSlugs` becomes a derived cache, hydrated from meta on server start.

- On server start, walk session metas and populate `activeSlugs` (best-effort; missing data is fine).
- On `POST /api/applets/:slug/load`, update both `activeSlugs` (in-memory) and `meta.activeApplet` (on disk).
- On `DELETE /api/sessions/:id/applet`, clear both.

Tools reading `getActiveAppletSlug(sessionId)` continue to work unchanged — they get the in-memory value, which is now backed by persistent storage.

## Frontend changes (Phase 2)

`chat-view-controller.ts` updates:
- The typed resume response (`resumeAndLoad`) gains `activeApplet?: string | null; appletParams?: Record<string, string> | null`.
- After `showChat` (existing session activation flow), call `loadApplet` based on the resume data:
  - If `activeApplet` is set → `loadApplet(activeApplet, appletParams ?? {})`.
  - Otherwise → `loadApplet('session-context', {})`.
- Panel visibility respects the global `panelHidden` preference (separate concern, see Panel visibility section).

`router.ts` updates:
- `loadApplet(slug, urlParams)` already takes urlParams. Modify the POST body to include `sessionId: getActiveSessionId()`.
- `handleNavigation` reads both `session=` and `applet=` from URL. If `session=` differs from active, call `activateSession(sessionId)` (existing behavior at router.ts:107) — but document this explicitly in the spec.

## Edge cases

**Invalid session in URL.** `?session=<unknown-id>` — `resumeAndLoad` returns 404. Display a toast "Session not found" and stay on current session. URL is corrected.

**Cross-session link clicked from chat.** Treated as expected behavior — clicking `?session=other&applet=foo` while viewing session A switches the chat to session "other". This is intentional. Cross-session navigation is a feature, not a bug.

**Pre-session (new chat) applet state.** Before any session exists, the applet panel state is global/transient. When the user sends their first message and a session is created, the current applet (slug + params) is written to the new session's meta. Subsequent switches restore it normally.

**Concurrent tabs/windows.** Two tabs viewing the same session each maintain their own URL and may write conflicting `meta.appletParams`. Last write wins. Acceptable for personal use; documented as a known limitation.

**Non-interactive session kinds.** Agent/swarm/scheduled sessions can have `activeApplet` set, typically `session-context` so they're inspectable. No special handling needed.

**Stale async fetches in session-stateful applets.** Applets must guard async results against stale session IDs. Pattern:
```javascript
const sessionAtRequest = appletAPI.getSessionId();
const data = await appletAPI.fetch('/api/...');
if (appletAPI.getSessionId() !== sessionAtRequest) return; // session changed mid-fetch
render(data);
```
This is a convention for session-stateful applets. Existing applets that don't guard may show stale data briefly; not a regression.

**Applet load failure.** 404 (slug not found in registry) → fall back to `session-context`. JS error during applet init → existing error UI (`applet-error` class). User can clear via the new × button.

**Empty `appletParams` for URL-stateful applets.** A saved `text-editor` with no `path` shows the applet's empty state — same as today. Acceptable.

## Implementation phases

### Phase 1: metadata foundation (additive, zero risk)

- Add `activeApplet?: string; appletParams?: Record<string, string>` to `SessionMeta` in `src/storage.ts`.
- Modify `POST /api/applets/:slug/load` (`src/routes/api.ts:249`): accept `sessionId` in body, write meta on load.
- Modify `POST /api/sessions/:id/resume` response (`src/routes/sessions.ts:251-266`): add fields.
- Modify `router.ts loadApplet` to send `sessionId: getActiveSessionId()` in body.
- `applet-state.ts` activeSlugs cache hydrated on server start.

Verify: open an applet → check `~/.caco/sessions/<id>/meta.json` shows `activeApplet`.

### Phase 2: restore on session switch

- Extend `chat-view-controller.ts resumeAndLoad` typed response with new fields.
- After `showChat`, call `loadApplet` based on resume data (slug + params, or default to session-context).
- Verify: switch sessions, see correct applet content load.

### Phase 3: param drift handling

- Add `PATCH /api/sessions/:id/applet` endpoint.
- Modify `navigateAppletUrlParam` and `updateAppletUrlParam` (`applet-runtime.ts`) to call the PATCH endpoint after URL mutation. Debounce 300ms.
- Verify: navigate within text-editor (path changes) → meta updates → resume preserves the latest path.

### Phase 4: URL flip + cross-session links

- Router reads `session=` first. If differs from active session, call `activateSession` before loading applet.
- Caco-generated links (context-footer, applet-runtime) emit `?session=<id>&applet=<slug>&...`.
- Old format `?applet=foo` still works (uses active session).

### Phase 5: clear affordance + close behavior

- Add `DELETE /api/sessions/:id/applet`.
- Add × button to applet panel header. Wire to the DELETE endpoint.
- Add `/applet-clear` slash command as keyboard equivalent.
- Verify: clear an applet → switch away and back → session-context loads (no restore).

### Phase 6: APPLETS.md documentation

- Document URL-stateful vs session-stateful patterns.
- Note mixed is fine; no enforcement.
- Update applet inventory with pattern notes.

### Phase 4: close behavior + cleanup

- Add `DELETE /api/sessions/:id/applet` endpoint.
- Wire the applet panel's close button to call it.
- Don't auto-restore once explicitly closed.

### Phase 5: APPLETS.md documentation

- Document the two patterns (URL-stateful vs session-stateful).
- Note that mixed is fine; no enforcement.
- Update existing applet descriptions to indicate their pattern.

## Existing applet inventory

For reference, current applets and their natural pattern:

| Applet | Pattern | URL params | Notes |
|--------|---------|-----------|-------|
| applet-browser | session-stateful | none | Lists available applets |
| color-hash | URL-stateful | none | Stateless utility |
| file-finder | URL-stateful | `root` | Browse files |
| git-diff | URL-stateful | `path`, `file`, `staged` | Specific diff view |
| git-status | URL-stateful | `path` | Repo-specific |
| html-viewer | URL-stateful | `path` | Render an HTML file |
| image-gallery | URL-stateful | `path` | Browse images in dir |
| image-viewer | URL-stateful | `path` | Single image |
| jobs | session-stateful | none | Scheduled jobs |
| markdown-viewer | URL-stateful | `path` | Render markdown |
| mcp-servers | session-stateful | none | MCP config + status |
| presentation | session-stateful | none | Session-scoped slides |
| session-context | session-stateful | none | Default per session |
| session-search | session-stateful | none | Search across sessions |
| text-editor | URL-stateful | `path` | Edit a file |
| themes | session-stateful | none | Theme picker |

No reclassification needed for the flip — all applets remain functional under session-ownership because:
- URL-stateful applets get their state restored via `appletParams`
- Session-stateful applets read from `~/.caco/sessions/<id>/` which automatically tracks the active session

## Risks and Mitigations

1. **Phase 3 URL semantics.** Cross-session links that omit `session=` use the active session, which may not be what the agent meant. Mitigation: when emitting a link from a specific session's context (chat-footer, applet-runtime), always include `session=`.
2. **Resume race.** Applet load may complete before session resume finishes, briefly showing the wrong session's state. Mitigation: session-stateful applets re-render on `onSessionChange` (already do).
3. **First-time UX.** Existing sessions have no `activeApplet`. On first switch after the upgrade, default `session-context` opens, which may surprise users who had no applet visible. Mitigation: respect a "panel hidden by user" preference that persists.
4. **Applet not found.** A saved `activeApplet` references an applet that was deleted. Mitigation: 404 falls back to `session-context`.

## Out of scope

- Enforcing applet resettability — applets handle their own state restore.
- Enforcing URL-stateful vs session-stateful patterns — both allowed, mixed allowed.
- Auto-classification of applets — they classify themselves by which API they use.
- Multi-applet panels — one applet at a time, as today.

## Acceptance

- Observable: Open session A → switch to session B → switch back to A → A's previously-open applet (e.g. `git-status`) is restored automatically. New session defaults to `session-context`. "×" button clears the active applet and hides the panel. `/applet-clear` slash command does the same.
- Budgets: n/a
- Gates: `npm run build`, `npm test` green.
- Oracles: by-construction (meta persistence covered by storage tests); visual signoff on session-switch applet restoration and clear behavior.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Extend SessionMeta with activeApplet/appletParams | `src/types.ts` (or storage types) | by-construction |
| 2 | Persist applet on load (POST /api/applets/:slug/load) | `src/routes/applet-routes.ts` | by-construction: meta updated with activeApplet |
| 3 | Add DELETE /api/sessions/:id/applet | `src/routes/sessions.ts` | by-construction |
| 4 | Restore applet on session switch (client) | `public/ts/chat-view-controller.ts`, `public/ts/router.ts` | visual: correct applet on switch |
| 5 | × button + /applet-clear slash command | `public/ts/view-controller.ts`, `public/ts/command-registry.ts` | visual: clear works |
| 6 | Global panelHidden preference | `src/storage.ts`, `public/ts/view-controller.ts` | by-construction |
