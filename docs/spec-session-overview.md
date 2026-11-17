# Spec: session overview (aggregated, read-only)

Status: DRAFT r3. r2 folded in an Astra (gpt-6-astra) review (listed at the
end); r3 applies Carl's decisions (see Decisions).

## Goals

An orchestrator session (a "chief of staff" track, or a morning triage driven by
a wake) needs to see every Caco session on every machine in the portal and
answer, without reading each transcript:

1. **Is it waiting for the right reason?** A session holding an offer is waiting
   on Carl. A session with an armed wake, a pending retry, live herd children or
   a slug schedule is waiting on something that will move it. A session with
   none of these will never move again unless someone acts.
2. **Is it waiting too long?** An old offer, a wake that has fired many times
   without producing anything, a wake whose note names a date that has passed, a
   wake that keeps failing, a turn running for hours.
3. **What does Carl have to do that no single session is doing?**

Hard requirements (Carl):

- **Read only.** Gathering the overview never posts a message, starts or
  resumes a turn or SDK session, marks a session observed, changes an offer, a
  wake, a folder, `lastUsedAt`, or anything else, on any machine. Caco data only,
  no LLM round trips.
- **Covers busy sessions** as well as idle ones.
- **Covers all machines** in the portal.
- **Wake history**, not just the last result.
- **A little last-event context** per session, from disk.

