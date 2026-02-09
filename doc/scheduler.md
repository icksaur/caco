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
- Checks every 30 minutes for due tasks
- Enforces single-execution (no parallel runs)
- Runs overdue tasks on startup (once each)

**ScheduleExecutor**
- Reuses `POST /api/sessions/:id/messages` endpoint
- If session busy (409): delay 1 hour
- If session not found (404): create new session
- Execution is async — don't wait for completion

### Session Management

**Persistent** (default): First run creates session, subsequent runs reuse via `resumeSession()`. Context retained.

**Ephemeral**: Fresh session each run. Use for tasks needing clean context.

### Error Handling

| Error | Recovery |
|-------|----------|
| Session busy (409) | Delay 1 hour, retry |
| Session not found (404) | Create new session, update sessionId |
| Network/server error (500) | Log error, retry on next 30-min interval |

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
2. **Concurrent execution** — Serial queue prevents resource conflicts
3. **Long-running tasks** — Don't re-queue if still running
4. **Time zones** — All times stored in UTC
5. **Updates while running** — Complete current run, reload definition after
6. **Missed runs** — Run once on startup, don't backfill all missed
