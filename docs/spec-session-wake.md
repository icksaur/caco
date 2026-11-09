# spec-session-wake

Session self-wake schedules. A session asks Caco to wake it again later,
and the wakes appear in the Job Scheduler applet next to the slug schedules.

## Goals

Long-lived "track" sessions wait on things outside Caco, like a PR review or a
mail reply. Today there are two ways to bring them back, and neither fits:

- A slug schedule (`src/schedule-manager.ts`) is set up by a human, keyed by
  slug, records success when the POST is accepted (162-165), and pushes a busy
  session back by a fixed hour (136-144, `SCHEDULE_BUSY_DELAY_MS`,
  `src/config.ts:47`).
- The human pokes the session by hand.

A session should be able to say "wake me every N hours while I'm waiting".
That means:

1. One built-in tool, `caco_wake`, that is always in the tool list.
2. Every wake shows in the jobs applet with its outcome. A failed wake shows
   as failed.
3. Wakes never land in a live conversation, never wake a session that has
   been archived, and stop on their own when nobody is listening.
4. A wake prompt short enough to cost almost nothing. The session already has
   its context.

Non-goals: cron expressions, one-shot timers, waking a different session,
replacing slug schedules.

## Design

### Tool: `caco_wake`

One tool. It only ever acts on the session that calls it (via `SessionIdRef`,
the same pattern as `createHerdTools`, `src/herd-tools.ts:74`).

| action | params | effect |
|---|---|---|
| `set` | `everyHours` (integer 1-24), `note?` (max 200 chars) | Creates the wake, or replaces the existing one. The first wake is due `everyHours` from now. |
| `clear` | none | Removes the wake. Calling it with no wake set is fine. |
| `status` | none | Returns cadence, note, next wake, last wake, last result, and paused reason. |

The tool description states the 1-24 h range, that wakes skip live
conversations and off-hours, the pause rules, and that the session should
call `clear` as soon as it is no longer waiting on anything external.

**Interval only, in hours.** A groggy human and a model both get "every 4
hours" right. Cron is more than a "check back later" loop needs, and it is
where models make mistakes. A one-shot wake is just `set` followed by `clear`
on the first wake, so it gets no separate mode.

**Limits.**

- **Minimum 1 h.** This matches `MIN_INTERVAL_MINUTES = 60`
  (`src/schedule-store.ts:17-18`) and Carl's "1h cadence or slower". Each
  wake is a full model turn on a long transcript, so cost goes up with
  frequency.
- **Maximum 24 h.** A wake is for a session waiting on external data that
  arrives in hours to days. A daily check catches anything a slower cadence
  would. A cadence over a day also means "not really waiting", and that is
  what the inactivity expiry is for: a 7-day wake would fire once and then
  expire (see Guards). Capping at 24 h makes sure every wake gets several
  checks before it can expire.

Out-of-range values are rejected with an error that states the range. They
are never clamped, so the model learns the rule.

**Note.** The note is optional and capped at 200 characters, for example
"waiting on PR 5504426 review". It is echoed in every wake prompt and shown in
the applet. After compaction it is the cheapest way to remind the session why
it is awake, and it tells Carl what each card is for.

**Always available.** Caco tools are built in the `toolFactory`
(`server.ts:274-295`) and then filtered by `DEFAULT_DISABLED_TOOLS`
(`src/tool-registry.ts:17`). What hides a tool is auto-defer: every Caco tool
is eligible to be deferred once it goes stale, unless it is on
`NEVER_DEFER_CACO_TOOLS` (`src/tool-registry.ts:160-166`, blocklist
rationale at 138-159). `caco_wake` is added to the `toolFactory` and to
`NEVER_DEFER_CACO_TOOLS`. The documented reason:

> Every wake prompt tells the session to call `caco_wake clear` when it is no
> longer waiting. A wake-only session calls the tool rarely, so it would go
> stale and get deferred. That would break the promise in the prompt and keep
> the loop running. Same reasoning as `retrieve_output`.

It is not added to `PROTECTED_TOOLS` (`src/tool-registry.ts:33`). An operator
can still hard-disable it with `CACO_DISABLED_TOOLS`. While it is disabled,
the wake loop does not fire, because a wake that cannot be cleared is the
runaway case.

