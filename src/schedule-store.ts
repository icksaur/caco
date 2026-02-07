/**
 * Schedule Store
 * 
 * Disk I/O for scheduled tasks.
 * Storage: ~/.caco/schedule/<slug>/definition.json + last-run.json
 */

import { mkdir, readFile, writeFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const SCHEDULE_DIR = join(homedir(), '.caco', 'schedule');

export interface ScheduleDefinition {
  slug: string;
  prompt: string;
  enabled: boolean;
  schedule: {
    type: 'cron' | 'interval';
    expression?: string;      // For cron: "0 9 * * 1-5"
    intervalMinutes?: number; // For interval: 60
  };
  sessionConfig: {
    model?: string;
    persistSession: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface LastRunState {
  lastRun: string | null;      // ISO timestamp
  lastResult: 'success' | 'error' | null;
  lastError: string | null;
  sessionId: string | null;
  nextRun: string;              // ISO timestamp
}

/**
 * Get schedule directory path
 */
function getScheduleDir(): string {
  return SCHEDULE_DIR;
}

/**
 * Get paths for a specific schedule
 */
function getSchedulePaths(slug: string): { root: string; definition: string; lastRun: string } {
  const root = join(getScheduleDir(), slug);
  return {
    root,
    definition: join(root, 'definition.json'),
    lastRun: join(root, 'last-run.json')
  };
}

/**
 * List all schedule slugs
 */
export async function listSchedules(): Promise<string[]> {
  try {
    if (!existsSync(getScheduleDir())) {
      return [];
    }
    
    const entries = await readdir(getScheduleDir(), { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Load schedule definition
 */
export async function loadDefinition(slug: string): Promise<ScheduleDefinition | null> {
  const paths = getSchedulePaths(slug);
  
  try {
    const content = await readFile(paths.definition, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save schedule definition
 */
export async function saveDefinition(definition: ScheduleDefinition): Promise<void> {
  const paths = getSchedulePaths(definition.slug);
  
  // Ensure directory exists
  await mkdir(paths.root, { recursive: true });
  
  // Write definition
  await writeFile(paths.definition, JSON.stringify(definition, null, 2), 'utf-8');
}

/**
 * Load last run state
 */
export async function loadLastRun(slug: string): Promise<LastRunState | null> {
  const paths = getSchedulePaths(slug);
  
  try {
    const content = await readFile(paths.lastRun, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save last run state
 */
export async function saveLastRun(slug: string, state: LastRunState): Promise<void> {
  const paths = getSchedulePaths(slug);
  
  // Ensure directory exists
  await mkdir(paths.root, { recursive: true });
  
  // Write state
  await writeFile(paths.lastRun, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Delete a schedule (both definition and last-run)
 */
export async function deleteSchedule(slug: string): Promise<boolean> {
  const paths = getSchedulePaths(slug);
  
  try {
    await rm(paths.root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if schedule exists
 */
export async function scheduleExists(slug: string): Promise<boolean> {
  const paths = getSchedulePaths(slug);
  return existsSync(paths.definition);
}

/**
 * Get schedule info for a session (if session was created by a schedule)
 * Returns the schedule slug and next run time, or null if not scheduled
 */
export async function getScheduleForSession(sessionId: string): Promise<{
  slug: string;
  nextRun: string | null;
} | null> {
  const slugs = await listSchedules();
  
  for (const slug of slugs) {
    const lastRun = await loadLastRun(slug);
    if (lastRun?.sessionId === sessionId) {
      return {
        slug,
        nextRun: lastRun.nextRun || null
      };
    }
  }
  
  return null;
}
