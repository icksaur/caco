/**
 * Schedule API Routes
 * 
 * REST API for managing scheduled tasks
 */

import { Router, Request, Response } from 'express';
import {
  listSchedules,
  loadDefinition,
  loadLastRun,
  saveDefinition,
  saveLastRun,
  deleteSchedule,
  scheduleExists,
  type ScheduleDefinition
} from '../schedule-store.js';
import { calculateNextRun, triggerSchedule } from '../schedule-manager.js';

const router = Router();

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
    if (!prompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    
    if (!schedule || (schedule.type === 'cron' && !schedule.expression) || 
        (schedule.type === 'interval' && !schedule.intervalMinutes)) {
      res.status(400).json({ error: 'schedule with type and expression/intervalMinutes is required' });
      return;
    }
    
    const exists = await scheduleExists(slug);
    const now = new Date().toISOString();
    
    const definition: ScheduleDefinition = {
      slug,
      prompt,
      enabled: enabled !== false,
      schedule,
      sessionConfig: {
        model: sessionConfig?.model,
        persistSession: sessionConfig?.persistSession !== false
      },
      createdAt: exists ? (await loadDefinition(slug))!.createdAt : now,
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
    
    const definition = await loadDefinition(slug);
    if (!definition) {
      res.status(404).json({ error: `Schedule not found: ${slug}` });
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

export default router;