### Storage

The wake lives on the session's own meta, `src/session-meta-store.ts`:

```ts
meta.wake?: {
  everyMinutes: number;      // 60..1440. Stored in minutes, so a later finer step needs no migration.
  note?: string;
  registeredAt: string;      // ISO. Kept when `set` replaces an existing wake.
  nextWakeAt: string;        // ISO. Advanced on fire and on an off-hours defer only.
  lastWakeAt?: string;       // ISO, when the prompt was accepted
  lastResult?: 'ok' | 'error' | 'running';
  lastError?: string;        // fixed reason string only, never prompt or exception text (PII)
  consecutiveFailures: number;
  finalWakeAt?: string;      // ISO, set when the expiry wake fired
  pausedReason?: 'failures' | 'expired' | 'imported';
}
```

Because it is meta, the wake goes away when the session is deleted or
hard-archived. On boot an in-memory index (`Map<sessionId, WakeState>`) is
rebuilt by a meta scan, like `rebuildHerdIndexFromDisk`
(`src/herd-runtime.ts:31`). Every write of `meta.wake` goes through the wake
manager's single write helper (`src/wake-manager.ts`), which updates the
index in the same step.

**Imported sessions.** The export tar has a `caco/` tree that includes meta
(`src/routes/sessions.ts`, export and import routes), so `wake` comes along.
What it means depends on how the archive was made:

- **Migration** (`GET /sessions/:id/export?delete=true`, which deletes the
  source after export): the export writes a `wake-migration.json` marker into
  `caco/<id>/`. Import consumes the marker and keeps the wake armed, because
  the source no longer exists.
- **Copy** (no `delete`): the source keeps its wake. Import sets
  `pausedReason: 'imported'` so two machines never wake one session. The
  copy re-arms with `caco_wake set`.

Portal drag (`public/portal.html` `transferSession`) currently exports
**without** `delete=true`. It is a copy, the source keeps waking, and the
copy arrives paused. That is consistent, not silent: the track keeps running
where it was. If drag should become a move, the portal adds `delete=true`, and
the marker carries the wake over. That is a portal decision outside this spec.

A `running` wake in either kind of import becomes `error`/"interrupted by
transfer".

### Lifecycle and archive

A wake only fires while `meta.folder !== AUTO_ARCHIVE_FOLDER`
(`src/config.ts:72`). This covers manual `/caco.session-archive`, auto-park,
herd disown, and folder PATCH, since they all stage into that folder
(`src/session-archive-reaper.ts:340, 570`). At the tick, a staged session's
wake is **cleared**, not paused. Archiving means "done". If the session is
rescued, it re-arms with `set` like any other session. Hard archive and delete
remove the meta (and with it the wake). The index drops the entry when its
meta read comes back empty, and on `sessionState.onSessionEnd`.

Auto-park will not park an active track. Its anchor includes `lastIdleAt`
(`docs/spec-auto-park-idle-root.md`), and each wake ends with an idle.

### Wake loop

The wake loop is separate from the slug loop:
`startWakeManager()` (`src/wake-runtime.ts`) starts after listen, next to
`scanHerdsOnBoot()` in `server.ts`, with `WAKE_CHECK_INTERVAL_MS = 5 min`
(env `CACO_WAKE_CHECK_INTERVAL_MS`).

**Why not the 30 min slug tick?** `SCHEDULE_CHECK_INTERVAL_MS`
(`src/config.ts:46`) would add up to 30 min of lateness to a 60 min cadence,
which is 50% jitter. With 5 min ticks the jitter stays under 9%. Each tick only
reads the in-memory index and opens meta for due entries, so 5 min costs
nothing. The slug tick stays as it is.

Each tick first records any `running` wake older than `WAKE_TURN_TIMEOUT_MS`
as failed. Then, for each due entry (`nextWakeAt <= now`, not paused, not
running), oldest first:

1. Read meta. If it is gone, drop the entry. If the folder is
   `auto-archive`, clear the wake.
