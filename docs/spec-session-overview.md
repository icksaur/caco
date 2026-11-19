# Spec: session overview (aggregated, read-only)

Status: IMPLEMENTED (r6; phases 1-5 on master 2026-11-17, phase 6 "facts
only" 2026-11-19). r6 supersedes the r5 flags, tiers, ask heuristic and
flag-based ordering; see "r6: facts only" below. r2 folded in an Astra
(gpt-6-astra) review (listed at the end); r3 applies Carl's decisions (see
Decisions); r4 adds the tool output budget; r5 folds in Astra's review of r4.
Implementation notes follow each design section.

## r6: facts only

**Why.** The consumer of the overview is an LLM (GPT or Claude) in an
orchestrator or triage session. It classifies better than fixed rules. The r5
classifier added judgments (flags with confidence, a primary flag, full and
compact tiers, an ask heuristic) that anchored the reader and decided which
rows got excerpts. A heuristic miss became a one-line row the model could not
judge, which is the exact case the feature exists to catch. Observed on
2026-11-18: a finished release was flagged `no-driver`, and a healthy wake was
flagged `wake-note-dated`.

**Rule.** Caco reports facts it can compute exactly and the model cannot
derive. The model makes every judgment. The tool description says so.

**Removed.**

- `flags`, `OverviewFlag`, `OVERVIEW_FLAG_CODES`, `FLAG_RANK`, `flagRank`,
  `primaryFlag`, `tier`, `children-stuck`, `datedNote`.
- `OverviewThresholds`, `DEFAULT_OVERVIEW_THRESHOLDS`,
  `overviewThresholdsFromEnv` and every `CACO_OVERVIEW_*` threshold env var.
  (`CACO_OVERVIEW_TOOL_MAX_BYTES` stays; `CACO_WAKE_EXPIRE_MS` stays where the
  wake code uses it.)
- The ask heuristic: `AskVerdict`, `ask` on the entry and on `TailResult`, the
  fence and phrase logic, and `oversized` / `truncated-start` verdicts in
  `sdk-session-tail.ts`. The tail reader still selects the last substantive
  assistant message for the excerpt.
- `show: 'attention'` (route 400s it like any unknown value);
  `counts.omittedFlagged`, `counts.full`, `counts.compact`; the degrade step
  of the tool budget.

**Kept (facts).** Everything else on the entry: `waits` (empty still means
nothing will move it), offer facts including `onPager`, busy since, pending
tools and intent, retry attempt, the full `WakeOverview` (counters, history,
defers, `consecutiveFailures`, `pausedReason`, `finalWakeAt`, `lastError`),
schedule, herd parent and parent state, children and busy children, folder,
`hidden`, `lastHumanAt`, `lastActivityAt`, `context` including `status`,
`errorCode` and `lastError`, `wakeLoopEnabled` on the response.

**Added (facts that used to live only inside a flag).**

- `duplicateOn?: string[]` on an entry: names (or short ids) of the other
  instances that report the same session id. Set by the hub merge.
- `wake.nextIsFinal?: true` when the next fire will be the final one under
  the wake expiry rule (`isExpired`), only while the wake loop is enabled and
  the wake is not paused.

**Ordering.** One rule for every row: `lastActivityAt` descending (missing
sorts oldest), then `key` ascending. Busy rows are not special-cased; their
`lastActivityAt` is recent.

**`show` values.** `all` (default) | `busy` (busy rows) | `wakes` (rows with a
wake) | `waiting` (idle rows with any wait or any offer, dismissed or not).
Counts are `total`, `shown`, `omitted`, `archivedExcluded`.

**Collection.** Same set as the session list: non-archived sessions with a
cwd. Sessions with no cwd (or `(unknown)`) are not listed in the UI, so they
are not collected or counted.
**Tool rendering.** Every row has the same shape:

