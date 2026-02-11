# Scheduler Design

**Goal:** Run scheduled agent sessions at specific times/cadences without user interaction.

---

## Success Criteria

1. **Reliable scheduling** — Tasks run at specified times (±5 minutes acceptable)
2. **Persistence** — Schedules survive server restarts
3. **Single execution** — No parallel scheduled sessions
4. **Overdue handling** — Run missed tasks on startup, but only once
5. **Session reuse** — Scheduled tasks maintain persistent sessions
6. **Status visibility** — API provides schedule state (next run, last run, enabled/disabled)
7. **Graceful errors** — Failed tasks log errors but don't crash scheduler

---

## Data Model

**Storage:** `~/.caco/schedule/<slug>/`

```
~/.caco/schedule/
  └── daily-standup/
      ├── definition.json    # Configuration
      └── last-run.json      # Runtime state
```

### definition.json
```json
{
  "slug": "daily-standup",
  "prompt": "Generate daily standup summary from git commits",
  "enabled": true,
  "schedule": {
    "type": "cron",
    "expression": "0 9 * * 1-5"
  },
  "sessionConfig": {
    "model": "claude-sonnet",
    "persistSession": true
  }
}
```

### last-run.json
```json
{
  "lastRun": "2026-01-29T09:00:15.123Z",
  "lastResult": "success",
  "lastError": null,
  "sessionId": "abc-123",
  "nextRun": "2026-01-30T09:00:00.000Z"
}
```

---

## Architecture

### Components

**ScheduleManager** (`src/schedule-manager.ts`)
- Loads schedules from disk on startup
- Runs initial check immediately on startup (catches up overdue tasks)
- Checks every 30 minutes thereafter for due tasks
- Enforces single-execution via `isExecuting` flag (no parallel schedule checks)
- Serial execution: due tasks run one at a time within each check

**ScheduleStore** (`src/schedule-store.ts`)
- CRUD operations for `definition.json` and `last-run.json`
- Storage path: `~/.caco/schedule/<slug>/`

### Startup Behavior

On server start (`startScheduleManager()`):
1. Immediately calls `checkSchedules()` (async, non-blocking)
2. Sets 30-minute interval for future checks
3. Each overdue task executes once (no backfill of missed runs)

A task is "due" when `nextRun <= now`. If server was offline for 3 days, each enabled schedule runs once on startup.

### Execution Flow

```
checkSchedules()
  → for each schedule:
      if nextRun <= now → add to dueTasks
  → for each dueTask (serial):
      executeSchedule(slug)
        → POST /api/sessions/:id/messages
        → update last-run.json with result
```

### Session Management

**Persistent** (default): First run creates session, subsequent runs reuse via `resumeSession()`. Context retained.

**Ephemeral**: Fresh session each run. Use for tasks needing clean context.

### HTTP Response Handling

The scheduler relies on HTTP status codes from the messages endpoint:

| Status | Meaning | Scheduler Action |
|--------|---------|------------------|
| 200 | Message accepted | Record success, calculate next run |
| 404 | Session not found | Create new session, retry |
| 409 | Session busy | Record error, delay 1 hour |
| 500 | Resume/dispatch failed | Record error, retry on next interval |

**Important:** HTTP 200 means the message was accepted and session resumed, but dispatch to the LLM happens asynchronously. The scheduler cannot confirm the LLM actually processed the message.

### Error Handling

| Error | Recovery |
|-------|----------|
| Session busy (409) | Delay 1 hour, retry |
| Session not found (404) | Create new session, update sessionId |
| Resume failed (500) | Log error, retry on next 30-min interval |
| Network error | Log error, retry on next 30-min interval |

---

## Throttling

### Single Execution

The scheduler enforces single execution via:

1. **Global lock (`isExecuting`)** — Only one `checkSchedules()` runs at a time. If a check takes longer than 30 minutes, the next interval is skipped.

