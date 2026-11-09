# spec-portal-pager

One pager board across every Caco instance in the portal.

## Goals

- Carl runs Caco on a laptop plus several devboxes, aggregated in `/portal.html`.
  Triage should happen on ONE board, not one pager per instance.
- Waiting cards from every instance, each labeled by instance. Busy rows per instance.
- Send and Dismiss go to the instance that owns the session. Opening a card
  switches the portal to that instance and session.
- An offline or unconfigured instance shows as such and never breaks the board.
- Reuse `pager.html` (stage-then-send well, freeform well, hold, stale marking)
  rather than fork a second UI. The 7-day decay stays server-side
  (`pagerView`, `src/session-manager.ts`), so every instance keeps applying it.
- No new CORS on the pager or message routes.

## Design

**Transport: postMessage through the instance iframes.** The portal already
holds one iframe per instance (`public/portal.html`, `ensureIframe`). Each one
is the instance's own UI on its own origin, so it carries that origin's auth
(devtunnel cookies). The instance page does the HTTP work same-origin and
talks to the portal only by postMessage.

Rejected: the server-side peer fetch (`GET /api/sessions` fans out to
`peers.json`, `src/routes/sessions.ts:164`). It runs in the laptop's Node
process, which has no devtunnel cookies, and forwarding sends through it would
make the laptop server a cross-instance proxy. Cross-origin `fetch` from the
portal would need CORS with credentials on `/api/pager` and `/api/sessions/:id/messages`.

**Protocol** (`public/ts/pager-bridge.ts`, shared by both sides):

| Direction | Message | Meaning |
|---|---|---|
| portal -> instance | `caco:pager:watch` | Start or renew a pager feed. Renewed every 15 s; the feed stops after 60 s without renewal. |
| instance -> portal | `caco:pager:view` `{view}` | The instance's `/api/pager` snapshot, sent after every long-poll return (at most 10 s apart, so it doubles as a heartbeat). |
| portal -> instance | `caco:pager:action` `{reqId, action:'send'|'dismiss', sessionId, text?}` | Perform the same POST `pager.html` does. |
| instance -> portal | `caco:pager:result` `{reqId, ok, status, error?}` | Outcome, with the HTTP status so 404/409 keep their meaning. |
| instance -> portal | `caco:pager:refused` | The portal's origin is not on this instance's allowlist. |

**Trust on the instance side.** An instance answers a bridge request only when
`event.source === window.parent` AND `event.origin` is its own origin or on
`CACO_PORTAL_ORIGINS` (comma list, exact origins, injected into `index.html`
like `SERVER_HOSTNAME`). There is no loopback wildcard: the same-origin guard
(`src/security/same-origin.ts`) already refuses other localhost ports, and the
bridge can send prompts, so it must not be wider. A disallowed parent gets only
`caco:pager:refused`, which carries no data, so the portal can say what to set.
Every reply is posted with an explicit targetOrigin, never `'*'`.

**Trust on the portal side.** A message counts for a peer only when
`event.origin === new URL(peer.url).origin` exactly AND `event.source` is that
peer's iframe window. Requests are posted with targetOrigin set to that origin.

**Merge** (`public/ts/portal-pager.ts`, built to `public/portal-pager.js`):
- Each instance is `pending` (no view yet, under 20 s since start), `live`
  (view within 30 s), `unreachable`, or `refused`.
- Only live instances contribute cards. A card's key is `<peerId>:<sessionId>`,
  and it carries `instanceId` and `instanceName`. Cards are ordered newest
  `idleAt` first across instances. Busy rows are grouped in sidebar order.
- Views are re-validated on arrival (strings only, options as a string array)
  because they cross a trust boundary, even from an allowed origin.

**UI.** `pager.html?portal=1` runs in a same-origin iframe inside the portal and
gets its board from `window.parent.cacoPortalPager` instead of `fetch`. The only
differences from standalone mode: cards are keyed by `key`, show the instance
label, the session name opens the session, and the header shows instance
health. The portal sidebar gets a pager button above the instances, with a
count of waiting cards. `/portal.html#pager` opens straight to the board. The
portal now loads every instance iframe at startup, because the board needs all
of them and an unloaded frame would read as unreachable.

## Invariants

- I1 Standalone `pager.html` behaves exactly as before.
- I2 An instance never acts on, or sends data to, a parent outside its allowlist.
- I3 The portal never attributes a message to a peer unless origin and source both match.
- I4 An action goes only to the instance named in its card key.
- I5 One instance's failure changes only that instance's rows.

## Considerations

- `CACO_PORTAL_ORIGINS` needs a restart, like every `CACO_*` knob. The local
  instance needs nothing: its portal is same-origin.
- Hidden iframes keep running scripts, so feeds keep flowing while the board is shown.
- The portal's existing `caco:navigate` and `caco:navigateSession` handling
  still posts with `'*'` and matches peers by prefix. Out of scope here. Opening a
  card uses an exact targetOrigin.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| A foreign page frames an instance and drives sends | Exact allowlist on the parent origin, plus `source === parent` |
| A sibling iframe spoofs another instance's cards | Portal checks source window and exact origin per peer |
| Remote not configured, board silently missing a machine | `refused` state shown with the origin to add |
| Action sent but no reply (instance went away) | 20 s timeout, reported as a send failure. The card stays, with its draft |
| Double send after a rebuild | The same `acted` suppression as standalone, keyed by card key |

## Acceptance

| # | Oracle |
|---|---|
| P1 | Bridge validation rejects malformed messages (bad type, sessionId, action, missing text) - `pager-bridge.test.ts` |
| P2 | Instance answers only an allowed parent origin, and a disallowed one gets `refused` only - `pager-bridge.test.ts` |
| P3 | Instance performs send/dismiss POSTs and reports status - `pager-bridge.test.ts` |
| P4 | Merge labels, keys and orders cards and skips non-live instances - `portal-pager.test.ts` |
| P5 | Portal ignores views with the wrong origin or source, and routes actions to the keyed peer with an exact targetOrigin - `portal-pager.test.ts` |
| P6 | Unanswered action times out as an error, and instance status degrades to unreachable - `portal-pager.test.ts` |
| P7 | Portal-mode `pager.html` renders labels, sends through the bridge, keeps drafts per key - `pager-page-portal.test.ts` |
| P8 | Existing standalone pager DOM tests still pass - `pager-page-dom.test.ts` |
| P9 | `CACO_PORTAL_ORIGINS` parsing normalizes to exact origins - `portal-origins.test.ts` |

## Plan

### Phase 1 - done
Protocol module, instance responder, portal controller and merge, portal-mode
pager, portal sidebar button, env knob, tests, README.