```
### <title>
key <instance:session> | instance <name> | <kind>[ (hidden)] | <busy since ... | idle>[ | folder f][ | cwd c]
waits: <list> | none (nothing will move it)
[offer: n option(s) at T, age A, dismissed?, on the pager | not on the pager (reason); options (untrusted): ...]
[wake: every Nh, next T[, next is final], last <result> at T, failures in a row N[, paused <reason>][, last error "..."], counters ...]
[wake note (untrusted): "..."]
[wake runs (last N): ...]
[schedule ..., herd ..., also on <instances>]
last human message T | context <status>[ (code)][, window starts after the turn began]
excerpts (untrusted ...):
  user [source] T: "..." (at most 200 chars)
  assistant T: "..." (at most 400 chars, keeps the end)
  [error T: "..." in context: full]
```

`context: 'none'` drops the excerpt lines. The excerpt cap is per row, so a row
is about 1-1.5 KB. 37 sessions measured on 2026-11-18 fit one 64 KB page;
larger sets paginate in order (rows never merged, each key on exactly one
page, an oversize row clipped with its excerpts cut first). The coverage line
drops the full/compact/degraded and omitted-flagged counts.

**Wire format.** `OVERVIEW_SCHEMA_VERSION` becomes 2. The fan-out validator
drops the flag, tier, primary-flag and ask fields and accepts `duplicateOn`
and `wake.nextIsFinal`. A peer answering with another `schemaVersion` is
reported `outdated` with the version in the reason, never merged.

**Unchanged.** Read-only invariants and the lint rule, wake history recording,
the tail reader's bounds, redaction and cache, peers and fetch policy, paging
and its 60 s cache, `oneLine` sanitizing, `offPagerReason`.

**Acceptance (r6).**

| # | behavior | oracle |
|---|---|---|
| R1 | Entries carry no `flags`, `tier`, `primaryFlag` or `ask`; the facts above are present for fixture sessions (busy, retry, offer fresh/old/dismissed, wake armed/paused/final-next/loop-disabled, schedule, herd parent missing/archived, children) | `session-overview.test.ts` |
| R2 | Order is last activity descending then key, stable under shuffled multi-instance input | `session-overview.test.ts`, `overview-tool.test.ts` |
| R3 | `duplicateOn` is set on every copy of a session id seen on two instances | `session-overview.test.ts` |
| R4 | Every rendered row has excerpts when context was read; `none` has none; pages stay within the byte cap; 1,000 sessions at 8 KB paginate with each key on exactly one page | `overview-tool.test.ts` |
| R5 | `show=attention` is a 400; a peer with `schemaVersion` 1 is `outdated` | route and fan-out tests |
| R6 | The tail reader returns no ask verdict and still picks the last substantive assistant message | `sdk-session-tail.test.ts` |

The sections below were condensed to match: the r5 flags table, ask heuristic,
tiers, primary-flag ordering and degrade step are gone (see the review log and
git history for r5).

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
  `swarm` sessions, herd children, and (since `50cf5d9`) `auto-archive`. Until
  the overview shipped it also hid `agent`-kind sessions; it no longer does,
  since an agent-created session without a herd bond is often a work track that
  asks the user directly.
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

### Principle: gather everything, report facts

Every session the instance knows is gathered and described. Filters only decide
what is **rendered**, and the output always reports how many sessions each
filter omitted. Caco makes no judgments: the consumer (an LLM) reads the facts
and decides what needs attention (see r6).

The default output lists **every** session with the same row shape and
excerpts, because the hardest case to catch is a session that is blocked on
Carl but shows nothing: no offer, no wake, no retry. With every row carrying its
last user and assistant excerpt, the model can see it.

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
   `now`, returns entries with their facts and wait reasons, in one order.
3. **`GET /api/overview`** in `src/routes/overview.ts`: `scope=local` (this
   instance) or `scope=all` (hub fan-out). A request that carries the peer
   header `X-Caco-Overview-Hop: 1` may only ask for `local`; `all` with that
   header is 400. The fan-out only ever calls `/api/overview?scope=local` on
   peers, and **never** `/api/sessions`. Responses set `Cache-Control: no-store`.
