import { CronExpressionParser } from 'cron-parser';
import {
  listSchedules, 
  loadDefinitionResult, 
  loadLastRunResult, 
  saveLastRun,
  validateScheduleInterval,
  type LastRunState,
  type ScheduleDefinition
} from './schedule-store.js';
import { SERVER_URL, SCHEDULE_CHECK_INTERVAL_MS, SCHEDULE_BUSY_DELAY_MS, SCHEDULE_TURN_TIMEOUT_MS } from './config.js';
import { onTurnOutcome, type TurnOutcome } from './turn-outcome.js';

let checkTimer: NodeJS.Timeout | null = null;
let isExecuting = false;
let unsubscribeOutcome: (() => void) | null = null;

/**
 * Runs whose prompt was POSTed, keyed by the session running the turn. A run is
 * `running` in last-run.json from accept until its turn really ends; the turn
 * outcome (spec-session-wake, turn-outcome.ts) then writes the result. An
 * outcome that lands before the accept is written is held in `early`.
 */
interface PendingRun { slug: string; accepted: boolean; early?: { outcome: TurnOutcome; reason?: string } }
const pendingRuns = new Map<string, PendingRun>();

function pendingForSlug(slug: string): string | undefined {
  for (const [sessionId, run] of pendingRuns) if (run.slug === slug) return sessionId;
  return undefined;
}

async function recordOutcome(slug: string, outcome: TurnOutcome, reason?: string): Promise<void> {
  const r = await loadLastRunResult(slug);
  if (!r.ok || r.value.lastResult !== 'running') return;
  await saveLastRun(slug, {
    ...r.value,
    lastResult: outcome === 'ok' ? 'success' : outcome === 'cancelled' ? 'cancelled' : 'error',
    lastError: outcome === 'error' ? (reason ?? 'error') : null,
  });
  console.log(`[SCHEDULER] ${slug} finished: ${outcome}`);
}

/** Turn-outcome listener: settles the slug run (if any) on this session. */
export function settleScheduleRun(sessionId: string, outcome: TurnOutcome, reason?: string): void {
  const run = pendingRuns.get(sessionId);
  if (!run) return;
  if (!run.accepted) { run.early ??= { outcome, reason }; return; }
  pendingRuns.delete(sessionId);
  recordOutcome(run.slug, outcome, reason).catch(err => {
    console.error(`[SCHEDULER] Failed to record outcome for ${run.slug}:`, err instanceof Error ? err.name : typeof err);
  });
}

async function markAccepted(runSessionId: string, slug: string, state: Omit<LastRunState, 'lastResult' | 'lastError'>): Promise<void> {
  await saveLastRun(slug, { ...state, lastResult: 'running', lastError: null });
  const run = pendingRuns.get(runSessionId);
  if (!run) return;
  run.accepted = true;
  if (run.early) {
    pendingRuns.delete(runSessionId);
    await recordOutcome(slug, run.early.outcome, run.early.reason);
  }
}

export function startScheduleManager(): void {
  console.log('[SCHEDULER] Starting schedule manager');
  if (!unsubscribeOutcome) unsubscribeOutcome = onTurnOutcome(settleScheduleRun);
  
  checkSchedules().catch(err => {
    console.error('[SCHEDULER] Error in initial check:', err);
  });
  
  checkTimer = setInterval(() => {
    checkSchedules().catch(err => {
      console.error('[SCHEDULER] Error in periodic check:', err);
    });
  }, SCHEDULE_CHECK_INTERVAL_MS);
}

export function stopScheduleManager(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  unsubscribeOutcome?.();
  unsubscribeOutcome = null;
  pendingRuns.clear();
  console.log('[SCHEDULER] Stopped schedule manager');
}

