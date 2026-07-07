# spec-scheduler

Document of record for the scheduler feature (scheduled prompts to sessions). Describes existing behavior, storage, HTTP surface, and the `jobs` applet so a symptom maps to a theory and location. Not a change spec.

## Goals

Fire a stored prompt into a Caco session on a cron or fixed-interval cadence, unattended. Each schedule reuses (or recreates) a session, records its last outcome, and computes its next run. Users view schedule state via the read-only `jobs` applet; schedules are created/edited via the HTTP API.

## Design

**Two components, one store.**

- `src/schedule-store.ts` — disk I/O. Owns the persistence shape and slug→paths mapping. Pure of runtime timing.
- `src/schedule-manager.ts` — runtime. Owns the check loop, due-decision, firing, session selection, and next-run computation.
- `src/routes/schedule.ts` — thin HTTP adapter over the store + `calculateNextRun`/`triggerSchedule`.
- `applets/jobs/*` — read-only viewer over `GET /api/schedule`.

**Storage.** Per-schedule directory `~/.caco/schedule/<slug>/` with two files:
- `definition.json` — `ScheduleDefinition`: `slug`, `prompt`, `enabled`, `schedule{type:'cron'|'interval', expression?, intervalMinutes?}`, `sessionConfig{model?, persistSession}`, `createdAt`, `updatedAt`.
- `last-run.json` — `LastRunState`: `lastRun` (ISO|null), `lastResult` (`'success'|'error'|null`), `lastError` (string|null), `sessionId` (string|null), `nextRun` (ISO).

Definition and last-run are split so a run outcome never rewrites the user's definition. Reads are typed `ok|missing|corrupt` via `readJsonFile` (`src/disk-read.ts`); the manager treats these three cases distinctly (see Considerations). Writes are plain `writeFile(JSON.stringify(…, null, 2))` — no temp-rename/lock protocol (Risk 1). IDs are the slug from the route param; there is no schedule-specific slug validator (Risk 2).

**Check loop.** `startScheduleManager()` runs one immediate `checkSchedules()`, then `setInterval` every `SCHEDULE_CHECK_INTERVAL_MS` (30 min, `src/config.ts`). Started at server boot, stopped on SIGINT (`server.ts`). A module-level `isExecuting` re-entrancy guard skips a tick if the prior check is still running.

**Due decision** (`checkSchedules`): for each slug — skip if definition corrupt, skip if `!enabled`, skip if `validateScheduleInterval` fails, skip if last-run corrupt; else `nextRun = lastRun?.nextRun ?? now`; due when `nextRun <= now`. Missing last-run ⇒ `nextRun=now` ⇒ fires immediately on first sight.

**Firing** (`executeSchedule`): posts `{prompt, source:'scheduler', scheduleSlug}` to `POST /api/sessions/:id/messages`; the message route prefixes the stored prompt as `[scheduler:<slug>]` (`src/message-source.ts`). Session selection:
- Prior `sessionId` present → reuse it.
  - `409` (busy) → write `lastResult:'error'`, `lastError:'Session busy'`, defer exactly `SCHEDULE_BUSY_DELAY_MS` (1 h) — ignores original cadence (Risk 3).
  - `404` (gone) → `createAndExecute`.
  - other non-2xx → throw → error branch.
- No prior session → `createAndExecute`: `POST /api/sessions` with `cwd: process.cwd()`, `model: sessionConfig.model ?? 'claude-sonnet'`, `kind:'scheduled'`, `description: slug`, then send the message.

**Post-run state.** Success → `lastResult:'success'`, clear error, `nextRun=calculateNextRun(def)`. `persistSession:false` stores `sessionId:null` (forces a fresh session next fire). Error → `lastResult:'error'`, `lastError`, keep prior sessionId, still advances `nextRun`.

**Next-run** (`calculateNextRun`): cron via `CronExpressionParser.parse(expr, {currentDate: now})` `.next()`; interval via `now + intervalMinutes*60_000`. No other type; missing/invalid schedule throws (no silent fallback). No timezone option is passed — cron evaluates in the server process's local time (Risk 4).

**Missed-run catch-up is single-fire.** An overdue schedule fires once, then `nextRun` is recomputed from execution time — missed intervals are not replayed.

## Invariants

- **Split store**: a run outcome writes only `last-run.json`; the user's `definition.json` is never mutated by a fire. (Regresses if firing logic starts persisting definition fields.)
- **Corrupt-safe**: a corrupt `last-run.json` must never default `nextRun` to now — it is skipped, not run. (A careless refactor of the `ok|missing|corrupt` handling would silently re-introduce unintended immediate/duplicate runs.)
- **Single next-run impl**: `calculateNextRun` is the only source of next-run values; the store validates cadence (`validateScheduleInterval`) but does not compute timing.
- **Min cadence**: `MIN_INTERVAL_MINUTES = 60` is enforced on write (PUT/PATCH-enable) and re-checked in the loop.