4. **`caco_sessions_overview` tool**: deferred by default, calls the collector
   in-process for local and the fan-out for all, and returns a compact text
   rendering only, within an output budget (see Tool). The JSON stays on
   `GET /api/overview` for scripts and a future portal panel.

### Instance identity

Each instance gets a stable id on first start, stored in `~/.caco/instance.json`
(`{id: uuid, name}`; `name` defaults to the hostname, override with
`CACO_INSTANCE_NAME`). `/api/overview` returns it. All keys across machines are
`instanceId:sessionId`. A session id present on two instances (a copy import) is
reported on both, and the hub sets `duplicateOn` on both (the other instances'
names) so the orchestrator knows one copy is stale.

### Per-session entry

```ts
interface OverviewEntry {
  key: string;                 // instanceId:sessionId
  instance: { id: string; name: string };
  sessionId: string;
  title: string; titleSource: 'name' | 'workspace-summary' | 'auto-name' | 'none';
  kind: SessionKind; folder?: string; cwd: string | null;
  hidden?: 'herd-child' | 'agent' | 'swarm';   // auto-archive is excluded in v1
  activity: 'busy' | 'idle';
  busy?: { since: string; pendingTools?: number; currentIntent?: string };
  waits: WaitReason[];         // why it may move again; empty = nothing will move it
  offer?: { options: string[]; at: string | null; dismissed: boolean; ageMs: number | null; onPager: boolean };
  wake?: WakeOverview;         // summary + counters + recent history; nextIsFinal?: true
  schedule?: { slug: string; enabled: boolean; nextRun: string | null; lastResult?: string };
  herd?: { parent?: string; parentState?: 'ok' | 'missing' | 'archived'; children?: number; busyChildren?: number };
  duplicateOn?: string[];      // hub merge: other instances with this session id
  lastHumanAt?: string;        // meta.lastUsedAt
  lastActivityAt?: string;     // max(context.lastEventAt, lastHumanAt, workspace updatedAt)
  context: LastContext;
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
visible even though the pager stopped showing it. The tool names the
reason an offer is off the pager: herd child, swarm session, dismissed, turn
running, offer time unknown, or older than the pager window.

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

Implementation notes (phase 1, `src/wake-history.ts`, `src/wake-manager.ts`):

- `pendingRun` also carries `dueAt`, `final` and `retries`, so the run can be
  written at settle without re-reading the wake.
- `counters.errors` counts both `error` and `rejected` runs. A non-2xx POST
  and a POST that throws while the session is not busy (`network error`) are
  both `rejected`, and both count toward `consecutiveFailures` as before.
- The 409 undo also puts `firesSinceHuman` and `humanAnchor` back to their
  pre-fire values; only the fire itself is undone.
- Transient retries reach the wake through a `turn retry` signal
  (`emitTurnRetry` in `src/turn-outcome.ts`, emitted where the retry is
  scheduled). It only updates `pendingRun.retries`; the run is still written
  once, by the final outcome.
- Defers are stored as `wake.defers`. A defer that repeats with the same kind
  for the same `dueAt` is persisted at most once an hour; ticks in between are
  counted in memory and merged into the next write, so a long busy or archived
  defer does not rewrite meta every tick. Unflushed counts are lost on restart.
- Validation rebuilds each group with known keys only and drops a malformed
  group (history with `historySince`, defers, counters, pending run, or a bad
  timestamp) on its own. `slotSeq` is raised to the highest slot seen. Slots
  must be positive and unique; reasons must be one of the fixed strings (or
  `HTTP nnn`), and `finishRun` maps any other reason to `error`. A pending slot
  that already has a run in history is dropped, so it is never recorded twice.
- While a wake POST is in flight, a turn outcome for that session is held, not
  applied: on 2xx (or a POST timeout while the turn dispatches) the first held
  outcome settles the slot; on 409 it belonged to the human turn that won the
  race and is discarded before the slot is undone.
- A wake created by `set` starts with `slotSeq: 0`, zero counters and
  `historySince = registeredAt`. A wake from before this change gets
  `historySince` from its first recorded run.
- Instance identity: `src/instance-identity.ts`. A missing file is created by
  writing a temp file and hard-linking it into place (fails if another process
  won; the loser adopts the winner's id); an invalid one is moved to
  `instance.json.corrupt` and replaced; any other read error gives an in-memory id for that process only,
  so a transient error never replaces a good id.

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

Text limits: user 200, assistant 400, error 200 characters, newlines collapsed
(r6; r5 used 300 and 600).
The assistant excerpt keeps the **end** of the message (a leading `...` marks
the cut), because a question or request to Carl is usually the last thing said.
`lastError` text is redacted before clipping: URLs reduced to scheme and host,
anything matching a token/key/bearer pattern replaced with `[redacted]`.
Excerpts are never logged.

Implementation notes (phase 2, `src/sdk-session-tail.ts`):

- `readSessionTailAsync(sessionId, maxBytes, {busy})` returns
  `{context}` (r6 removed the ask verdict); `readSessionTails(items, {concurrency: 4, deadlineMs: 3000})`
  runs many with the concurrency cap and the whole-call deadline. A read still
  running at the deadline reports `skipped-deadline` and finishes in the
  background (it only closes its handle).
- `LastContext` adds `errorCode` (the fs code) when `status` is `unavailable`.
  Any fs error is `unavailable`, not just the four listed codes.
- Window decoding splits on `\n` bytes, so only whole lines are decoded. A
  window that starts mid-file and holds no complete line is `no-events`.
- Event names are the persisted SDK ones: `user.message` (`data.content`,
  source parsed from the `[source:id]` prefix), `assistant.message`
  (`data.content`; empty content with `toolRequests` is not substantive),
  `session.error` (`data.message`). Everything else (`assistant.turn_end`,
  `tool.execution_complete`, `session.usage_record`, `hook.*`, a persisted
  `session.idle` if any) is skipped. The assistant excerpt is the last
  substantive (non-empty) `assistant.message` in the window, whatever follows
  it.
- Redaction also covers JWTs and any 32+ character opaque token.
- The cache is per process, at most 512 entries, keyed by session and
  `maxBytes`, valid while `dev:ino:size:mtimeMs` from the same `fstat` match.

### Facts and waits (phase 3, revised by r6)

Implementation: `src/session-overview.ts`, `src/session-overview-io.ts`,
`src/routes/overview.ts`.

- The collector takes an injectable `OverviewSources` (every member a read).
  Sessions come from the session cache (`listForPager` ids and cwd), meta from
  `readSessionMeta`, busy from `dispatchState`, the pending retry attempt from
  `transient-retry` (recorded when the retry is scheduled), schedules from
  `last-run.json` (`sessionId`), herd links from children's `orchestratedBy`
  (not the in-memory herd index), tails from `readSessionTails`, and the wake
  expiry window (`CACO_WAKE_EXPIRE_MS`) for `nextIsFinal`. Archived sessions
  are listed for counts and herd parent state, but their tails are not read.
- The lint rule covers `session-overview.ts` as well. It forbids imports of
  rotation, `activity-version`, `unobserved-tracker`, `wake-runtime` /
  `wake-manager`, `session-messages`, `session-auto-repair`, the meta write
  functions and the peer-registry writers, plus calls named `resume`,
  `getHistory`, `getEvents`, `dispatchMessage`, `updateSessionMeta`,
  `ensureSessionMeta`, `setSessionMeta`, `markIdle`, `markObserved`, `bump`,
  `send`, `sendAndWait`.
- Waits:
  - `user-offer`: an undismissed offer with a known time no older than the
    pager's 7-day decay, on an idle session.
  - `children`: a herd parent with at least one busy (non-archived) child.
  - `wake`: an armed, unpaused wake, only while `caco_wake` is enabled (the
    loop never fires otherwise); `wake-running` whenever its turn is running.
- `wake.nextIsFinal`: `isExpired` at `nextWakeAt`, only when no final wake has
  fired, the wake is not paused and the loop is enabled.
- `show`: `all` | `busy` (busy rows) | `wakes` (rows with a wake) | `waiting`
  (idle rows with any wait or any offer, dismissed or not). Counts are
  `total`, `shown`, `omitted`, `archivedExcluded`.
- `context: 'none'` sets `context.status = 'not-read'`. `brief` removes
  `lastError` and `lastEventType` from the response.
- Order: `lastActivityAt` descending (missing sorts oldest), then `key`.

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

Implementation notes (phase 4: `src/peer-store.ts`, `src/overview-fanout.ts`,
`src/routes/overview.ts`, `src/routes/sessions.ts`, `public/portal.html`):

- Legacy `{url, hostname}` entries are read as `addedBy: 'portal'` with
  `origin` derived from `url` when valid; `url`/`hostname` stay on every
  entry so the existing `/api/sessions` fan-out keeps working unchanged.
  Writes are atomic (temp + rename).
- `CACO_PEERS` peers are merged in at read time and never deleted; a stored
  id for one (if any) carries over to the config entry.
- The portal no longer posts its whole list on every change. On load it posts
  once (merge only, so it can only add) and then adopts server peers it lacks;
  `+` and remove call `/api/peers/add` and `/api/peers/remove`. Removing a
  config peer is refused in the portal and by the server (403).
- The hub classifies locally with `show: 'all'`, asks peers for
  `show=all` with the caller's `context`, merges with
  `mergeSessionOverviews` (`duplicateOn`, `compareEntries`), then
  applies `show`/`keys`. Per-instance `counts` are reported in `instances`.
- Status details: an invalid origin is `invalid`; a redirect is `invalid`
  (`redirect refused`); a second peer reporting an instance id already seen
  is `skipped` (`duplicate instance id`); a peer whose stored `id` equals
  ours is `self` without a request. Entries whose `key` or `instance.id` do
  not match the reporting instance make the whole response `invalid`.
- Peer ids are NOT persisted (review fix after phase 5): collection,
  including `scope=all` and the tool, writes nothing, `peers.json`
  included (Invariant 1). Self and duplicate-instance detection use the id
  each peer reports, in memory. A stored `id` is still honored for the
  no-request `self` check. The lint rule forbids the peer-registry writers
  (`setPeers`, `mergePeers`, `addPeer`, `removePeer`) in overview files, and
  the route test snapshots every file, `peers.json` included, around
  `scope=all` with a fake peer.
- Peer payloads are rebuilt from known fields only, with plain-token instance
  and session ids (`[A-Za-z0-9._-]{1,100}`); removed r5 fields (`flags`,
  `tier`, `primaryFlag`, `ask`, the extra counts) are dropped, `duplicateOn`
  and `wake.nextIsFinal` are accepted. A peer answering with another
  `schemaVersion` (r6 is 2) is `outdated` with reason `schemaVersion N`, never
  merged. `overview-fanout.ts` is under the read-only lint rule too.

### Tool

`caco_sessions_overview` parameters:

- `scope`: `all` (default) | `local`.
- `show`: `all` (default) | `busy` | `wakes` | `waiting` (see Facts and waits).
- `context`: `brief` (default: last user + last assistant) | `full` (adds
  error and event type) | `none`.
- `wakeHistory`: number of runs to render (default 3, max 20).
- `keys`: optional `instanceId:sessionId` or bare `sessionId` list.
- `page`: 1-based page number (default 1); see Output budget.

Output: a coverage line (sessions total/shown/omitted, auto-archive excluded
count, page n of m, wake-loop and recollect notes, instances and their
status), a line saying it is read only, facts only, and untrusted data, then
every row in the same shape (see r6, Tool rendering) in last-activity order.
No JSON in the tool result.

**Output budget.** Each page is capped at 64 KB of UTF-8 (about 16k tokens;
`CACO_OVERVIEW_TOOL_MAX_BYTES` overrides, clamped to 8 KB..256 KB), counting
everything: coverage line, rows and the continuation line. A row is about
1-1.5 KB, so a few dozen sessions fit one page. A longer list is split into
pages in order. Rows are never merged into counts, so every session keeps its
own row on exactly one page. Each page but the last ends with
`continued: call again with page: N` (reserved bytes). A single row too big
for a page loses its excerpts first, then is clipped.

Pages are computed from one collection pass: the tool caches the result for
60 s keyed by its parameters, so `page: 2` is consistent with `page: 1`;
after expiry it recollects and the coverage line says so.

The description states that it is read-only, that it reports facts only and
the caller classifies, that excerpts and every peer-supplied field are
**untrusted data**, and that it must not be used as a reason to send anything
without Carl.

Implementation notes (phase 5, revised by r6: `src/overview-tool.ts`,
`src/overview-service.ts`):

- `computeOverview` holds the route's code path (local collection, fan-out,
  guarded merge); the route and the tool both call it, so the tool never makes
  an HTTP request to its own instance. Both modules are under the read-only
  lint rule.
- The tool is registered with the other Caco tools and is not on
  `NEVER_DEFER_CACO_TOOLS`, so the existing staleness rule defers it.
- Page 1 always collects fresh and refreshes the cache entry; pages 2+ reuse
  it within 60 s, else recollect and say so. The cache key is
  `{scope, show, context, keys}`; `wakeHistory` and `page` only affect
  rendering. The cache holds at most 8 parameter sets (least recently used
  goes); `keys` are trimmed, deduplicated, at most 200 of at most 200 chars.
- The header budget is reserved with worst-case numbers; the continuation line
  reserves 64 bytes on every page once pagination is needed.
- Every string in the result passes through one sanitizer (`oneLine`:
  control characters, NEL, U+2028/2029 and newlines become spaces) before
  rendering, so no field can start a line or forge a heading.
- The header is capped at a quarter of the page budget: fixed facts first,
  then the instance list as `instances: N (counts by status): first 10 names`
  (names 40 chars, reasons 60, note 200), clipped on a UTF-8 boundary.
- The renderer clips excerpts again at render time (user 200 from the start,
  assistant 400 keeping the end), so a peer's longer excerpts are bounded too.

### Morning triage recipe

A track session with a wake `at: "07:30"` calls `caco_sessions_overview`
(scope all, show all), judges every row itself, and ends with a
`caco-actions` offer listing what Carl must do. Documented in README.

## Invariants

1. Collecting an overview performs no writes on any instance: no meta write, no
   `activityVersion` bump, no unobserved change, no SDK call, no dispatch, no
   rotation. Enforced by the import restriction rule and a test that snapshots
   meta files, `activityVersion` and the dispatch log around a call.
2. Collection covers every non-archived session. The default rendering shows
   every session with the same row shape; other filters report their
   omissions.
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
| An overview hides the stuck session it exists to find | Default lists every non-archived session; omitted counts always shown |
| A session blocked on Carl without an offer looks quiet | Every row has its last user and assistant excerpt; the model judges, no heuristic can miss it |
| Fixed rules mislabel sessions (r5: a finished release flagged `no-driver`) | r6: no rules; facts only, the model classifies |
| Output size floods the orchestrator's context | Text only (no JSON), 64 KB pages (rows never merged), capped excerpts, 3 wake runs by default |
| Archived session that is actually stuck | Out of scope for v1 by decision; count shown; pager "would wake" covers archived wakes |
| Accidental write path added later | Import restriction rule plus the no-write snapshot test |
| Tail read races a rotation or an append | `open` + `fstat` on one handle; partial lines dropped; unavailable reported, never "empty" |
| Wake history double-counts or loses runs | Slot identity and the lifecycle table, each row tested |
| Meta growth | 20 runs, 5 defers, 8 KiB serialized cap, validation on import |
| SSRF or redirect escape through peers | Registered, validated origins only; loopback default; explicit remote allowlist; `redirect: 'error'`; size, time and count caps |
| Recursion between instances | Hop header; peers asked for `local` only; self-detection by instance id |
| Stale portal tab deletes peers | Merge-only legacy POST; explicit remove |

## Acceptance

| # | behavior | oracle |
|---|---|---|
| O1 | Fixture sessions get the expected `waits` and facts, including retry-pending, herd parent, schedule, dismissed offer, 10-day offer; auto-archive sessions are excluded and counted (see R1) | `session-overview.test.ts` |
| O3 | Tail reader: bounded read, partial first and last line, oversized line, UTF-8 split, rename between calls, `EBUSY`, missing file, cache invalidation by identity | `sdk-session-tail.test.ts` |
| O4 | `GET /api/overview?scope=local` performs no writes | route test snapshotting meta, `activityVersion`, unobserved, dispatch |
| O5 | `scope=all`: merges peers, reports unreachable, outdated, invalid, self and skipped; never calls `/api/sessions`; refuses `all` with the hop header; enforces redirect, size and deadline | route test with fake peers |
| O6 | Wake lifecycle table: one terminal record per slot on each path, 409 keeps history, retry chain recorded once, `offered` from the baseline | `wake-manager.test.ts` |
| O7 | History caps (count and bytes), defer dedup, import validation | same |
| O8 | Peer registry: `CACO_PEERS` seeds, merge-only POST, add/remove, origin validation, remote allowlist | `peer-store.test.ts`, route test |
| O10 | Import restriction rule fails on a forbidden import in the overview files | lint fixture test |

O2, O9 and O11 (tiers, flag-rank ordering and degrade, the ask heuristic) were
retired by r6; R1-R6 replace them.

## Plan

| phase | scope | acceptance |
|---|---|---|
| 1 | Instance identity; wake history and counters with the lifecycle contract | O6, O7 |
| 2 | Async tail reader and `LastContext` with redaction and cache | O3 |
| 3 | Collector (read-only I/O, import rule) and pure `buildSessionOverview` with waits (flags, tiers and the ask heuristic, removed in 6) | O1, O4, O10 |
| 4 | Peer registry changes and `scope=all` fan-out with the fetch policy | O5, O8 |
| 5 | `caco_sessions_overview` tool; API.md, README (tool and morning triage recipe) | (O9, retired by 6) |
| 6 | r6 facts only: remove flags, tiers, thresholds and the ask heuristic; add `duplicateOn`, `wake.nextIsFinal`; uniform rows; schema 2 | R1-R6 |

## Decisions

1. **Default coverage: everything except auto-archive.** The target case is a
   session blocked on Carl that ended without an offer, so quiet sessions must
   be visible. Default `show: 'all'` with every row and its excerpts (r6;
   r5 used tiers and an ask flag). Auto-archive is excluded in v1 (count only).
2. **Wake history on `clear`:** dropped with the wake.
3. **All-machine view runs on the portal host only;** devboxes return
   `coverage: 'partial'`.
4. **Excerpts:** on by default (`brief`); `none` available.
5. **Portal UI:** none in v1.
6. **Facts only (r6, 2026-11-19).** The overview is consumed by an LLM, which
   classifies. Caco drops every judgment (flags, tiers, ask heuristic,
   thresholds) and reports facts with excerpts on every row.

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

Astra review of r4 (one round, all addressed in r5):

| finding | resolution |
|---|---|
| Blocker: reserved flagged-key line could itself exceed the budget | Merging removed; degrade then paginate with `page`; byte cap counts everything; budget clamp 8-256 KB |
| Merged counts contradicted "every session listed" | Rows are never merged; every session has a row on some page |
| "Last event is an assistant message" misses completed turns | Last substantive assistant message in the latest turn, skipping lifecycle events |
| Fence handling on a clipped excerpt is unreliable | Heuristic runs in the tail reader on the full message; `truncated-start` yields no flag |
| No deterministic ordering contract | Primary flag rank, last-activity definition, key tie-break; shuffled-input test |