async function checkSchedules(): Promise<void> {
  if (isExecuting) {
    console.log('[SCHEDULER] Already executing, skipping check');
    return;
  }
  
  try {
    isExecuting = true;
    const now = new Date();
    console.log(`[SCHEDULER] Checking schedules at ${now.toISOString()}`);
    
    const slugs = await listSchedules();
    const dueTasks: string[] = [];
    
    for (const slug of slugs) {
      const defResult = await loadDefinitionResult(slug);
      if (!defResult.ok) {
        if (defResult.kind === 'corrupt') {
          console.error(`[SCHEDULER] Skipping ${slug}: definition.json is corrupt (${defResult.error.message}); not treating as enabled`);
        }
        continue;
      }
      const definition = defResult.value;
      if (!definition.enabled) {
        continue;
      }

      const intervalError = validateScheduleInterval(definition.schedule);
      if (intervalError) {
        console.warn(`[SCHEDULER] Skipping ${slug}: ${intervalError}`);
        continue;
      }

      const lastRunResult = await loadLastRunResult(slug);
      // Corrupt last-run must NOT default to nextRun=now — that would trigger an
      // unintended immediate run. Skip this tick instead.
      if (!lastRunResult.ok && lastRunResult.kind === 'corrupt') {
        console.error(`[SCHEDULER] Skipping ${slug}: last-run.json is corrupt (${lastRunResult.error.message}); not defaulting to run-now`);
        continue;
      }
      const lastRun = lastRunResult.ok ? lastRunResult.value : null;
      if (lastRun?.lastResult === 'running') {
        const runSessionId = pendingForSlug(slug);
        const startedAt = lastRun.lastRun ? Date.parse(lastRun.lastRun) : 0;
        if (runSessionId && now.getTime() - startedAt <= SCHEDULE_TURN_TIMEOUT_MS) {
          // Still in its turn: wait for the outcome rather than POST into a 409.
          continue;
        }
        if (runSessionId) pendingRuns.delete(runSessionId);
        lastRun.lastResult = 'error';
        lastRun.lastError = runSessionId ? 'no idle within timeout' : 'interrupted by restart';
        await saveLastRun(slug, lastRun);
      }
      const nextRun = lastRun?.nextRun ? new Date(lastRun.nextRun) : now;

      if (nextRun <= now) {
        dueTasks.push(slug);
      }
    }
    
    if (dueTasks.length > 0) {
      console.log(`[SCHEDULER] Found ${dueTasks.length} due tasks: ${dueTasks.join(', ')}`);
      
      for (const slug of dueTasks) {
        try {
          await executeSchedule(slug);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[SCHEDULER] Unhandled error executing ${slug}; continuing with remaining tasks:`, message);
        }
      }
    }
  } finally {
    isExecuting = false;
  }
}

async function executeSchedule(slug: string): Promise<void> {
  console.log(`[SCHEDULER] Executing: ${slug}`);
  
  const defResult = await loadDefinitionResult(slug);
  if (!defResult.ok) {
    if (defResult.kind === 'corrupt') {
      console.error(`[SCHEDULER] Not executing ${slug}: definition.json is corrupt (${defResult.error.message})`);
    } else {
      console.error(`[SCHEDULER] Definition not found for: ${slug}`);
    }
    return;
  }
  const definition = defResult.value;

  const lastRunResult = await loadLastRunResult(slug);
  if (!lastRunResult.ok && lastRunResult.kind === 'corrupt') {
    console.error(`[SCHEDULER] Not executing ${slug}: last-run.json is corrupt (${lastRunResult.error.message}); refusing to spawn a duplicate session`);
    return;
  }
  const lastRun = lastRunResult.ok ? lastRunResult.value : null;
  
  try {
    // Try to POST to existing session
    if (lastRun?.sessionId) {
      const runSessionId = lastRun.sessionId;
      if (pendingRuns.has(runSessionId)) {
        // A run on this session is still in its turn (e.g. "Run now" clicked mid-run).
        console.log(`[SCHEDULER] ${slug} is already running; not starting another`);
        return;
      }
      pendingRuns.set(runSessionId, { slug, accepted: false });
      let response: Response;
      try {
        response = await fetch(`${SERVER_URL}/api/sessions/${runSessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            prompt: definition.prompt,
            source: 'scheduler',
            scheduleSlug: slug
          })
        });
      } catch (err) {
        pendingRuns.delete(runSessionId);
        throw err;
      }
      if (!response.ok) pendingRuns.delete(runSessionId);
      
      if (response.status === 409) {
        // Session busy - delay 1 hour
        console.log(`[SCHEDULER] Session busy for ${slug}, delaying 1 hour`);
        await saveLastRun(slug, {
          lastRun: new Date().toISOString(),
          lastResult: 'error',
          lastError: 'Session busy',
          sessionId: lastRun.sessionId,
          nextRun: new Date(Date.now() + SCHEDULE_BUSY_DELAY_MS).toISOString()
        });
        return;
      }
      
      if (response.status === 404) {
        // Session not found - create new one
        console.log(`[SCHEDULER] Session not found for ${slug}, creating new session`);
        await createAndExecute(slug, definition);
        return;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      await markAccepted(runSessionId, slug, {
        lastRun: new Date().toISOString(),
        sessionId: runSessionId,
        nextRun: calculateNextRun(definition).toISOString()
      });
      console.log(`[SCHEDULER] Started ${slug}; the result is recorded when the turn ends`);
      return;
    }
    
    // No session yet - create one
    await createAndExecute(slug, definition);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[SCHEDULER] Error executing ${slug}:`, errorMessage);
    
    await saveLastRun(slug, {
      lastRun: new Date().toISOString(),
      lastResult: 'error',
      lastError: errorMessage,
      sessionId: lastRun?.sessionId || null,
      nextRun: calculateNextRun(definition).toISOString()
    });
  }
}

async function createAndExecute(slug: string, definition: ScheduleDefinition): Promise<void> {
  const createResponse = await fetch(`${SERVER_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      cwd: process.cwd(), 
      model: definition.sessionConfig.model || 'claude-sonnet',
      description: slug,
      kind: 'scheduled'
    })
  });
  
  if (!createResponse.ok) {
    throw new Error(`Failed to create session: HTTP ${createResponse.status}`);
  }
  
  const { sessionId } = await createResponse.json();
  console.log(`[SCHEDULER] Created session ${sessionId} for ${slug}`);
  
  pendingRuns.set(sessionId, { slug, accepted: false });
  let messageResponse: Response;
  try {
    messageResponse = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        prompt: definition.prompt,
        source: 'scheduler',
        scheduleSlug: slug
      })
    });
  } catch (err) {
    pendingRuns.delete(sessionId);
    throw err;
  }
  
  if (!messageResponse.ok) {
    pendingRuns.delete(sessionId);
    throw new Error(`Failed to send message: HTTP ${messageResponse.status}`);
  }
  
  await markAccepted(sessionId, slug, {
    lastRun: new Date().toISOString(),
    sessionId: definition.sessionConfig.persistSession ? sessionId : null,
    nextRun: calculateNextRun(definition).toISOString()
  });
  
  console.log(`[SCHEDULER] Started ${slug} in a new session; the result is recorded when the turn ends`);
}

export function calculateNextRun(definition: ScheduleDefinition, from?: Date): Date {
  const now = from || new Date();

  if (definition.schedule.type === 'cron' && definition.schedule.expression) {
    const interval = CronExpressionParser.parse(definition.schedule.expression, { currentDate: now });
    return interval.next().toDate();
  }

  if (definition.schedule.type === 'interval' && definition.schedule.intervalMinutes) {
    return new Date(now.getTime() + definition.schedule.intervalMinutes * 60 * 1000);
  }

  throw new Error(
    `Cannot compute next run for ${definition.slug}: invalid ${definition.schedule.type} schedule ` +
    `(${JSON.stringify(definition.schedule)})`
  );
}

export async function triggerSchedule(slug: string): Promise<{ success: boolean; error?: string }> {
  try {
    await executeSchedule(slug);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