2. **Serial task execution** — Within a check, due tasks run one at a time (await in for loop). No parallel job execution.

3. **Session busy (409)** — If a session is already processing, the scheduler delays 1 hour rather than queueing.

### Minimum Interval

**Schedules cannot run more frequently than once per hour.**

This is enforced at two points:

1. **Creation time (PUT /api/schedule/:slug):** Returns HTTP 400 if interval < 60 minutes
2. **Execution time (checkSchedules):** Skips schedules that violate the limit (catches manual edits)

For interval schedules: `intervalMinutes >= 60` required.
For cron schedules: Next two run times must be ≥60 minutes apart.

Attempting to create a more frequent schedule returns HTTP 400:
```json
{ "error": "Minimum interval is 60 minutes (1 hour)" }
```

### Why 1 Hour Minimum?

- Prevents runaway API costs from misconfigured schedules
- Allows time for LLM responses to complete
- Simple, predictable limit vs. complex rate limiting

---

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/schedule` | GET | List all schedules with status |
| `/api/schedule/:slug` | GET | Get specific schedule |
| `/api/schedule/:slug` | PUT | Create/update schedule |
| `/api/schedule/:slug` | PATCH | Partial update (toggle enabled) |
| `/api/schedule/:slug` | DELETE | Delete schedule |
| `/api/schedule/:slug/run` | POST | Run immediately (manual trigger) |

---

## Considerations

1. **SDK session limits** — Persistent sessions accumulate; may need max-sessions config
2. **Long-running tasks** — Don't re-queue if still running
3. **Time zones** — All times stored in UTC
4. **Updates while running** — Complete current run, reload definition after
5. **Missed runs** — Run once on startup, don't backfill all missed

---

## Known Limitations

**No end-to-end confirmation:** The scheduler records "success" when HTTP 200 is returned, but the LLM dispatch happens asynchronously. If the dispatch fails after HTTP 200 (e.g., network error to LLM, context window exceeded), the scheduler still shows success.

**No retry for async failures:** Errors during the actual LLM conversation (tool failures, timeouts) are not reported back to the scheduler. Check the session history for actual execution results.

**Session history is source of truth:** To verify a scheduled task actually ran, check `~/.copilot/session-state/<sessionId>/events.jsonl` for `user.message` events with the scheduler prefix.

---

## Diagnostics

### Check Schedule State

```bash
# View schedule definition
cat ~/.caco/schedule/<slug>/definition.json

# View last run state
cat ~/.caco/schedule/<slug>/last-run.json
```

### Check Session History

```bash
# Find session ID from schedule
jq -r .sessionId ~/.caco/schedule/<slug>/last-run.json

# View recent events (did the message actually send?)
tail -20 ~/.copilot/session-state/<sessionId>/events.jsonl

# Look for scheduler messages
grep 'scheduler:' ~/.copilot/session-state/<sessionId>/events.jsonl | tail -5
```

### Check Server Logs

```bash
# Scheduler activity
grep SCHEDULER server.log | tail -20

# Specific schedule
grep 'zalem-daily-stats' server.log | tail -10
```

### Force a Test Run

```bash
# Set nextRun to the past
cat > ~/.caco/schedule/<slug>/last-run.json << EOF
{
  "lastRun": "2026-01-01T00:00:00.000Z",
  "lastResult": "success", 
  "lastError": null,
  "sessionId": "<existing-session-id>",
  "nextRun": "2026-01-01T00:00:00.000Z"
}
EOF

# Restart server to trigger overdue check
./stop.sh && ./start.sh

# Watch for execution
grep SCHEDULER server.log | tail -5
```

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "success" but no message in history | Async dispatch failed silently | Check session events.jsonl directly |
| Schedule not running | `enabled: false` in definition | PATCH to enable |
| Wrong nextRun time | Cron expression issue | Validate at crontab.guru |
| Session busy (409) every run | Previous run still active | Check if session is stuck |
