import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { getSessionNotes, getSessionRoadmap } from './storage.js';

export const STATE_DIR = join(homedir(), '.copilot', 'session-state');

function sessionPath(sessionId: string, file: string): string {
  return join(homedir(), '.copilot', 'session-state', sessionId, file);
}

export interface SessionWorkspace {
  updatedAt?: string;
  summary?: string;
  cwd?: string;
}

export interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
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

export function readSessionEvents(sessionId: string): SessionEvent[] {
  try {
    const eventsPath = sessionPath(sessionId, 'events.jsonl');
    if (!existsSync(eventsPath)) return [];
    const content = readFileSync(eventsPath, 'utf-8');
    const events: SessionEvent[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return events;
  } catch {
    return [];
  }
}

export function readLastTurns(sessionId: string, maxTurns: number, maxEvents: number): { events: SessionEvent[]; totalLines: number; skipped: number } {
  try {
    const eventsPath = sessionPath(sessionId, 'events.jsonl');
    if (!existsSync(eventsPath)) return { events: [], totalLines: 0, skipped: 0 };
    const content = readFileSync(eventsPath, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    let startIndex = 0;
    let turns = maxTurns;
    let turnsFound = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('"user.message"')) {
        turnsFound++;
        if (turnsFound >= turns) { startIndex = i; break; }
      }
    }

    while (startIndex > 0 && (lines.length - startIndex) > maxEvents && turns > 3) {
      turns--;
      turnsFound = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('"user.message"')) {
          turnsFound++;
          if (turnsFound >= turns) { startIndex = i; break; }
        }
      }
    }

    const events: SessionEvent[] = [];
    for (let i = startIndex; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try { events.push(JSON.parse(lines[i])); } catch { /* skip */ }
    }
    return { events, totalLines, skipped: startIndex };
  } catch {
    return { events: [], totalLines: 0, skipped: 0 };
  }
}

export function parseSessionModel(sessionId: string): string | null {
  const events = readSessionEvents(sessionId);
  let model: string | null = null;
  for (const event of events) {
    if (event.type === 'session.start' && event.data?.selectedModel) {
      model = String(event.data.selectedModel);
    } else if (event.type === 'session.model_change' && event.data?.model) {
      model = String(event.data.model);
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

export function searchSessionNotes(sessionId: string, query: string, maxSnippets = 3): SearchResult {
  const notes = getSessionNotes(sessionId);
  if (!notes.length) return { matches: [], totalMatches: 0 };

  const lowerQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];
  let totalMatches = 0;

  for (const note of notes) {
    if (!note.text.toLowerCase().includes(lowerQuery)) continue;
    totalMatches++;
    if (matches.length < maxSnippets) {
      const result = extractSnippet(note.text, lowerQuery);
      if (result) {
        matches.push({
          snippet: result.snippet,
          matchStart: result.matchStart,
          matchEnd: result.matchEnd,
          eventType: 'note',
          timestamp: new Date(note.ts).toISOString(),
        });
      }
    }
  }
  return { matches, totalMatches };
}

export function searchSessionRoadmap(sessionId: string, query: string, maxSnippets = 3): SearchResult {
  const roadmap = getSessionRoadmap(sessionId);
  if (!roadmap) return { matches: [], totalMatches: 0 };

  const lowerQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];
  let totalMatches = 0;

  // Search title
  if (roadmap.title?.toLowerCase().includes(lowerQuery)) {
    totalMatches++;
    if (matches.length < maxSnippets) {
      const result = extractSnippet(roadmap.title, lowerQuery);
      if (result) matches.push({ ...result, eventType: 'roadmap' });
    }
  }

  // Search steps: title, description, context
  for (const step of roadmap.steps) {
    for (const text of [step.title, step.description, ...(step.context || [])]) {
      if (!text || !text.toLowerCase().includes(lowerQuery)) continue;
      totalMatches++;
      if (matches.length < maxSnippets) {
        const result = extractSnippet(text, lowerQuery);
        if (result) matches.push({ ...result, eventType: 'roadmap' });
      }
    }
  }

  // Search documents
  for (const doc of roadmap.documents || []) {
    if (!doc.toLowerCase().includes(lowerQuery)) continue;
    totalMatches++;
    if (matches.length < maxSnippets) {
      const result = extractSnippet(doc, lowerQuery);
      if (result) matches.push({ ...result, eventType: 'roadmap' });
    }
  }

  return { matches, totalMatches };
}