Non-goals: acting on the result (the orchestrator does that with existing tools,
under the comms guard and Carl's direction); summarizing transcripts with a
model; a portal UI in v1 (see Open decisions).

## Current state (grounding)

- **Pager read model** `src/pager-view.ts`: `needsTriage` (`:155-166`) hides an
  offer older than `PAGER_MAX_OFFER_AGE_MS` (7 days, `:27-28`), dismissed offers,
  `agent`/`swarm` kinds, herd children, and (since `50cf5d9`) `auto-archive`.
  That is right for a human board and wrong for an audit: the oldest unresolved
  offers are exactly what an orchestrator must see. The overview therefore does
  **not** reuse `needsTriage` as a filter; it reuses its parts as facts.
- **Wake state** `WakeState` (`src/session-meta-store.ts:133`): one last result,
  no history. Lifecycle paths in `src/wake-manager.ts`: boot rebuild marks a
  `running` wake `interrupted by restart` (`:79-91`), fire/409 restore
  (`:202-235`), settle, archive skip, `applyImport`.
- **Transient retry** (`src/transient-retry.ts`): while a retry is pending the
  session is not busy and no turn outcome is emitted
  (`src/routes/session-messages.ts`, `retryScheduled`).
- **Peers.** `~/.caco/peers.json` (`src/peer-store.ts`) holds raw
  `{url, hostname}`, written only by `portal.html` with a whole-list POST from
  its `localStorage` (`public/portal.html:188-202`), so a stale tab can replace
  a newer list. On the laptop today the URLs are devtunnel **port forwards**
  `http://localhost:53001` and `:53002`. `GET /api/sessions` fans out to every
  peer's `/api/sessions` with no local-only option (`src/routes/sessions.ts:138-180`),
  so calling it from a hub that is itself a peer can recurse.
- **Auth.** The same-origin guard (`src/security/same-origin.ts`) allows a
  request with no `Origin`, which is what Node `fetch` sends, so a
  server-to-server read through a port forward needs no cookie.
- **Transcripts.** `events.jsonl` reaches 136 MB on the laptop. It is not
  strictly append-only: history rotation replaces it through two renames
  (`src/session-history-rotation.ts:285-348`). A tail helper exists
  (`readTailString`, `src/sdk-session-store.ts:248`) but it is synchronous and
  its public caller (`readLastTurnsResult`) can read the whole file.
- `sessionManager.getHistory` does **not** resume a session (active sessions use
  SDK `getEvents`, inactive ones read disk, `src/session-manager.ts:1751-1767`),
  but it does touch the SDK for active sessions and can read whole files, so it
  is excluded here too.
- Session ids are not unique across machines: a portal copy-import keeps the
  UUID (`src/routes/sessions.ts:1205-1218`).

## Design

### Principle: gather everything, classify, then present

Every session the instance knows is gathered and classified first. Filters only
decide what is **rendered**; they never hide a session from classification, and
the output always reports how many sessions each filter omitted and whether any
omitted session is flagged. A flagged session is never omitted silently.

The default output lists **every** session, because the hardest case to catch
is a session that is blocked on Carl but shows nothing: no offer, no wake, no
retry. Such a session looks quiet, so it must not be filtered out for looking
quiet. Rows are tiered instead of filtered:

- **full** rows for sessions with a flag or a `user-offer` wait: all fields,
  context excerpts, wake history;
- **compact** rows for everything else: one line with title, instance, key,
  activity, `waits` kinds and last activity time.

**v1 exclusion:** sessions in the `auto-archive` folder are not collected at
all; the coverage line reports only their count. Archiving is Carl's own
"done for now" signal, and the pager already shows "would wake" for them.
Herd children and `agent`/`swarm` sessions are included and marked.

### Layers

1. **`collectOverviewInputs` (read-only I/O)** in `src/session-overview-io.ts`:
   reads meta with `readSessionMeta`/`getSessionMeta` (never `ensureSessionMeta`),
   `listForPager`-style fields, the wake index, schedule definitions, herd
   links, dispatch state, pending-retry state, and the tail context. An ESLint
   `no-restricted-imports` rule on this file and the route forbids
   `dispatchMessage`, `updateSessionMeta`, `ensureSessionMeta`,
   `unobservedTracker` writers, `activityVersion`, `sessionManager.resume`,
   `getHistory` and the history rotation module.
2. **`buildSessionOverview` (pure)** in `src/session-overview.ts`: inputs plus
   `now`, returns entries, wait reasons and flags.
3. **`GET /api/overview`** in `src/routes/overview.ts`: `scope=local` (this
   instance) or `scope=all` (hub fan-out). A request that carries the peer
   header `X-Caco-Overview-Hop: 1` may only ask for `local`; `all` with that
   header is 400. The fan-out only ever calls `/api/overview?scope=local` on
   peers, and **never** `/api/sessions`. Responses set `Cache-Control: no-store`.
4. **`caco_sessions_overview` tool**: deferred by default, calls the collector
   in-process for local and the fan-out for all, and returns a compact text
   rendering plus JSON.

### Instance identity

Each instance gets a stable id on first start, stored in `~/.caco/instance.json`
(`{id: uuid, name}`; `name` defaults to the hostname, override with
`CACO_INSTANCE_NAME`). `/api/overview` returns it. All keys across machines are
`instanceId:sessionId`. A session id present on two instances (a copy import) is
reported on both, and the hub adds a `duplicate-session` flag to both so the
orchestrator knows one is a stale copy.

### Per-session entry

```ts
interface OverviewEntry {
  key: string;                 // instanceId:sessionId
  instance: { id: string; name: string };
  sessionId: string;
  title: string; titleSource: 'name' | 'workspace-summary' | 'auto-name' | 'none';
  kind: SessionKind; folder?: string; cwd: string | null;
  hidden?: 'herd-child' | 'agent' | 'swarm';   // auto-archive is excluded in v1
  tier: 'full' | 'compact';
  activity: 'busy' | 'idle';
  busy?: { since: string; pendingTools?: number; currentIntent?: string };
  waits: WaitReason[];         // why it may move again; empty = nothing will move it
  offer?: { options: string[]; at: string | null; dismissed: boolean; ageMs: number | null; onPager: boolean };
  wake?: WakeOverview;         // summary + counters + recent history
  schedule?: { slug: string; enabled: boolean; nextRun: string | null; lastResult?: string };
  herd?: { parent?: string; parentState?: 'ok' | 'missing' | 'archived'; children?: number; busyChildren?: number };
  lastHumanAt?: string;        // meta.lastUsedAt
  context: LastContext;
  flags: OverviewFlag[];
}

type WaitReason =
  | { kind: 'turn-running' }
  | { kind: 'retry-pending'; attempt: number }
  | { kind: 'user-offer' }               // fresh, undismissed offer
  | { kind: 'wake'; nextAt: string }     // armed, not paused
  | { kind: 'wake-running' }
  | { kind: 'children'; busy: number }   // herd parent with live children
  | { kind: 'schedule'; nextRun: string };
```

Offer facts are separate from pager visibility: `dismissed`, `ageMs` and
`onPager` (the `needsTriage` verdict) are all reported, so a 10-day-old offer is
visible and flagged even though the pager stopped showing it.

### Wake history

Stored in meta next to the wake so it travels with export/import.

```ts
interface WakeState {           // additions
  slotSeq: number;              // increments per fire attempt
  counters: {
    fires: number; ok: number; errors: number; cancelled: number; interrupted: number;
    offered: number;            // runs whose turn wrote a new offer
    firesSinceHuman: number;    // reset when meta.lastUsedAt moves past humanAnchor
    humanAnchor?: string;       // lastUsedAt value the counter was reset at
  };
  lastOkAt?: string; lastOfferedAt?: string;
  history?: WakeRun[];          // newest last, at most 20, plus a serialized-size cap of 8 KiB
  historySince?: string;        // oldest time still covered by `history`
  pendingRun?: { slot: number; firedAt: string; offerBaseline: string | null };
}

interface WakeRun {
  slot: number;                 // identity of one fire attempt
  dueAt: string; firedAt?: string; settledAt?: string;
  outcome: 'ok' | 'error' | 'cancelled' | 'interrupted' | 'rejected';
  reason?: string;              // fixed strings only, same rule as lastError
  offered?: true; final?: true; retries?: number;
}

interface WakeDefer {           // separate, deduplicated by dueAt
  dueAt: string; kind: 'busy' | 'human' | 'window' | 'concurrency' | 'archived';
  first: string; last: string; count: number;
}
```

Lifecycle contract (each path records **exactly one** terminal run per slot):

| path | record |
|---|---|
| fire accepted | `pendingRun = {slot, firedAt, offerBaseline: meta.responseOptionsAt}`; `fires++`, `firesSinceHuman++` |
| settle ok/error/cancelled | run with that outcome; `offered` iff `responseOptionsAt` is newer than `offerBaseline`; clears `pendingRun` |
| transient retry pending | nothing; the chain's final outcome settles once, with `retries` = attempts |
| fire POST non-2xx | `rejected` run with `HTTP n` |
| 409 race | no run; the restore puts back **only** scheduling fields (`nextWakeAt`, `lastWakeAt`, `lastResult`, `lastError`, `finalWakeAt`) and decrements `slotSeq`/`fires`; history and counters added since are kept |
| POST throws while busy | stays pending (existing rule) |
| turn timeout | `error` / `no idle within timeout` |
| boot with `pendingRun` | `interrupted` / `restart` |
| import (copy or move) with `pendingRun` | `interrupted` / `import` |
| `set` during a pending run | keeps `pendingRun`, history and counters |
| `clear` | removes the wake **and** its history (see Open decisions) |
| defer | updates the `WakeDefer` for that `dueAt`; at most 5 defer records kept |

Imported history is validated (types, lengths, caps) and dropped if malformed.

### Last-event context

`readSessionTailAsync(sessionId, maxBytes = 256 KiB)` in
`src/sdk-session-store.ts`, built on `fs.promises`:

- `open` then `fstat` on the same handle (so the size belongs to the file
  actually read, even across a rotation rename), read `[size - maxBytes, size)`,
  `close` in `finally`.
- Handles short reads; drops the leading partial line when the window starts
  mid-file; drops a trailing line with no `\n` (it may be mid-append); drops a
  line longer than the window; decodes only whole lines, so a UTF-8 sequence cut
  at the boundary is discarded with its line.
- `EBUSY`/`EPERM`/`EACCES`/`ENOENT` give `context.status = 'unavailable'` with
  the error code, never an empty healthy context.
- Never calls rotation reconciliation or any SDK API.
- Cache key: `sessionId`, `maxBytes`, `dev:ino` (Windows: file index) and
  `size`, `mtimeMs` from the same `fstat`. Busy sessions are not cached.
- Concurrency 4 across sessions, plus a whole-call deadline (3 s local). A
  session not reached in time reports `status: 'skipped-deadline'`.

```ts
interface LastContext {
  status: 'ok' | 'unavailable' | 'skipped-deadline' | 'no-events';
  windowCoversTurn?: boolean;   // false = the window held no user.message
  lastUser?: { at: string; source: 'user' | 'scheduler' | 'agent' | 'system' | 'applet' | 'skill'; text: string };
  lastAssistant?: { at: string; text: string };
  lastError?: { at: string; text: string };
  lastEventType?: string; lastEventAt?: string;
}
```

Text limits: user 300, assistant 600, error 200 characters, newlines collapsed.
The assistant excerpt keeps the **end** of the message (a leading `...` marks
the cut), because a question or request to Carl is usually the last thing said.
`lastError` text is redacted before clipping: URLs reduced to scheme and host,
anything matching a token/key/bearer pattern replaced with `[redacted]`.
Excerpts are never logged.

### Flags (derived, pure)

Each flag is `{ code, detail, confidence: 'high' | 'low' }`. `detail` cites the
evidence (times, counts, the quoted note date). Thresholds are constants with
env overrides.

| code | condition | conf. |
|---|---|---|
| `no-driver` | idle, `waits` empty, and the last turn ended in `session.error` | high |
| `no-driver` | idle, `waits` empty, last turn unattended, no offer | low |
| `awaiting-user-no-offer` | idle, `waits` empty, no undismissed offer, the last event is an assistant message (not an error), and its last 400 characters match the ask heuristic below | low |
| `offer-stale` | undismissed offer older than 2 days (including ones past the pager's 7-day decay) | high |
| `offer-dismissed-no-driver` | dismissed offer, `waits` empty | low |
| `wake-quiet-long` | `firesSinceHuman >= 6` and no `offered` since `humanAnchor`, or `lastOfferedAt` older than 7 days with `historySince` older than that | high; low if history does not cover the span |
| `wake-failing` | `consecutiveFailures >= 2`, or paused for failures | high |
| `wake-paused` | paused for `expired` or `imported` | high |
| `wake-expiring` | final wake fired, or the next fire will be final | high |
| `wake-overdue` | `nextWakeAt` over 2 cadences past, not paused, not suspended, and the instance's wake loop is enabled | high |
| `wake-deferred-long` | a `WakeDefer` for the current `dueAt` older than 1 day (e.g. human chatter keeps pushing it) | high |
| `wake-note-dated` | the note has an ISO or `M/D` date before today | low |
| `busy-long` | busy over 1 h | high |
| `retry-exhausting` | a pending retry at attempt 5 or 6 | high |
| `orphan-child` | `herd.parentState` is `missing` or `archived` | high |
| `children-stuck` | herd parent whose children are all idle with `no-driver` | low |
| `duplicate-session` | the same `sessionId` on two instances | high |
| `context-unavailable` | `context.status` is not `ok` | high |
| `human-recent` | human message within 30 min: do not disturb | info |

**Ask heuristic** (for `awaiting-user-no-offer`), applied to the tail of the
final assistant message after stripping code fences and trailing whitespace,
case-insensitive:

- the last sentence ends with `?`; or
- it contains a phrase from a fixed list: `let me know`, `should i`,
  `want me to`, `would you like`, `do you want`, `shall i`, `which option`,
  `please confirm`, `your call`, `waiting for you`, `need you to`,
  `can you (check|confirm|run|send|approve)`.

The phrase list is a constant in `session-overview.ts` with tests; the flag
detail quotes the matched phrase. It is deliberately low confidence: it exists
to surface candidates, and the orchestrator reads the excerpt to decide. A
session with no match still appears as a compact row, so nothing is lost when
the heuristic misses.

`no-driver` (low) and `awaiting-user-no-offer` can both apply; the renderer
shows `awaiting-user-no-offer` first.

### Cross-machine: instance registry and fetch policy

- `~/.caco/peers.json` entries gain `id` (a peer's instance id, learned on the
  first successful fetch), `name`, `origin` (normalized `scheme://host:port`),
  `addedBy: 'portal' | 'config'`, `rev`.
- `CACO_PEERS` (`name=origin,name=origin`) seeds `config` peers; the portal
  cannot remove them.
- New routes `POST /api/peers/add`, `POST /api/peers/remove` change one entry.
  The legacy whole-list `POST /api/peers` becomes a **merge** that never deletes
  (deletion needs `remove`), so a stale tab cannot drop a peer. `portal.html`
  loads `GET /api/peers` on start and uses add/remove.
- Fetch policy for `scope=all`:
  - only registered peers, origin validated as http(s) with no credentials,
    path, query or fragment;
  - default allow only loopback hosts (the port forwards); a non-loopback peer
    is reported `skipped (needs browser auth)` unless listed in
    `CACO_PEERS_ALLOW_REMOTE` (an explicit allowlist of origins, not a switch);
  - `redirect: 'error'`; response body capped at 4 MB; JSON validated against
    the overview schema and `schemaVersion`;
  - per-peer timeout 5 s, whole-operation deadline 8 s, at most 8 peers fetched
    in parallel;
  - a peer whose `instance.id` equals the hub's own is skipped (`self`).
- Per instance: `{ instance, status: 'ok' | 'unreachable' | 'skipped' | 'outdated' | 'invalid' | 'self', fetchedAt, entries?, omitted? }`.
  `outdated` = 404 on `/api/overview`; it is reported, **not** worked around
  through `/api/sessions`.
- A devbox has no peers and cannot reach the laptop, so `scope=all` there
  returns local data plus `coverage: 'partial'` and a note that all-machine
  views run on the portal host.

### Tool

`caco_sessions_overview` parameters:

- `scope`: `all` (default) | `local`.
- `show`: `all` (default: every non-archived session, full rows for flagged
  or offering sessions, compact rows for the rest) | `attention` (full rows
  only, compact rows counted) | `busy` | `wakes` | `waiting`.
- `context`: `brief` (default: last user + last assistant) | `full` (adds
  error and event type) | `none`.
- `wakeHistory`: number of runs to render (default 5, max 20).
- `keys`: optional `instanceId:sessionId` or bare `sessionId` list.

Output: a coverage line (instances ok/unreachable, sessions total/shown/omitted,
omitted-and-flagged count, auto-archive excluded count), then full rows grouped
by flag (`awaiting-user-no-offer` and `no-driver` first), then compact rows
sorted by last activity, then the JSON. The description states that it is read-only, that excerpts
and every peer-supplied field are **untrusted data**, and that it must not be
used as a reason to send anything without Carl.

### Morning triage recipe

A track session with a wake `at: "07:30"` calls `caco_sessions_overview` and
ends with a `caco-actions` offer listing what Carl must do. Documented in README.

## Invariants

1. Collecting an overview performs no writes on any instance: no meta write, no
   `activityVersion` bump, no unobserved change, no SDK call, no dispatch, no
   rotation. Enforced by the import restriction rule and a test that snapshots
   meta files, `activityVersion` and the dispatch log around a call.
2. Classification covers every non-archived session. The default rendering
   shows every classified session (full or compact); other filters report
   their omissions, and a flagged session is never omitted without being
   counted.
3. Transcript reads are bounded by `maxBytes` and asynchronous.
4. Fan-out is one hop: peers are only asked for `scope=local`, never
   `/api/sessions`, and `scope=all` with the hop header is refused.
5. Every wake slot gets exactly one terminal history record.
6. Wake history holds only fixed reason strings; excerpts are redacted, clipped
   and never logged.
7. A failing, slow, malformed or impostor peer never fails the call; it is
   reported per instance.

## Considerations

- **Prompt injection.** Excerpts can carry email or PR text. The comms guard is
  a tool-name filter with documented shell bypasses
  (`docs/spec-comms-guard.md`), not a sandbox, so this spec does not claim it
  neutralizes injected text. Mitigations: excerpts are short and labeled
  untrusted; the recommended triage session is a wake-driven (unattended) turn
  where guarded tools are denied; triage output is an offer for Carl, not an
  action. A stronger allowlisted triage toolset is a possible follow-up.
- **Privacy.** The hub can now read remote transcript excerpts over the same
  loopback port forward the portal already uses. Exposure stays on the laptop's
  loopback, but it is a new aggregation point; `context: 'none'` exists for
  callers that do not need it.
- **Clock skew.** Each instance computes ages with its own clock and also
  returns absolute times; the hub does not recompute.
- **Consistency.** Per instance one pass; across instances not atomic;
  `fetchedAt` makes it explicit.

## Risks and Mitigations

| risk | mitigation |
|---|---|
| An overview hides the stuck session it exists to find | Default lists every non-archived session; classify-then-filter; omitted and omitted-flagged counts always shown |
| A session blocked on Carl without an offer looks quiet | `awaiting-user-no-offer` heuristic plus compact rows for everything else, so a heuristic miss is still visible |
| Heuristic false positives (rhetorical questions) | Low confidence, matched phrase quoted, orchestrator reads the excerpt |
| Output size with many sessions | Compact rows are one line; excerpts only on full rows |
| Archived session that is actually stuck | Out of scope for v1 by decision; count shown; pager "would wake" covers archived wakes |
| Accidental write path added later | Import restriction rule plus the no-write snapshot test |
| Tail read races a rotation or an append | `open` + `fstat` on one handle; partial lines dropped; unavailable reported, never "empty" |
| Wake history double-counts or loses runs | Slot identity and the lifecycle table, each row tested |
| Meta growth | 20 runs, 5 defers, 8 KiB serialized cap, validation on import |
| SSRF or redirect escape through peers | Registered, validated origins only; loopback default; explicit remote allowlist; `redirect: 'error'`; size, time and count caps |
| Recursion between instances | Hop header; peers asked for `local` only; self-detection by instance id |
| Stale portal tab deletes peers | Merge-only legacy POST; explicit remove |
| Misleading flags | Confidence and evidence on each flag; boundary tests |

## Acceptance

| # | behavior | oracle |
|---|---|---|
| O1 | Fixture sessions classify into the expected `waits` and flags at every boundary, including retry-pending, herd parent, schedule, dismissed offer, 10-day offer; auto-archive sessions are excluded and counted | `session-overview.test.ts` |
| O2 | Default lists every non-archived session with the right tier; other filters never drop flagged sessions without counting them | same |
| O11 | `awaiting-user-no-offer`: fires for a trailing question and each listed phrase; not for an error-ended turn, an undismissed offer, an armed wake, a busy session, or a question inside a code fence; long messages are judged by their tail | same |
| O3 | Tail reader: bounded read, partial first and last line, oversized line, UTF-8 split, rename between calls, `EBUSY`, missing file, cache invalidation by identity | `sdk-session-tail.test.ts` |
| O4 | `GET /api/overview?scope=local` performs no writes | route test snapshotting meta, `activityVersion`, unobserved, dispatch |
| O5 | `scope=all`: merges peers, reports unreachable, outdated, invalid, self and skipped; never calls `/api/sessions`; refuses `all` with the hop header; enforces redirect, size and deadline | route test with fake peers |
| O6 | Wake lifecycle table: one terminal record per slot on each path, 409 keeps history, retry chain recorded once, `offered` from the baseline | `wake-manager.test.ts` |
| O7 | History caps (count and bytes), defer dedup, import validation | same |
| O8 | Peer registry: `CACO_PEERS` seeds, merge-only POST, add/remove, origin validation, remote allowlist | `peer-store.test.ts`, route test |
| O9 | Tool rendering: coverage line, full rows by flag first, one-line compact rows, `show`/`context`/`wakeHistory`, untrusted labeling | `overview-tool.test.ts` |
| O10 | Import restriction rule fails on a forbidden import in the overview files | lint fixture test |

## Plan

| phase | scope | acceptance |
|---|---|---|
| 1 | Instance identity; wake history and counters with the lifecycle contract | O6, O7 |
| 2 | Async tail reader and `LastContext` with redaction and cache | O3 |
| 3 | Collector (read-only I/O, import rule) and pure `buildSessionOverview` with waits, flags, tiers and the ask heuristic | O1, O2, O4, O10, O11 |
| 4 | Peer registry changes and `scope=all` fan-out with the fetch policy | O5, O8 |
| 5 | `caco_sessions_overview` tool; API.md, README (tool and morning triage recipe) | O9 |

## Decisions

1. **Default coverage: everything except auto-archive.** The target case is a
   session blocked on Carl that ended without an offer, so quiet sessions must
   be visible. Default `show: 'all'` with full and compact tiers, plus the
   `awaiting-user-no-offer` flag. Auto-archive is excluded in v1 (count only).
2. **Wake history on `clear`:** dropped with the wake.
3. **All-machine view runs on the portal host only;** devboxes return
   `coverage: 'partial'`.
4. **Excerpts:** on by default (`brief`); `none` available.
5. **Portal UI:** none in v1.

## Review log

Astra (gpt-6-astra) review of r1, all addressed in r2:

| finding | resolution |
|---|---|
| Blocker: defaults hid sessions; `needsTriage` hid offers older than 7 days | Classify-then-filter; offer facts separate from `onPager`; omitted counts |
| Blocker: `/api/sessions` fallback re-fans-out | Removed; `outdated` is reported only; hop header |
| Wake history lacked a lifecycle contract | Slot identity, lifecycle table, 409 restore keeps history, retry chains, restart/import |
| 20 records cannot support history claims | Persistent counters, `lastOfferedAt`, `historySince`, confidence, byte cap |
| States confused legitimate waits with abandonment | `waits` list (retry, children, schedule, running wake); `no-driver` with confidence |
| Tail reader consistency underspecified | `open`+`fstat`, async, partial and oversized lines, Windows errors, identity cache |
| Loopback-only not sufficient | Validated origins, explicit remote allowlist, no redirects, size/time/count caps |
| Registry identity and update semantics | Instance ids, composite keys, duplicate flag, merge-only POST, add/remove |
| Overstated injection and privacy claims | Claims removed, redaction, `no-store`, `context: 'none'`, privacy noted |
| Grounding errors | Corrected (`getHistory`, existing tail helper, `skill` source) |
