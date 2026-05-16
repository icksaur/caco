/**
 * Per-session JSON data blobs.
 *
 * Generic key→object storage under ~/.caco/sessions/<sessionId>/<name>.json.
 * Used by roadmap, surface, and any future per-session document. The name
 * is validated against a safe character set; `meta` and the notes files
 * are reserved (they have their own dedicated stores).
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getSessionDir, ensureDir } from './storage-paths.js';

const RESERVED_NAMES = new Set(['meta']);
const SAFE_DATA_NAME = /^[a-zA-Z0-9_-]+$/;
const RESERVED_FILES = new Set(['meta.json', 'notes.json', 'notes-archive.json']);

export function isValidDataName(name: string): boolean {
  return SAFE_DATA_NAME.test(name) && !RESERVED_NAMES.has(name);
}

export function listSessionData(sessionId: string): string[] {
  const dir = getSessionDir(sessionId);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json') && !RESERVED_FILES.has(f))
      .map(f => f.replace('.json', ''));
  } catch { return []; }
}

export function getSessionData(sessionId: string, name: string): Record<string, unknown> | null {
  if (!isValidDataName(name)) return null;
  const filePath = join(getSessionDir(sessionId), `${name}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

export function setSessionData(sessionId: string, name: string, data: Record<string, unknown>): boolean {
  if (!isValidDataName(name)) return false;
  const dir = getSessionDir(sessionId);
  ensureDir(dir);
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2));
  return true;
}

export function deleteSessionData(sessionId: string, name: string): boolean {
  if (!isValidDataName(name)) return false;
  const filePath = join(getSessionDir(sessionId), `${name}.json`);
  if (!existsSync(filePath)) return false;
  try { unlinkSync(filePath); return true; } catch { return false; }
}