## Considerations

- Typed disk reads (`ok|missing|corrupt`) are load-bearing: `missing` last-run ⇒ run-now (intended first fire); `corrupt` last-run ⇒ skip (avoid duplicate/unintended fire); `corrupt` definition ⇒ skip (never treat as enabled). Operationally, corrupt files require manual repair.
- The manager talks to the server over HTTP (`SERVER_URL`) rather than in-process calls — it reuses the real message/session routes (busy/gone semantics come for free) but depends on the local server being reachable.
- The 30-min check granularity means actual fire time can lag `nextRun` by up to one interval; sub-hour cadence is forbidden anyway (`MIN_INTERVAL_MINUTES`).
- `POST /api/schedule/:slug/run` (manual trigger) does not check `enabled` — a disabled schedule can still be run manually.

## Risks and Mitigations

1. **Non-atomic writes** — `writeFile` without temp-rename; a crash mid-write can corrupt a file. Mitigated only downstream by the `corrupt` read path (skip, not crash). Not currently hardened.
2. **No slug validation** in schedule routes/store — slugs come straight from route params into `join(dir, slug)`. Path-traversal exposure is unaudited; document before relying on untrusted callers.
3. **Fixed 1 h busy defer** ignores the schedule's own cadence — a frequently-scheduled job whose session is busy silently drops to hourly retries until it succeeds.
4. **No timezone handling** — cron expressions evaluate in server-local time; DST and server-TZ changes shift fire times. No per-schedule TZ field exists.
5. **Applet/metadata mismatch** — `jobs` meta wording implies management, but the applet is read-only (no create/edit/delete/pause). Create/edit is API-only.

## HTTP surface

All under `/api` (`server.ts` → `src/routes/index.ts`).

- `GET /schedule` → `{schedules:[…]}` merged definition+last-run per slug.
- `GET /schedule/:slug` → merged record; 404 if missing.
- `PUT /schedule/:slug` → full create/replace. Body validated by exported `validateSchedulePutBody` (required `prompt`; `schedule` with type + expression/intervalMinutes; min-interval). Response `{slug, nextRun, created}`.
- `PATCH /schedule/:slug` → partial (currently `enabled` toggle); corrupt def/last-run ⇒ 409; enabling re-validates interval. Response `{slug, enabled, nextRun}`.
- `DELETE /schedule/:slug` → removes the dir; `{success:true}` or 404.
- `POST /schedule/:slug/run` → manual fire; 404/409 for missing/corrupt; success `{slug, status:'executed', sessionId}`.

Exported testable helper: `validateSchedulePutBody`.

## Applet (jobs)

`applets/jobs/` — bundled applet, opened at `/?applet=jobs`. `meta.json`: slug `jobs`, empty `params`, no `stateSchema`. On DOM-ready it `GET /api/schedule` and renders one card per schedule showing slug, enabled badge, last result, prompt, schedule type/expression, next/last run, sessionId, model, persistSession, lastError. States: loading / error / list / empty. Only action is `refreshJobs()` (a refresh button) — no mutation. Served user-dir-first then bundled (`src/applet-store.ts`) via `POST /api/applets/:slug/load`.

## Acceptance

- Observable: schedule created via `PUT`, appears in `GET /api/schedule` and the `jobs` applet with a computed `nextRun`; when due, a session receives a `[scheduler:<slug>]`-prefixed prompt and `last-run.json` records `success` + a new `nextRun`.
- Budgets: min cadence 60 min; check granularity 30 min. n/a otherwise.
- Gates: `npm test` (green; coverage thresholds enforced).
- Oracles (existing, in-tree):
  - `tests/unit/schedule-store.test.ts` — typed `ok|missing|corrupt` classification; min-interval validation.
  - `tests/unit/schedule-next-run.test.ts` — `calculateNextRun`: valid cron → future date; interval → exact minutes added; invalid/incomplete → throws.
  - `tests/unit/schedule-route-logic.test.ts` — exact `validateSchedulePutBody` messages; min-interval enforcement incl. too-frequent cron.

## Plan

This documents existing behavior; no implementation steps. Coverage/hardening opportunities (not scheduled work):

| # | Opportunity | Files | Oracle |
|---|-------------|-------|--------|
| 1 | Atomic writes (temp+rename) | `src/schedule-store.ts` | test: interrupted write leaves prior file intact |
| 2 | Slug validation on route params | `src/routes/schedule.ts` | test: traversal/invalid slug → 400, store untouched |
| 3 | Busy-defer respects cadence | `src/schedule-manager.ts` | test: 409 defers by `calculateNextRun`, not fixed 1 h |
| 4 | Per-schedule timezone for cron | `src/schedule-store.ts`, `src/schedule-manager.ts` | test: cron fires at TZ-local wall time |
