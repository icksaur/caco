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
  registeredAt: string;      // ISO
  nextWakeAt: string;        // ISO. Advanced on fire, not on deferral.
  lastWakeAt?: string;       // ISO, when the prompt was accepted
  lastResult?: 'ok' | 'error' | 'running';
  lastError?: string;        // error type or short reason only, never prompt or exception text (PII)
  consecutiveFailures: number;
  pausedReason?: 'failures' | 'expired' | 'imported';
}
```

Because it is meta, the wake goes away when the session is deleted or
hard-archived. On boot an in-memory index (`Map<sessionId, nextWakeAtMs>`) is
rebuilt by a meta scan, like `rebuildHerdIndexFromDisk`
(`src/herd-runtime.ts:31`, called in the post-listen scan at 127). Every
`updateSessionMeta` that touches `wake` (`src/session-meta-store.ts:253`)
updates the index in the same place.

**Imported sessions.** The export tar has a `caco/` tree that includes meta
(`src/routes/sessions.ts:1142` and following), so `wake` comes along.
Importing sets `pausedReason: 'imported'`. A session dragged onto another
machine must not start waking there without someone asking. The applet shows
it as paused. It comes back when the session calls `caco_wake set` again,
which a human prompt or the paused status in `status` will lead to.

### Lifecycle and archive

A wake only fires while `meta.folder !== AUTO_ARCHIVE_FOLDER`
(`src/config.ts:72`). This covers manual `/caco.session-archive`, auto-park,
herd disown, and folder PATCH, since they all stage into that folder
(`src/session-archive-reaper.ts:340, 570`). At the tick, a staged session's
wake is **cleared**, not paused. Archiving means "done". If the session is
rescued, it re-arms with `set` like any other session. Hard archive and delete
remove the meta (and with it the wake). The index drops the entry when its
meta read comes back empty.

Auto-park will not park an active track. Its anchor includes `lastIdleAt`
(`docs/spec-auto-park-idle-root.md`), and each wake ends with an idle.

### Wake loop

The wake loop is separate from the slug loop:
`startWakeManager()` next to `startScheduleManager()` (`server.ts:357`), with
`WAKE_CHECK_INTERVAL_MS = 5 min` (env `CACO_WAKE_CHECK_INTERVAL_MS`).

**Why not the 30 min slug tick?** `SCHEDULE_CHECK_INTERVAL_MS`
(`src/config.ts:46`) would add up to 30 min of lateness to a 60 min cadence,
which is 50% jitter. With 5 min ticks the jitter stays under 9%. Each tick only
reads the in-memory index and opens meta for due entries, so 5 min costs
nothing. The slug tick stays as it is.

On each tick, for each due entry (`nextWakeAtMs <= now`), in order:

1. Read meta. If it is gone, drop the entry. If the folder is
   `auto-archive`, clear the wake. If `pausedReason` is set, skip.
2. **Expiry.** If `now - max(lastUsedAt, registeredAt) > WAKE_EXPIRE_MS`
   (7 d), set `pausedReason: 'expired'` and skip.
3. **Active hours.** If `now` is outside `WAKE_WINDOW`, set `nextWakeAt` to
   the next window start and skip. This gives "due outside the window fires
   once at the window start". Missed wakes collapse into one and never stack.
4. **Live conversation.** If the session is busy (`dispatchState.isBusy`,
   `src/dispatch-state.ts:106`), or a human message arrived within
   `WAKE_HUMAN_QUIET_MS` (30 min, by `lastUsedAt`), skip. **`nextWakeAt` is
   not touched**, so the next tick tries again. A skip is neither a fire nor
   a failure. There is no fixed 1 h busy delay.
5. **Fire.** POST `/api/sessions/:id/messages` with `source:'scheduler'`,
   `scheduleSlug:'wake'`, and a correlationId generated by the wake manager.
   Then set `lastWakeAt = now`, `lastResult = 'running'`, and
   `nextWakeAt = now + everyMinutes`. A 409 means a race lost to the busy
   check, so do the same as step 4. Any other non-2xx counts as a failed wake.

Wakes fire one after another inside a tick, under an `isExecuting` guard, the
same pattern as `src/schedule-manager.ts:13, 38`. A fire only waits for the
POST to be accepted, not for the turn to finish, so one slow wake does not hold
up the others.

**Human recency gap.** `lastUsedAt` is only stamped for messages with no
`source` (`src/routes/session-messages.ts:326`). Steering
(`mode:'immediate'`, 175-197) does not stamp it, but it is human activity.
Phase 1 adds the stamp there. `lastUsedAt` is already defined as "the user
touched this session" (it anchors cold-resume and archive), so stamping it for
steering fixes that meaning too.

**Restart.** The index is rebuilt from meta. Any wake whose `nextWakeAt` has
passed fires once on the first tick, after going through the same checks.
`lastResult:'running'` left over from before a restart becomes
`'error'`/"interrupted by restart".

### Wake prompt

```
[scheduler:wake] Scheduled wake. Local time Tue 2026-11-03 14:05.
Last wake 4h 2m ago. Note: waiting on PR 5504426 review.
Check whether what you are waiting on has changed. If you are no longer
waiting on external data, call caco_wake with action "clear" to stop these wakes.
```

The prefix comes from `prefixMessageSource`
(`src/message-source.ts:91-100`), the same as slug runs (`session-messages.ts:319`).
The first wake says "Registered 4h 0m ago." The note line is left out when
there is no note. The prompt never mentions defers or pauses, so the
transcript only grows by these four lines.

### Task 1 semantics, applied to wakes

A wake POSTs with `source:'scheduler'`, so the rules from commit 52f83e1
apply as they are:

- The pending `responseOptions` is **not** cleared when the wake is received
  (`session-messages.ts:268`).
- The turn, including any `caco_enable_tools` continuations, marks the session
  unobserved and fires the external idle feed **only if
  `responseOptionsAt` advanced** (`observesIdle`, `src/idle-authority.ts:107`).
  A quiet wake, or an identical re-offer (`sameOffer`,
  `src/dispatch-events.ts`), stays silent, and a card dismissed in the pager
  stays dismissed.

Wakes need no new observation logic.

### Outcome at real idle

Today a slug run is recorded as a success at accept (162-165). The real end
of a turn is known in exactly two places in `dispatchMessage`:

- `session.idle` -> `handleIdle` (`session-messages.ts:631-639`), whose
  real-idle branch is past the false-idle return at `idle-authority.ts:89`.
- `session.error`, or a thrown dispatch error (588, 695-726).

A small `turn-outcome` emitter is added. `handleIdle`'s real-idle branch emits
`{sessionId, correlationId, result:'ok'}`. The error paths emit
`result:'error'` with an error type. Continuations keep the original
correlationId (Task 1), so a chain reports once, at its real end. The wake
manager listens and settles the matching `running` wake:

- `ok` resets `consecutiveFailures`.
- `error` increments it. At `WAKE_MAX_FAILURES` (3) it sets
  `pausedReason:'failures'`.

A `running` wake that has not settled after `WAKE_TURN_TIMEOUT_MS` (2 h) is
recorded as an error, "no idle".

The wake manager sends its own correlationId in the body. Phase 1 confirms
that `effectiveCorrelationId` uses the body value for `source:'scheduler'` and
adds that if it does not. Otherwise the route returns `correlationId` (today
it returns only `{ok, sessionId}`, 339).

**Slug schedules.** Recommendation: slug runs should use the same outcome
recording (Phase 3). The applet shows `lastResult` for them as well, and today
"success" only means "the POST got through". Their storage and their 1 h busy
defer stay unchanged. The C3 work (binding a session, archive awareness) is a
separate task.

### Guards

| guard | value | why |
|---|---|---|
| Wakes per session | 1 | `set` replaces. There is nothing to leak. |
| Global active wakes | 20 (`CACO_WAKE_MAX`) | Bounds spend. `set` past the cap returns an error that names the cap. Paused wakes don't count toward it. |
| Consecutive failures | 3, then pause | Keeps a broken session from burning a turn every hour. |
| Inactivity expiry | 7 d without a human message, then pause | Same as Claude Code's 7-day recurring expiry. A track nobody reads should stop. Re-arm with `set`. |
| Active hours | `CACO_WAKE_WINDOW`, default `Mon-Fri 07:00-19:00` local | The model never has to think about nights or weekends. `always` turns it off. |

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
4. A deferral never advances `nextWakeAt` and never counts as a failure.
5. `lastResult` is written at the real idle or error of the turn, never at
   accept. `running` is the only state written at accept.
6. A wake is `source:'scheduler'` in every respect. It does not clear the
   pending offer, and it badges only on a new offer.
7. `caco_wake` is never auto-deferred while it is registered.
8. Imported wakes do not fire until the session re-arms them.

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
- **Window timezone** is server-local, which is Carl's machine. A multi-user
  server would need a per-session setting. Not in scope.

## Risks and Mitigations

| risk | mitigation |
|---|---|
| A model forgets to clear and wakes forever | Expiry after 7 d without human contact. Every prompt includes the clear instruction. Stop button. |
| Many tracks multiply cost | Global cap of 20, 1 h floor, active window. |
| A wake lands while Carl is typing | 30 min human-quiet defer, steering stamps `lastUsedAt`, plus the busy check. 409 means defer. |
| `running` stuck after a crash or restart | 2 h timeout. On boot, a stale `running` becomes "interrupted by restart". |
| Wake is hidden by tool deferral | Listed in `NEVER_DEFER_CACO_TOOLS` with a reason. |
| Hard-disabling `caco_wake` strands wakes | The loop does not fire while the tool is disabled. |
| An imported wake fires on a new machine | Arrives paused with reason `imported`. |
| PII in `lastError` | Only error type or a fixed reason string. Never exception text. |

## Acceptance

| # | behavior | oracle (unit test) |
|---|---|---|
| A1 | `set` stores meta and index; `set` again replaces | meta has one `wake` with the new cadence; index has one entry |
| A2 | `everyHours` 0, 25, or 1.5 is rejected | tool returns an error naming 1-24; meta unchanged |
| A3 | `caco_wake` is never auto-deferred | `isDeferEligibleCacoTool('caco_wake') === false` |
| A4 | A due wake fires with `source:'scheduler'`, `scheduleSlug:'wake'`, and the prompt lines | fetch mock body; prompt has local time, elapsed time, note, and "clear" |
| A5 | Busy or human-recent session defers | no POST; `nextWakeAt` unchanged; failures unchanged; fires on the next tick when clear |
| A6 | Steering stamps `lastUsedAt` | route harness: immediate-mode POST updates meta |
| A7 | A due wake outside the window fires once at window start | clock fake: Saturday due -> `nextWakeAt` = Monday 07:00; one POST at Monday's tick |
| A8 | Staged session's wake is cleared, not fired | `folder:'auto-archive'` -> `wake` undefined, no POST |
| A9 | Outcome recorded at real idle, not at accept | after POST: `running`; after emitted real idle with the matching correlationId: `ok` |
| A10 | Reveal continuation reports once, at its real end | false idle emits nothing; continuation's idle emits `ok` |
| A11 | Three errors pause | third `error` sets `pausedReason:'failures'`; next tick does not POST |
| A12 | 7 d without human contact pauses | `pausedReason:'expired'` |
| A13 | Global cap | 21st `set` returns an error; paused wakes are not counted |
| A14 | Import pauses | import fixture with `wake` -> `pausedReason:'imported'` |
| A15 | Quiet wake keeps the offer and does not badge; a new offer badges | reuse Task 1 harness with `source:'scheduler'`, `scheduleSlug:'wake'` |
| A16 | `GET /api/wakes` and `DELETE` | route test; DELETE clears meta and index |
| A17 | Applet renders a wake card with Stop | `npm run build:client` passes; manual check against a seeded wake |

## Plan

| phase | scope | gate |
|---|---|---|
| 1 | `meta.wake`, index and boot rebuild, `caco_wake` tool with limits and cap, never-defer entry, steering `lastUsedAt` stamp, correlationId plumbing | A1-A3, A6, A13; typecheck |
| 2 | `wake-manager` loop: window, defers, archive clear, expiry, fire; `turn-outcome` emitter and settle; import pause | A4, A5, A7-A12, A14, A15 |
| 3 | `/api/wakes` routes, jobs applet section with Stop; slug schedules use `turn-outcome` | A16, A17; slug tests updated so `success` is written at idle |
| 4 | Docs: API.md, README Scheduler/Pager, spec-scheduler cross-link | review |