2. **Active hours.** If `now` is outside `WAKE_WINDOW`, set `nextWakeAt` to
   the next window start and skip. This gives "due outside the window fires
   once at the window start". Missed wakes collapse into one and never stack.
3. **Live conversation.** If the session is busy (`dispatchState.isBusy`,
   `src/dispatch-state.ts:106`), or a human message arrived within
   `WAKE_HUMAN_QUIET_MS` (30 min, by `lastUsedAt`), skip.
4. **Concurrency.** If `WAKE_MAX_RUNNING` (2) wakes are already `running`,
   skip. At Monday 07:00 or after a restart every due wake would otherwise
   fire in one tick: N parallel model turns and a burst against shared
   downstream throttles (ADO allows 200 TSTU per 5 min, shared by every
   track). Deferring staggers them naturally as earlier wakes settle.
5. **Fire.** POST `/api/sessions/:id/messages` with `source:'scheduler'` and
   `scheduleSlug:'wake'`. Before the POST, set `lastWakeAt = now`,
   `lastResult = 'running'`, and `nextWakeAt = now + everyMinutes` (and
   `finalWakeAt` for an expiry wake, see below). A 409 means a race lost to
   the busy check: the pre-fire fields are restored, as in step 3. Any other
   non-2xx, or a network error, is a failed wake.

Steps 3 and 4 never touch `nextWakeAt`; the next tick simply asks again. A
skip is neither a fire nor a failure. There is no fixed 1 h busy delay.

Wakes fire one after another inside a tick, under an `isExecuting` guard, the
same pattern as `src/schedule-manager.ts:13, 38`. A fire only waits for the
POST to be accepted, not for the turn to finish.

**Expiry and the final wake.** Expiry keys on human activity only:
`now - (lastUsedAt ?? registeredAt) > WAKE_EXPIRE_MS` (7 d). `registeredAt`
is only the fallback for a session no human ever wrote to, and `set` keeps it
when it replaces a wake. So an agent that re-arms its own wake, even with
`clear` then `set`, cannot extend it. A silent pause would be invisible: a
track waiting two weeks on a deployment has only quiet wakes, never badges,
and would stop where nobody looks. Instead, the first due wake past expiry
fires once as the **final wake**:

- Its prompt says it is the last unless renewed, and asks the session to end
  with a `caco-actions` block offering to keep waiting. By Task 1 a new offer
  badges and lands in the pager.
- When that turn ends (either outcome), the wake pauses with
  `pausedReason:'expired'` and the session is marked unobserved, so the dot
  shows even if the model forgot the offer.
- A `set` during the final turn itself keeps `finalWakeAt`, so the pause
  still happens.
- If Carl taps renew, his message stamps `lastUsedAt` and the session calls
  `set`. That clears the pause and the final marker.

**Human recency gap.** `lastUsedAt` was only stamped for messages with no
`source` (`src/routes/session-messages.ts`, `if (!source)` before dispatch).
Steering (`mode:'immediate'`) did not stamp it, but it is human activity. It
now does. `lastUsedAt` already means "the user touched this session" (it
anchors cold-resume and archive), so stamping it for steering fixes that
meaning too.

**Restart.** The index is rebuilt from meta. A `running` wake left over from
before the restart becomes `error`/"interrupted by restart" and is not counted
as a failure. Any wake whose `nextWakeAt` has passed is due on the first tick
and goes through the same checks, including the concurrency cap.

**Hard-disabled tool.** While `caco_wake` is in `CACO_DISABLED_TOOLS`, the
tick does nothing: a wake that cannot be cleared is the runaway case.

### Wake prompt

```
[scheduler:wake] Scheduled wake. Local time Tue 2026-11-03 14:05 America/Los_Angeles. Last wake 4h 2m ago.
Note: waiting on PR 5504426 review
Check whether what you are waiting on has changed.
If you are no longer waiting on external data, call caco_wake with action "clear" to stop these wakes.
```

The prefix comes from `prefixMessageSource`
(`src/message-source.ts:91-100`), the same as slug runs.
The first wake says "Registered 4h 0m ago." The note line is left out when
there is no note. The local time uses the window's zone when one is
configured (shown after the time), otherwise server-local. The final wake
replaces the last two lines with the renewal request described above.

