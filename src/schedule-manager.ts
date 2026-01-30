/**
 * Schedule Manager
 * 
 * Manages scheduled task execution.
 * - Loads schedules on startup
 * - Checks every 30 minutes for due tasks
 * - Executes tasks serially (no parallel runs)
 */

import parser from 'cron-parser';
import { 
  listSchedules, 
  loadDefinition, 
  loadLastRun, 
  saveLastRun,
  type ScheduleDefinition,
  type LastRunState
} from './schedule-store.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const BUSY_DELAY_MS = 60 * 60 * 1000;     // 1 hour

let checkTimer: NodeJS.Timeout | null = null;
let isExecuting = false;

/**
 * Start the schedule manager
 */
export function startScheduleManager(): void {
  console.log('[SCHEDULER] Starting schedule manager');
  
  // Run initial check for overdue tasks
  checkSchedules().catch(err => {
    console.error('[SCHEDULER] Error in initial check:', err);
  });
  
  // Set up periodic check
  checkTimer = setInterval(() => {
    checkSchedules().catch(err => {
      console.error('[SCHEDULER] Error in periodic check:', err);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the schedule manager
 */
export function stopScheduleManager(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  console.log('[SCHEDULER] Stopped schedule manager');
}

/**
 * Check all schedules and execute due tasks
 */
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
      const definition = await loadDefinition(slug);
      if (!definition || !definition.enabled) {
        continue;
      }
      
      const lastRun = await loadLastRun(slug);
      const nextRun = lastRun?.nextRun ? new Date(lastRun.nextRun) : now;
      
      if (nextRun <= now) {
        dueTasks.push(slug);
      }
    }
    
    if (dueTasks.length > 0) {
      console.log(`[SCHEDULER] Found ${dueTasks.length} due tasks: ${dueTasks.join(', ')}`);
      
      // Execute serially
      for (const slug of dueTasks) {
        await executeSchedule(slug);
      }
    }
  } finally {
    isExecuting = false;
  }
}

/**
 * Execute a scheduled task
 */
async function executeSchedule(slug: string): Promise<void> {
  console.log(`[SCHEDULER] Executing: ${slug}`);
  
  const definition = await loadDefinition(slug);
  if (!definition) {
    console.error(`[SCHEDULER] Definition not found for: ${slug}`);
    return;
  }
  
  const lastRun = await loadLastRun(slug);
  
  try {
    // Try to POST to existing session
    if (lastRun?.sessionId) {
      const response = await fetch(`http://localhost:3000/api/sessions/${lastRun.sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: definition.prompt,
          source: 'scheduler'
        })
      });
      
      if (response.status === 409) {
        // Session busy - delay 1 hour
        console.log(`[SCHEDULER] Session busy for ${slug}, delaying 1 hour`);
        await saveLastRun(slug, {
          lastRun: new Date().toISOString(),
          lastResult: 'error',
          lastError: 'Session busy',
          sessionId: lastRun.sessionId,
          nextRun: new Date(Date.now() + BUSY_DELAY_MS).toISOString()
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
      
      // Success with existing session
      await saveLastRun(slug, {
        lastRun: new Date().toISOString(),
        lastResult: 'success',
        lastError: null,
        sessionId: lastRun.sessionId,
        nextRun: calculateNextRun(definition).toISOString()
      });
      console.log(`[SCHEDULER] Executed ${slug} successfully`);
      return;
    }
    
    // No session yet - create one
    await createAndExecute(slug, definition);
    
  } catch (error) {
    // Network/server error - retry on next interval
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

/**
 * Create new session and execute
 */
async function createAndExecute(slug: string, definition: ScheduleDefinition): Promise<void> {
  // Create session
  const createResponse = await fetch('http://localhost:3000/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      cwd: process.cwd(), 
      model: definition.sessionConfig.model || 'claude-sonnet' 
    })
  });
  
  if (!createResponse.ok) {
    throw new Error(`Failed to create session: HTTP ${createResponse.status}`);
  }
  
  const { sessionId } = await createResponse.json();
  console.log(`[SCHEDULER] Created session ${sessionId} for ${slug}`);
  
  // POST message
  const messageResponse = await fetch(`http://localhost:3000/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      prompt: definition.prompt,
      source: 'scheduler'
    })
  });
  
  if (!messageResponse.ok) {
    throw new Error(`Failed to send message: HTTP ${messageResponse.status}`);
  }
  
  // Save state
  await saveLastRun(slug, {
    lastRun: new Date().toISOString(),
    lastResult: 'success',
    lastError: null,
    sessionId: definition.sessionConfig.persistSession ? sessionId : null,
    nextRun: calculateNextRun(definition).toISOString()
  });
  
  console.log(`[SCHEDULER] Executed ${slug} successfully with new session`);
}

/**
 * Calculate next run time based on schedule
 */
export function calculateNextRun(definition: ScheduleDefinition, from?: Date): Date {
  const now = from || new Date();
  
  if (definition.schedule.type === 'cron' && definition.schedule.expression) {
    try {
      const interval = parser.parseExpression(definition.schedule.expression, { currentDate: now });
      return interval.next().toDate();
    } catch (error) {
      console.error(`[SCHEDULER] Invalid cron expression for ${definition.slug}:`, error);
      // Fallback to 1 hour
      return new Date(now.getTime() + 60 * 60 * 1000);
    }
  }
  
  if (definition.schedule.type === 'interval' && definition.schedule.intervalMinutes) {
    return new Date(now.getTime() + definition.schedule.intervalMinutes * 60 * 1000);
  }
  
  // Default: 1 hour
  return new Date(now.getTime() + 60 * 60 * 1000);
}

/**
 * Manually trigger a schedule
 */
export async function triggerSchedule(slug: string): Promise<{ success: boolean; error?: string }> {
  try {
    await executeSchedule(slug);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
