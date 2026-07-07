/**
 * Schedule API Routes
 * 
 * REST API for managing scheduled tasks
 */

import { Router, Request, Response } from 'express';
import {
  listSchedules,
  loadDefinition,
  loadDefinitionResult,
  loadLastRun,
  loadLastRunResult,
  saveDefinition,
  saveLastRun,
  deleteSchedule,
  scheduleExists,
  validateScheduleInterval,
  type ScheduleDefinition
} from '../schedule-store.js';
import { calculateNextRun, triggerSchedule } from '../schedule-manager.js';

const router = Router();

/** Pure validation for the PUT /schedule/:slug body. Returns an error message string
 *  (the exact text the route returns as a 400), or null when the body is valid.
 *  Combines the required-field shape checks with the min-interval rule
 *  (validateScheduleInterval), so the whole PUT contract is one testable unit. */
export function validateSchedulePutBody(body: {
  prompt?: string;
  schedule?: { type: 'cron' | 'interval'; expression?: string; intervalMinutes?: number };
}): string | null {
  if (!body.prompt) return 'prompt is required';
  const schedule = body.schedule;
  if (!schedule || (schedule.type === 'cron' && !schedule.expression) ||
      (schedule.type === 'interval' && !schedule.intervalMinutes)) {
    return 'schedule with type and expression/intervalMinutes is required';
  }
  return validateScheduleInterval(schedule);
}

/**
 * GET /api/schedule
 * List all schedules
 */