### Task 1 semantics, applied to wakes

A wake POSTs with `source:'scheduler'`, so the rules from commit 52f83e1
apply as they are:

- The pending `responseOptions` is **not** cleared when the wake is received.
- The turn, including any `caco_enable_tools` continuations, marks the session
  unobserved and fires the external idle feed **only if
  `responseOptionsAt` advanced** (`observesIdle`, `src/idle-authority.ts`).
  A quiet wake, or an identical re-offer (`sameOffer`,
  `src/dispatch-events.ts`), stays silent, and a card dismissed in the pager
  stays dismissed.

Wakes need no new observation logic. The only exceptions are the two pauses
(failures, expiry), which mark the session unobserved directly.

### Outcome at real idle

Today a slug run is recorded as a success at accept (`schedule-manager.ts`
162-165). The real end of a turn is known in two places:

- The idle authority's real-idle branch, past the false-idle return in
  `handleSessionIdle`. It calls a new optional `onRealIdle` dep, which the
  route wires to `emitTurnOutcome(id, 'ok')`.
- `completeDispatch(reason)` in `dispatchMessage`, the single teardown every
  exit path goes through. Any reason other than `session.idle` (an SDK
  `session.error`, watchdog timeout, send error, failed retry, no session)
  emits `emitTurnOutcome(id, 'error', reason)`. The reason is a fixed string,
  never message text.

`src/turn-outcome.ts` is a small listener set. The wake manager subscribes
and **settles by session**: a `running` wake settles on that session's next
outcome after accept. It does not use correlationId, because
continuations do not keep it: `dispatchMessage` mints `correlationId ||
randomUUID()` and `runAutoContinue` passes none, so each continuation gets a
fresh id. Settling by session is safe because a session has at most one wake,
the session was idle when the wake fired, and any other send while it is busy
gets a 409. A reveal-idle never reaches `onRealIdle`, so a chain of
continuations settles once, at its real end. No correlationId is sent in the
wake POST, which also keeps scheduler messages out of the agent-call guard
and the correlation chain.

- `ok` resets `consecutiveFailures`.
- `error` increments it. At `WAKE_MAX_FAILURES` (3) it sets
  `pausedReason:'failures'` and marks the session unobserved.

A `running` wake that has not settled after `WAKE_TURN_TIMEOUT_MS` (2 h) is
recorded as an error, "no idle within timeout".

**Slug schedules.** Recommendation: slug runs settle the same way, by
session (Phase 3). The applet shows `lastResult` for them as well, and today
"success" only means "the POST got through". Their storage and their 1 h busy
defer stay unchanged. The C3 work (binding a session, archive awareness) is a
separate task.

### Guards

| guard | value | why |
|---|---|---|
| Wakes per session | 1 | `set` replaces. There is nothing to leak. |
| Global active wakes | 20 (`CACO_WAKE_MAX`) | Bounds spend. `set` past the cap returns an error that names the cap. Paused wakes don't count toward it. |
| Wakes running at once | 2 (`CACO_WAKE_MAX_RUNNING`) | Staggers a Monday-morning or post-restart backlog instead of N parallel turns. |
| Consecutive failures | 3, then pause and mark unobserved | Keeps a broken session from burning a turn every hour, visibly. |
| Inactivity expiry | 7 d without a human message (`CACO_WAKE_EXPIRE_MS`), then one final wake, then pause and mark unobserved | Same horizon as Claude Code's 7-day recurring expiry. Keyed on human activity only. The final wake asks Carl, so a long legitimate wait is renewed with one tap. |
| Active hours | `CACO_WAKE_WINDOW`, default `Mon-Fri 07:00-19:00` server-local, optional IANA zone (`Mon-Fri 07:00-19:00 America/Los_Angeles`) | The model never has to think about nights or weekends. Devboxes may run in another system zone, so the zone is configurable and the prompt's local time uses it. `always` turns the window off. An invalid value logs and falls back to the default. |

Expired and failed wakes are **paused**, not cleared, so Carl sees them in the
applet and the session's `status` can explain why it is quiet.

