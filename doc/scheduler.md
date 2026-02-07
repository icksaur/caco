# Scheduler Design

**Goal:** Run scheduled agent sessions at specific times/cadences without user interaction.

---

## Success Criteria

1. **Reliable scheduling** - Tasks run at specified times (±5 minutes acceptable)
2. **Persistence** - Schedules survive server restarts
3. **Single execution** - No parallel scheduled sessions (prevent conflicts)
4. **Overdue handling** - Run missed tasks on startup, but only once
5. **Session reuse** - Scheduled tasks maintain persistent sessions (don't create new ones each time)
6. **Status visibility** - API provides schedule state (next run, last run, enabled/disabled)
7. **Graceful errors** - Failed scheduled tasks log errors but don't crash scheduler

---

## Data Model

**Storage:** `~/.caco/schedule/<slug>/`

```
~/.caco/schedule/
  ├── daily-standup/
  │   ├── definition.json    # Configuration
  │   └── last-run.json       # Runtime state
  └── nightly-backup/
      ├── definition.json
      └── last-run.json
```

### definition.json
```json
{
  "slug": "daily-standup",
  "prompt": "Generate daily standup summary from git commits",
  "enabled": true,
  "schedule": {
    "type": "cron",           // "cron" | "interval"
    "expression": "0 9 * * 1-5"  // 9 AM weekdays (cron format)
    // OR for intervals:
    // "intervalMinutes": 60
  },
  "sessionConfig": {
    "model": "claude-sonnet",
    "persistSession": true     // Reuse session between runs
  },
  "createdAt": "2026-01-29T...",
  "updatedAt": "2026-01-29T..."
}
```

### last-run.json
```json
{
  "lastRun": "2026-01-29T09:00:15.123Z",
  "lastResult": "success",    // "success" | "error"
  "lastError": null,           // Error message if failed
  "sessionId": "abc-123",      // Persistent session (if enabled)
  "nextRun": "2026-01-30T09:00:00.000Z"  // Calculated
}
```

---

## Architecture

### Components

**1. ScheduleManager (`src/schedule-manager.ts`)**
- Loads all schedules from disk on startup
- Maintains in-memory schedule list
- Checks every 30 minutes for due tasks
- Enforces single-execution (no parallel runs)
- Updates `last-run.json` after each execution

**2. ScheduleExecutor**
- Reuses existing `POST /api/sessions/:id/messages` endpoint
- Simple: POST prompt to sessionId from `last-run.json`
- If session busy (409 conflict): delay task 1 hour, try again
- If session not found (404): POST to new session, update sessionId
- Execution is async - don't wait for completion

**3. Schedule API (`src/routes/schedule.ts`)**
- `GET /api/schedule` - List all schedules
- `GET /api/schedule/:slug` - Get specific schedule
- `PUT /api/schedule/:slug` - Create/update schedule (full replacement)
- `PATCH /api/schedule/:slug` - Partial update (toggle enabled)
- `DELETE /api/schedule/:slug` - Delete schedule
- `POST /api/schedule/:slug/run` - Run immediately (manual trigger)

---

## Scheduling Logic

### Check Interval: 30 minutes

Every 30 minutes:
1. Load current time
2. For each enabled schedule:
   - Calculate next run time based on schedule type
   - If `nextRun <= now`, add to execution queue
3. Execute queue serially (one at a time)
4. Update `last-run.json` and `nextRun` after each

### Startup Behavior

On server start:
1. Load all schedules from disk
2. Check for overdue tasks (`nextRun < now`)
3. Run overdue tasks immediately (in order, serially)
4. Start 30-minute check interval

### Cron Parsing

Use standard cron format: `minute hour day month day-of-week`

Examples:
- `0 9 * * 1-5` - 9 AM weekdays
- `0 */2 * * *` - Every 2 hours
- `30 14 * * 0` - 2:30 PM Sundays

**Library:** Use `node-cron` or `cron-parser` for parsing/validation

---

## Session Management

### Persistent Sessions (Default)

```typescript
{
  "sessionConfig": {
    "persistSession": true  // Keep session alive between runs
  }
}
```

- First run: Create new session, store `sessionId`
- Subsequent runs: Reuse existing session via `resumeSession()`
- Session persists in SDK cache at `~/.caco/sessions/<id>/`
- Benefits: Context retained, faster startup

### Ephemeral Sessions

```typescript
{
  "sessionConfig": {
    "persistSession": false  // Create new session each time
  }
}
```

- Each run: Create session, run prompt, clean up
- No session stored in `last-run.json`
- Use case: Tasks that need fresh context

---

## Error Handling

### Expected Execution Errors

**1. Session Busy (409 Conflict)**
```json
{
  "lastRun": "2026-01-29T09:00:15.123Z",
  "lastResult": "error",
  "lastError": "Session busy - agent currently running",
  "sessionId": "abc-123",
  "nextRun": "2026-01-29T10:00:00.000Z"  // Delayed 1 hour
}
```

**Recovery:**
- Session is mid-conversation (user or another schedule)
- Delay task by 1 hour (set new `nextRun`)
- Keep existing `sessionId`
- Retry at next run time

**2. Session Not Found (404)**
```json
{
  "lastRun": "2026-01-29T09:00:15.123Z",
  "lastResult": "success",
  "lastError": null,
  "sessionId": "new-xyz-456",  // New session created
  "nextRun": "2026-01-30T09:00:00.000Z"
}
```

**Recovery:**
- Old session was deleted or expired
- Create new session by POSTing without sessionId
- Store new `sessionId` in `last-run.json`
- Continue normally

**3. Network/Server Errors (500)**
```json
{
  "lastRun": "2026-01-29T09:00:15.123Z",
  "lastResult": "error",
  "lastError": "HTTP 500: Internal Server Error",
  "sessionId": "abc-123",
  "nextRun": "2026-01-29T09:30:00.000Z"  // Retry on next interval (30 min)
}
```

**Recovery:**
- Transient error (server restart, SDK issue)
- Log error with `[SCHEDULER]` prefix
- Keep existing `sessionId`
- Retry on next check interval (30 minutes)

### Execution Flow

```typescript
async function executeSchedule(slug: string): Promise<void> {
  const definition = await loadDefinition(slug);
  const lastRun = await loadLastRun(slug);
  
  try {
    // Try to POST to existing session
    if (lastRun.sessionId) {
      const response = await fetch(`/api/sessions/${lastRun.sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: definition.prompt,
          source: 'scheduler'
        })
      });
      
      if (response.status === 409) {
        // Session busy - delay 1 hour
        await saveLastRun(slug, {
          lastRun: new Date().toISOString(),
          lastResult: 'error',
          lastError: 'Session busy',
          sessionId: lastRun.sessionId,
          nextRun: new Date(Date.now() + 60 * 60 * 1000).toISOString()
        });
        return;
      }
      
      if (response.status === 404) {
        // Session not found - create new one
        const createResponse = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: process.cwd(), model: definition.sessionConfig.model })
        });
        const { sessionId: newSessionId } = await createResponse.json();
        
        // Now POST to new session
        await fetch(`/api/sessions/${newSessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: definition.prompt, source: 'scheduler' })
        });
        
        // Save new sessionId
        await saveLastRun(slug, {
          lastRun: new Date().toISOString(),
          lastResult: 'success',
          lastError: null,
          sessionId: newSessionId,
          nextRun: calculateNextRun(definition.schedule)
        });
        return;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } else {
      // No session yet - create one
      const createResponse = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: process.cwd(), model: definition.sessionConfig.model })
      });
      const { sessionId } = await createResponse.json();
      
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: definition.prompt, source: 'scheduler' })
      });
      
      await saveLastRun(slug, {
        lastRun: new Date().toISOString(),
        lastResult: 'success',
        lastError: null,
        sessionId,
        nextRun: calculateNextRun(definition.schedule)
      });
      return;
    }
    
    // Success
    await saveLastRun(slug, {
      lastRun: new Date().toISOString(),
      lastResult: 'success',
      lastError: null,
      sessionId: lastRun.sessionId,
      nextRun: calculateNextRun(definition.schedule)
    });
    
  } catch (error) {
    // Network/server error - retry on next interval
    await saveLastRun(slug, {
      lastRun: new Date().toISOString(),
      lastResult: 'error',
      lastError: error.message,
      sessionId: lastRun.sessionId,
      nextRun: calculateNextRun(definition.schedule)
    });
  }
}
```

### Scheduler Crashes

- Schedules persisted on disk survive restart
- Overdue tasks run on startup
- No duplicate runs (lastRun timestamp prevents)

---

## API Design

### GET /api/schedule

**Response:**
```json
{
  "schedules": [
    {
      "slug": "daily-standup",
      "prompt": "Generate standup...",
      "enabled": true,
      "schedule": { "type": "cron", "expression": "0 9 * * 1-5" },
      "lastRun": "2026-01-29T09:00:15.123Z",
      "lastResult": "success",
      "nextRun": "2026-01-30T09:00:00.000Z",
      "sessionId": "abc-123"
    }
  ]
}
```

### PUT /api/schedule/:slug

**Request:**
```json
{
  "prompt": "Generate daily standup summary",
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

**Response:**
```json
{
  "slug": "daily-standup",
  "nextRun": "2026-01-30T09:00:00.000Z",
  "created": true
}
```

### PATCH /api/schedule/:slug

Toggle enabled state or partial update.

**Request:**
```json
{
  "enabled": false
}
```

**Response:**
```json
{
  "slug": "daily-standup",
  "enabled": false,
  "nextRun": "2026-01-30T09:00:00.000Z"
}
```

### POST /api/schedule/:slug/run

Run schedule immediately (bypass timing).

**Response:**
```json
{
  "slug": "daily-standup",
  "status": "running",
  "sessionId": "abc-123"
}
```

---

## Considerations

### 1. SDK Session Limits

- SDK may have max session count
- Persistent sessions accumulate over time
- **Solution:** Add "max sessions" config, auto-cleanup oldest

### 2. Concurrent Schedule Execution

- Avoid parallel runs (resource conflicts, quota limits)
- **Solution:** Execution queue with serial processing

### 3. Long-Running Tasks

- 30-minute check interval may find multiple overdue tasks
- **Solution:** Queue all, execute serially, don't re-queue if still running

### 4. Clock Skew / Time Zones

- Server restart may change time zone
- **Solution:** Store all times in UTC, calculate nextRun on read

### 5. Schedule Updates While Running

- User updates schedule during execution
- **Solution:** Complete current run, reload from disk after

### 6. Missed Runs (Server Down)

- Server offline for 24 hours, misses multiple runs
- **Solution:** Run once on startup (not backfill all missed)

---

## Implementation Plan

### Phase 1: Core Scheduler
1. Create `src/schedule-manager.ts` with interval checker
2. Create `src/schedule-store.ts` for disk I/O
3. Load schedules on startup
4. Execute overdue tasks (single test schedule)

### Phase 2: Session Management
1. Add persistent session logic
2. Handle session not found errors
3. Test session reuse across runs

### Phase 3: API
1. Create `src/routes/schedule.ts`
2. Implement CRUD endpoints
3. Add manual run trigger

### Phase 4: Cron Parsing
1. Add `node-cron` or `cron-parser` dependency
2. Calculate nextRun from cron expression
3. Validate expressions on schedule create

### Phase 5: Testing
1. Unit tests for schedule calculation
2. Integration tests for execution
3. Test overdue handling on startup

---

## Testing Strategy

### Unit Tests

```typescript
describe('ScheduleManager', () => {
  test('calculates next run from cron expression', () => {
    const next = calculateNextRun('0 9 * * 1-5', new Date('2026-01-29T10:00:00Z'));
    expect(next).toEqual(new Date('2026-01-30T09:00:00Z')); // Next weekday 9 AM
  });
  
  test('identifies overdue schedules', () => {
    const schedule = { nextRun: '2026-01-29T08:00:00Z', enabled: true };
    expect(isOverdue(schedule, new Date('2026-01-29T10:00:00Z'))).toBe(true);
  });
  
  test('does not run disabled schedules', () => {
    const schedule = { nextRun: '2026-01-29T08:00:00Z', enabled: false };
    expect(isOverdue(schedule, new Date('2026-01-29T10:00:00Z'))).toBe(false);
  });
});
```

### Integration Tests

```typescript
describe('Schedule Execution', () => {
  test('creates new session for first run', async () => {
    await scheduleManager.executeSchedule('test-schedule');
    const state = await loadLastRun('test-schedule');
    expect(state.sessionId).toBeDefined();
  });
  
  test('reuses session for subsequent runs', async () => {
    const firstRun = await scheduleManager.executeSchedule('test-schedule');
    const secondRun = await scheduleManager.executeSchedule('test-schedule');
    expect(firstRun.sessionId).toEqual(secondRun.sessionId);
  });
});
```

---

## Future Enhancements

1. **Web UI** - Schedule management dashboard
2. **Notifications** - Slack/email on task completion
3. **Task Dependencies** - Schedule B runs after Schedule A completes
4. **Rate Limiting** - Max runs per hour/day
5. **Execution History** - Last 10 runs with results
6. **Health Checks** - Alert if schedule fails N times in a row
7. **Variable Prompts** - Template variables like `{{date}}`, `{{lastRun}}`
8. **Timeout** - Kill task if running >30 minutes

---

## Summary

**Minimal viable implementation:**
- Persistent schedules in `~/.caco/schedule/`
- 30-minute check interval
- Serial execution (no parallel)
- Session reuse for persistent tasks
- REST API for CRUD
- Cron expression support

**Benefits:**
- Zero external dependencies (no cron daemon)
- Survives restarts (disk-backed)
- Simple API (JSON files + REST)
- Testable (no time-based dependencies in tests)
