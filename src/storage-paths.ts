/**
 * Caco storage paths and shared helpers.
 *
 * Single source of truth for the Caco data root and the per-session directory
 * layout under it. All domain stores (session-meta, roadmap, output, peers, mcp-auth)
 * derive their paths from these helpers.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Caco data root (~/.caco). Override with CACO_HOME env var (used by some tests). */
export const STORAGE_ROOT = process.env.CACO_HOME || join(homedir(), '.caco');

export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/** ~/.caco/sessions/<sessionId> */
export function getSessionDir(sessionId: string): string {
  return join(STORAGE_ROOT, 'sessions', sessionId);
}

/** ~/.caco/sessions/<sessionId>/outputs */
export function getSessionOutputDir(sessionId: string): string {
  return join(getSessionDir(sessionId), 'outputs');
}