### API and applet

- `GET /api/wakes` returns
  `[{sessionId, sessionName, note, everyMinutes, nextWakeAt, lastWakeAt, lastResult, lastError, pausedReason}]`.
- `DELETE /api/wakes/:sessionId` clears a wake.

Wakes live under their own route rather than on `/api/schedule/:slug`
(`src/routes/schedule.ts`) because they have no slug.

`applets/jobs/script.js` `loadJobs` (13) also fetches `/api/wakes` and shows a
"Session wakes" section above the slug cards. Each card shows:

- the session name, linked to open the session;
- the note;
- "every N h";
- next wake, which reads "paused (reason)" when paused;
- last wake and its result, with a red badge for `error`;
- a **Stop** button that calls DELETE.

There is no Resume button. Re-arming goes through the session, so the session
knows it is being woken.

## Invariants

1. A session has at most one wake, and only the session itself or a human
   (Stop) can change it.
2. A wake never fires into a session that is busy, staged for archive,
   paused, or had a human message within 30 min.
3. A wake never fires outside the active window, and a single window start
   never fires more than once for the same wake.
4. A busy, human-recent, or concurrency deferral never advances `nextWakeAt`
   and never counts as a failure.
5. `lastResult` is written at the real idle or error of the turn, never at
   accept. `running` is the only state written at accept. A running wake
   settles on its own session's next outcome, never by correlationId.
6. At most `WAKE_MAX_RUNNING` wakes are running at once.
7. A wake is `source:'scheduler'` in every respect. It does not clear the
   pending offer, and it badges only on a new offer. The two pauses
   (failures, expiry) always mark the session unobserved.
8. Expiry keys on human activity only. No agent action can extend it.
   Expiry is never silent: one final wake, then a pause with the dot.
9. `caco_wake` is never auto-deferred while it is registered.
10. A copied session's wake does not fire until the session re-arms it. A
    migrated session's wake stays armed.

## Considerations

- **Why meta, not `~/.caco/schedules`.** The wake dies with the session and
  travels with export. Slug schedules outlive sessions on purpose, wakes do
  not.
- **Why a separate route.** It keeps the slug code and its tests untouched,
  and avoids putting fake slugs (`wake-<uuid>`) into the slug namespace.
- **Why pause rather than clear on expiry and failure.** A wake that silently
  disappears looks the same as one that never existed.
- **Why clear rather than pause on archive.** Staging means "done". Rescue
  stays possible, and re-arming is one call.
- **Why settle by session.** It is the only key that survives
  continuations, and the one-wake-per-session plus busy-409 rules make it
  unambiguous.
- **Window timezone** defaults to server-local. A zone in `CACO_WAKE_WINDOW`
  covers devboxes whose system zone is not Carl's. A multi-user server would
  need a per-session setting. Not in scope.

## Risks and Mitigations

| risk | mitigation |
|---|---|
| A model forgets to clear and wakes forever | Expiry after 7 d without human contact, keyed on human activity only. Every prompt includes the clear instruction. Stop button. |
| A long legitimate wait expires unseen | The final wake asks for renewal with a `caco-actions` offer, and the pause marks the session unobserved. |
| Many tracks multiply cost | Global cap of 20, 1 h floor, active window. |
| A backlog fires at once (Monday 07:00, restart) and bursts shared throttles | At most 2 wakes running; the rest defer a tick at a time. |
| A wake lands while Carl is typing | 30 min human-quiet defer, steering stamps `lastUsedAt`, plus the busy check. 409 means defer. |
| `running` stuck after a crash or restart | 2 h timeout. On boot, a stale `running` becomes "interrupted by restart". |
| Wake is hidden by tool deferral | Listed in `NEVER_DEFER_CACO_TOOLS` with a reason. |
| Hard-disabling `caco_wake` strands wakes | The loop does not fire while the tool is disabled. |
| A copied wake fires on two machines | A copy arrives paused with reason `imported`. Only a migration export (which deletes the source) keeps it armed. |
| A migration export of a busy session writes the marker but skips the delete | Both copies can wake. Rare (the export route only skips delete while busy); the imported copy's `status` and the applet show it. |
| PII in `lastError` | Only fixed reason strings (`HTTP 500`, `session.error`, `timeout`). Never exception text. |

