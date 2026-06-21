import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import type { DiskRead } from './disk-read.js';
import type { SessionEvent } from './types.js';

export type { SessionEvent };

export const STATE_DIR = join(homedir(), '.copilot', 'session-state');

function sessionPath(sessionId: string, file: string): string {
  return join(homedir(), '.copilot', 'session-state', sessionId, file);
}

export interface SessionWorkspace {
  updatedAt?: string;
  summary?: string;
  cwd?: string;
}

export function readSessionWorkspace(sessionId: string): SessionWorkspace | null {
  try {
    const yamlPath = sessionPath(sessionId, 'workspace.yaml');
    if (!existsSync(yamlPath)) return null;
    const parsed = parseYaml(readFileSync(yamlPath, 'utf8')) as Record<string, unknown>;
    return {
      updatedAt: typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Read a session's events.jsonl as a typed result that distinguishes an absent
 * file (`missing`) from one that exists but could not be read or parsed
 * (`corrupt`). The key invariant: a non-empty file whose every line is malformed
 * classifies as `corrupt`, NOT as an empty session — otherwise an all-garbage
 * events file would make a real session look empty and vanish from discovery.
 * A partial parse (some lines recovered) is still `ok`.
 */
export function readSessionEventsResult(sessionId: string): DiskRead<SessionEvent[]> {
  const eventsPath = sessionPath(sessionId, 'events.jsonl');
  if (!existsSync(eventsPath)) return { ok: false, kind: 'missing' };
  let content: string;
  try {
    content = readFileSync(eventsPath, 'utf-8');
  } catch (error) {
    return { ok: false, kind: 'corrupt', error: error instanceof Error ? error : new Error(String(error)) };
  }
  const events: SessionEvent[] = [];
  let totalNonEmptyLines = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    totalNonEmptyLines++;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  if (totalNonEmptyLines > 0 && events.length === 0) {
    return { ok: false, kind: 'corrupt', error: new Error('events.jsonl has no parseable lines') };
  }
  return { ok: true, value: events };
}

export function readSessionEvents(sessionId: string): SessionEvent[] {
  const result = readSessionEventsResult(sessionId);
  return result.ok ? result.value : [];
}

interface LastTurnsCacheEntry {
  size: number;
  mtimeMs: number;
  result: { events: SessionEvent[]; totalLines: number; skipped: number };
}
const lastTurnsCache = new Map<string, LastTurnsCacheEntry>();
const LAST_TURNS_CACHE_LIMIT = 32;

function findNthUserMessageFromEnd(lines: string[], n: number): number {
  let found = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"user.message"') && ++found >= n) return i;
  }
  return 0;
}

type LastTurns = { events: SessionEvent[]; totalLines: number; skipped: number };

export function readLastTurnsResult(sessionId: string, maxTurns: number, maxEvents: number): DiskRead<LastTurns> {
  const eventsPath = sessionPath(sessionId, 'events.jsonl');
  if (!existsSync(eventsPath)) return { ok: false, kind: 'missing' };

  let stat: ReturnType<typeof statSync>;
  let content: string;
  try {
    stat = statSync(eventsPath);
    const cacheKey = `${sessionId}\u0000${maxTurns}\u0000${maxEvents}`;
    const cached = lastTurnsCache.get(cacheKey);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { ok: true, value: cached.result };
    }
    content = readFileSync(eventsPath, 'utf-8');
  } catch (error) {
    return { ok: false, kind: 'corrupt', error: error instanceof Error ? error : new Error(String(error)) };
  }

  const lines = content.split('\n');
  const totalLines = lines.length;

  let turns = maxTurns;
  let startIndex = findNthUserMessageFromEnd(lines, turns);

  while (startIndex > 0 && (lines.length - startIndex) > maxEvents && turns > 3) {
    turns--;
    startIndex = findNthUserMessageFromEnd(lines, turns);
  }

  const events: SessionEvent[] = [];
  let totalNonEmptyLines = 0;
  for (let i = startIndex; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    totalNonEmptyLines++;
    try { events.push(JSON.parse(lines[i])); } catch { /* skip */ }
  }
  if (totalNonEmptyLines > 0 && events.length === 0) {
    return { ok: false, kind: 'corrupt', error: new Error('events.jsonl has no parseable lines') };
  }
  const result: LastTurns = { events, totalLines, skipped: startIndex };

  const cacheKey = `${sessionId}\u0000${maxTurns}\u0000${maxEvents}`;
  if (lastTurnsCache.size >= LAST_TURNS_CACHE_LIMIT) {
    const [oldest] = lastTurnsCache.keys();
    lastTurnsCache.delete(oldest);
  }
  lastTurnsCache.set(cacheKey, { size: stat.size, mtimeMs: stat.mtimeMs, result });

  return { ok: true, value: result };
}

export function readLastTurns(sessionId: string, maxTurns: number, maxEvents: number): LastTurns {
  const result = readLastTurnsResult(sessionId, maxTurns, maxEvents);
  return result.ok ? result.value : { events: [], totalLines: 0, skipped: 0 };
}

export function parseSessionModel(sessionId: string): string | null {
  const events = readSessionEvents(sessionId);
  let model: string | null = null;
  for (const event of events) {
    if (event.type === 'session.start' && event.data?.selectedModel) {
      model = String(event.data.selectedModel);
    } else if (event.type === 'session.model_change') {
      // SDK emits { previousModel, newModel }
      const newModel = (event.data as { newModel?: unknown })?.newModel ?? (event.data as { model?: unknown })?.model;
      if (newModel) model = String(newModel);
    }
  }
  return model;
}

export function listSessionIds(): string[] {
  try {
    const dir = join(homedir(), '.copilot', 'session-state');
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface SearchMatch {
  snippet: string;
  matchStart: number;
  matchEnd: number;
  eventType: string;
  timestamp?: string;
}

export function extractSnippet(text: string, query: string, contextChars = 40): { snippet: string; matchStart: number; matchEnd: number } | null {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + query.length + contextChars);
  const snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
  const matchStart = (start > 0 ? 3 : 0) + (idx - start);
  return { snippet, matchStart, matchEnd: matchStart + query.length };
}

export interface SearchResult {
  matches: SearchMatch[];
  totalMatches: number;
}

export function searchSessionEvents(sessionId: string, query: string, maxSnippets = 5): SearchResult {
  const eventsPath = sessionPath(sessionId, 'events.jsonl');
  if (!existsSync(eventsPath)) return { matches: [], totalMatches: 0 };

  const lowerQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];
  let totalMatches = 0;

  try {
    const content = readFileSync(eventsPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.includes('"user.message"') && !line.includes('"assistant.message"')) continue;

      try {
        const event = JSON.parse(line);
        const text = event.data?.content;
        if (typeof text !== 'string') continue;
        if (!text.toLowerCase().includes(lowerQuery)) continue;

        totalMatches++;
        if (matches.length < maxSnippets) {
          const result = extractSnippet(text, lowerQuery);
          if (result) {
            matches.push({
              snippet: result.snippet,
              matchStart: result.matchStart,
              matchEnd: result.matchEnd,
              eventType: event.type,
              timestamp: event.timestamp,
            });
          }
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file read error */ }

  return { matches, totalMatches };
}