router.get('/schedule', async (req: Request, res: Response) => {
  try {
    const slugs = await listSchedules();
    const schedules = [];
    
    for (const slug of slugs) {
      const definition = await loadDefinition(slug);
      const lastRun = await loadLastRun(slug);
      
      if (definition) {
        schedules.push({
          slug: definition.slug,
          prompt: definition.prompt,
          enabled: definition.enabled,
          schedule: definition.schedule,
          sessionConfig: definition.sessionConfig,
          lastRun: lastRun?.lastRun || null,
          lastResult: lastRun?.lastResult || null,
          lastError: lastRun?.lastError || null,
          nextRun: lastRun?.nextRun || null,
          sessionId: lastRun?.sessionId || null,
          createdAt: definition.createdAt,
          updatedAt: definition.updatedAt
        });
      }
    }
    
    res.json({ schedules });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/schedule/:slug
 * Get specific schedule
 */
router.get('/schedule/:slug', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const definition = await loadDefinition(slug);
    
    if (!definition) {
      res.status(404).json({ error: `Schedule not found: ${slug}` });
      return;
    }
    
    const lastRun = await loadLastRun(slug);
    
    res.json({
      slug: definition.slug,
      prompt: definition.prompt,
      enabled: definition.enabled,
      schedule: definition.schedule,
      sessionConfig: definition.sessionConfig,
      lastRun: lastRun?.lastRun || null,
      lastResult: lastRun?.lastResult || null,
      lastError: lastRun?.lastError || null,
      nextRun: lastRun?.nextRun || null,
      sessionId: lastRun?.sessionId || null,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * PUT /api/schedule/:slug
 * Create or update schedule
 */
router.put('/schedule/:slug', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const { prompt, enabled, schedule, sessionConfig } = req.body as {
      prompt?: string;
      enabled?: boolean;
      schedule?: { type: 'cron' | 'interval'; expression?: string; intervalMinutes?: number };
      sessionConfig?: { model?: string; persistSession?: boolean };
    };
    
    // Validation
    const validationError = validateSchedulePutBody({ prompt, schedule });
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    
    const exists = await scheduleExists(slug);
    const now = new Date().toISOString();

    // PUT is an explicit full replace, so overwriting is allowed even if the
    // existing definition is corrupt — but we can only carry forward createdAt
    // if the old file was readable.
    let createdAt = now;
    if (exists) {
      const existingResult = await loadDefinitionResult(slug);
      if (existingResult.ok) {
        createdAt = existingResult.value.createdAt;
      } else if (existingResult.kind === 'corrupt') {
        console.warn(`[SCHEDULE] PUT ${slug}: existing definition.json is corrupt; replacing with a fresh createdAt`);
      }
    }

    const definition: ScheduleDefinition = {
      slug,
      prompt: prompt!,
      enabled: enabled !== false,
      schedule: schedule!,
      sessionConfig: {
        model: sessionConfig?.model,
        persistSession: sessionConfig?.persistSession !== false
      },
      createdAt,
      updatedAt: now
    };
    
    await saveDefinition(definition);
    
    // Initialize last-run if creating new
    if (!exists) {
      const nextRun = calculateNextRun(definition);
      await saveLastRun(slug, {
        lastRun: null,
        lastResult: null,
        lastError: null,
        sessionId: null,
        nextRun: nextRun.toISOString()
      });
    } else {
      // Update nextRun for existing schedule
      const lastRun = await loadLastRun(slug);
      if (lastRun) {
        const nextRun = calculateNextRun(definition);
        await saveLastRun(slug, {
          ...lastRun,
          nextRun: nextRun.toISOString()
        });
      }
    }
    
    const lastRun = await loadLastRun(slug);
    
    res.json({
      slug,
      nextRun: lastRun?.nextRun || null,
      created: !exists
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * PATCH /api/schedule/:slug
 * Partial update (toggle enabled, update prompt)
 */
router.patch('/schedule/:slug', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const { enabled } = req.body as { enabled?: boolean };
    
    const defResult = await loadDefinitionResult(slug);
    if (!defResult.ok) {
      if (defResult.kind === 'corrupt') {
        res.status(409).json({ error: `Schedule definition is corrupt; refusing partial update: ${slug}` });
      } else {
        res.status(404).json({ error: `Schedule not found: ${slug}` });
      }
      return;
    }
    const definition = defResult.value;

    // When re-enabling, a corrupt last-run.json makes the scheduler skip this
    // schedule, so reporting a successful enable would be misleading. Refuse
    // before persisting the definition.
    if (enabled) {
      const lrResult = await loadLastRunResult(slug);
      if (!lrResult.ok && lrResult.kind === 'corrupt') {
        res.status(409).json({ error: `Schedule last-run state is corrupt; cannot re-enable: ${slug}` });
        return;
      }
      const intervalError = validateScheduleInterval(definition.schedule);
      if (intervalError) {
        res.status(400).json({ error: `Cannot enable ${slug}: ${intervalError}` });
        return;
      }
    }

    // Apply partial updates
    if (enabled !== undefined) {
      definition.enabled = enabled;
    }
    
    definition.updatedAt = new Date().toISOString();
    await saveDefinition(definition);
    
    // Update nextRun if re-enabled
    if (enabled) {
      const lastRun = await loadLastRun(slug);
      if (lastRun) {
        const nextRun = calculateNextRun(definition);
        await saveLastRun(slug, {
          ...lastRun,
          nextRun: nextRun.toISOString()
        });
      }
    }
    
    const lastRun = await loadLastRun(slug);
    
    res.json({
      slug,
      enabled: definition.enabled,
      nextRun: lastRun?.nextRun || null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * DELETE /api/schedule/:slug
 * Delete schedule
 */
router.delete('/schedule/:slug', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const success = await deleteSchedule(slug);
    
    if (!success) {
      res.status(404).json({ error: `Schedule not found: ${slug}` });
      return;
    }
    
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/schedule/:slug/run
 * Manually trigger schedule
 */
router.post('/schedule/:slug/run', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    
    const defResult = await loadDefinitionResult(slug);
    if (!defResult.ok) {
      if (defResult.kind === 'corrupt') {
        res.status(409).json({ error: `Schedule definition is corrupt; refusing to run: ${slug}` });
      } else {
        res.status(404).json({ error: `Schedule not found: ${slug}` });
      }
      return;
    }

    // executeSchedule refuses (silently) to run a schedule whose last-run.json is
    // corrupt, so triggerSchedule would report success without running. Surface
    // it as a conflict instead of a false "executed".
    const lrResult = await loadLastRunResult(slug);
    if (!lrResult.ok && lrResult.kind === 'corrupt') {
      res.status(409).json({ error: `Schedule last-run state is corrupt; refusing to run: ${slug}` });
      return;
    }

    const result = await triggerSchedule(slug);
    
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    
    const lastRun = await loadLastRun(slug);
    
    res.json({
      slug,
      status: 'executed',
      sessionId: lastRun?.sessionId || null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

export { router };
