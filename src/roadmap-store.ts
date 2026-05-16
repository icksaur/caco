/**
 * Per-session roadmap and notes store.
 *
 * Roadmap is a single document at ~/.caco/sessions/<id>/roadmap.json.
 * Notes are NDJSON (one JSON object per line) at notes.json with archived
 * entries spilling into notes-archive.json. Both survive context compaction.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { getSessionDir, ensureDir } from './storage-paths.js';
import { getSessionData, setSessionData } from './session-data-store.js';

export interface RoadmapStep {
  title: string;
  description?: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  context?: string[];
}

export interface Roadmap {
  title: string;
  documents?: string[];
  steps: RoadmapStep[];
}

export function getSessionRoadmap(sessionId: string): Roadmap | null {
  return getSessionData(sessionId, 'roadmap') as Roadmap | null;
}

export function setSessionRoadmap(sessionId: string, roadmap: Roadmap): void {
  setSessionData(sessionId, 'roadmap', roadmap as unknown as Record<string, unknown>);
}

export interface NoteEntry {
  ts: number;
  text: string;
}

function notesPath(sessionId: string): string {
  return join(getSessionDir(sessionId), 'notes.json');
}

function archivePath(sessionId: string): string {
  return join(getSessionDir(sessionId), 'notes-archive.json');
}

function readNdjson(filePath: string): NoteEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as NoteEntry);
  } catch { return []; }
}

export function getSessionNotes(sessionId: string): NoteEntry[] {
  return readNdjson(notesPath(sessionId));
}

export function appendSessionNote(sessionId: string, text: string): NoteEntry {
  const dir = getSessionDir(sessionId);
  ensureDir(dir);
  const entry: NoteEntry = { ts: Date.now(), text };
  appendFileSync(notesPath(sessionId), JSON.stringify(entry) + '\n');
  return entry;
}

export function archiveSessionNote(sessionId: string, ts: number): boolean {
  const notes = getSessionNotes(sessionId);
  const idx = notes.findIndex(n => n.ts === ts);
  if (idx < 0) return false;
  const [removed] = notes.splice(idx, 1);
  const dir = getSessionDir(sessionId);
  ensureDir(dir);
  appendFileSync(archivePath(sessionId), JSON.stringify(removed) + '\n');
  writeFileSync(notesPath(sessionId), notes.map(n => JSON.stringify(n)).join('\n') + (notes.length ? '\n' : ''));
  return true;
}