## Acceptance

| # | behavior | oracle (unit test) |
|---|---|---|
| A1 | `set` stores meta and index; `set` again replaces and keeps `registeredAt` | `wake-manager.test.ts` |
| A2 | `everyHours` 0, 25, 1.5, or a string is rejected; note over 200 rejected | error names 1-24; meta unchanged |
| A3 | `caco_wake` is never auto-deferred | `tool-registry.test.ts`: in `NEVER_DEFER_CACO_TOOLS` |
| A4 | A due wake fires with the prompt lines and is `running` | fake `post`; prompt has local time, elapsed time, note, and "clear" |
| A5 | Busy or human-recent session defers | no POST; `nextWakeAt` and failures unchanged; fires on a later tick when clear |
| A6 | Steering stamps `lastUsedAt` | route harness: immediate-mode POST updates meta |
| A7 | A due wake outside the window fires once at window start, in the configured zone | Saturday due -> `nextWakeAt` = Monday 07:00; one POST; zone and DST cases in `wake-core.test.ts` |
| A8 | Staged session's wake is cleared, not fired | `folder:'auto-archive'` -> `wake` undefined, no POST |
| A9 | Outcome recorded at real end, settled by session | `running` after fire; another session's outcome ignored; own `ok` settles; route harness: `session.error` and pre-session teardown emit `error`, a scheduler idle does not emit directly |
| A10 | Reveal continuation reports once, at its real end | `idle-authority.test.ts`: `onRealIdle` not called on a false idle, called on the real one; route harness wires it to `ok` |
| A11 | Three errors pause and mark unobserved | `pausedReason:'failures'`; `markUnobserved` called; next tick does not POST |
| A12 | Expiry fires one final wake, then pauses and marks unobserved | prompt contains "FINAL wake" and `caco-actions`; after settle `pausedReason:'expired'`; no further POST |
| A13 | Global cap | a set past the cap errors; paused wakes and the caller's own wake are not counted |
| A14 | Copy import pauses; migration import stays armed | `applyImport(id, false)` -> `imported`; `applyImport(id, true)` -> armed, `running` -> error |
| A15 | Quiet wake keeps the offer and does not badge; a new offer badges | Task 1 route-harness and idle-authority tests (source-based, so they hold for `scheduleSlug:'wake'`) |
| A16 | `GET /api/wakes` and `DELETE` | route test; DELETE clears meta and index |
| A17 | Applet renders a wake card with Stop | `npm run build:client` passes; manual check against a seeded wake |
| A18 | At most 2 running; the third fires after a settle | three due wakes -> 2 POSTs; waiting wake's `nextWakeAt` unchanged; third POST after one settles |
| A19 | Expiry cannot be extended by the agent | re-arm with an old `lastUsedAt` -> next wake is final; `set` during the final turn keeps the pause |
| A20 | 409 restores the pre-fire state; non-2xx is a failure; turn timeout is a failure; restart turns `running` into `interrupted by restart` | `wake-manager.test.ts` |

## Plan

| phase | scope | gate | status |
|---|---|---|---|
| 1 | `meta.wake`, index and boot rebuild, `caco_wake` tool with limits and cap, never-defer entry, steering `lastUsedAt` stamp | A1-A3, A6, A13; typecheck | done |
| 2 | Wake loop (`src/wake-manager.ts`, `src/wake-core.ts`, `src/wake-runtime.ts`): window with zone, defers, concurrency, archive clear, expiry with final wake, fire; `src/turn-outcome.ts` and settle by session; failure pause with dot; import copy/migration | A4, A5, A7-A12, A14, A15, A18-A20 | done |
| 3 | `/api/wakes` routes, jobs applet section with Stop; slug schedules settle via `turn-outcome`; optional: fill the session list's schedule fields so the sidebar clock shows on sessions with an armed wake | A16, A17; slug tests updated so `success` is written at the real end | |
| 4 | Docs: API.md, README Scheduler/Pager, spec-scheduler cross-link | review | |
