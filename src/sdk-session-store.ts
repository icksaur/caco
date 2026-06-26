import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
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

/** A cheap, faithful version of a session's history: the `events.jsonl` file's
 *  byte size and mtime. It changes on every append, and — crucially — on every
 *  rewrite the SDK/server can't broadcast (history rotation front-truncates the
 *  file, repair rewrites it). The transcript cache compares this between a cached
 *  load and a later `/resume` to decide whether a re-render is safe or the history
 *  must be re-streamed. Returns null when the session has no events file yet. */
export interface EventVersion {
  size: number;
  mtimeMs: number;
}

export function getEventVersion(sessionId: string): EventVersion | null {
  const eventsPath = sessionPath(sessionId, 'events.jsonl');
  try {
    const st = statSync(eventsPath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
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

// Node cannot materialize a single string larger than ~512MB (0x1fffffe8).
// A long-lived session's events.jsonl can exceed that, which made a whole-file
// readFileSync(path,'utf-8') throw and the history read report "corrupt". For
// files past tailReadBytes() we read only the tail (more than enough for the
// last few turns) and count total lines with a bounded streaming scan, so memory
// and the string-length cap are never hit. Default is well under the 512MB ceiling.
function tailReadBytes(): number {
  const v = Number(process.env.CACO_TAIL_READ_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 64 * 1024 * 1024;
}

/** Count lines (newline count + 1, mirroring split('\n').length) without ever
 *  holding the file in memory — fixed-size buffer scan, safe at any file size. */
function countFileLines(path: string): number {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let newlines = 0;
    let bytesRead: number;
    while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 0x0a) newlines++;
    }
    return newlines + 1;
  } finally {
    closeSync(fd);
  }
}

/** Read the last `maxBytes` of a file as a string, dropping the partial first
 *  line when the window starts mid-file (so the result is whole lines and any
 *  UTF-8 char split at the window boundary is discarded). */
function readTailString(path: string, size: number, maxBytes: number): string {
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    let off = 0;
    while (off < length) {
      const n = readSync(fd, buf, off, length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    let text = buf.toString('utf-8', 0, off);
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

export function readLastTurnsResult(sessionId: string, maxTurns: number, maxEvents: number): DiskRead<LastTurns> {
  const eventsPath = sessionPath(sessionId, 'events.jsonl');
  if (!existsSync(eventsPath)) return { ok: false, kind: 'missing' };

  let stat: ReturnType<typeof statSync>;
  let content: string;
  let totalLines: number;
  try {
    stat = statSync(eventsPath);
    const cacheKey = `${sessionId}\u0000${maxTurns}\u0000${maxEvents}`;
    const cached = lastTurnsCache.get(cacheKey);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { ok: true, value: cached.result };
    }
    if (stat.size <= tailReadBytes()) {
      content = readFileSync(eventsPath, 'utf-8');
      totalLines = -1; // derive from the full split below (whole file in hand)
    } else {
      // Too big for one JS string: tail-read the recent events, count the rest.
      content = readTailString(eventsPath, stat.size, tailReadBytes());
      totalLines = countFileLines(eventsPath);
    }
  } catch (error) {
    return { ok: false, kind: 'corrupt', error: error instanceof Error ? error : new Error(String(error)) };
  }

  const lines = content.split('\n');
  if (totalLines < 0) totalLines = lines.length;

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
  // skipped = everything not in the shown slice. For the whole-file path this
  // equals startIndex (original semantics); for the tail path it also counts the
  // lines before the read window.
  const shownLines = lines.length - startIndex;
  const skipped = Math.max(0, totalLines - shownLines);
  const result: LastTurns = { events, totalLines, skipped };

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
  const eventsPath = sessionPath(sessionId, 'events.jsonl');
  if (!existsSync(eventsPath)) return null;
  let content: string;
  try {
    content = readFileSync(eventsPath, 'utf-8');
  } catch {
    return null;
  }
  // The model is only ever set by a session.start (selectedModel) or a
  // session.model_change (newModel); last write wins. A cheap substring guard
  // lets us skip JSON.parse on the (potentially hundreds of thousands of) other
  // event lines — the bulk of cold-open prework cost on large sessions. The
  // full file is still scanned because the last model_change can be anywhere.
  let model: string | null = null;
  for (const line of content.split('\n')) {
    const isStart = line.includes('"session.start"');
    const isChange = !isStart && line.includes('"session.model_change"');
    if (!isStart && !isChange) continue;
    let event: SessionEvent;
    try { event = JSON.parse(line); } catch { continue; }
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
  const archivePath = sessionPath(sessionId, 'events-archive.jsonl');

  const lowerQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];
  let totalMatches = 0;

  // Scan the archived (rotated-out) history and the live tail. Note rotation
  // retains user.message events in the live file while archiving their
  // surrounding assistant/tool events, so a pre-cut user message reads after its
  // archived assistant reply — search is for recall, not strict transcript order.
  for (const path of [archivePath, eventsPath]) {
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, 'utf-8');
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
  }

  return { matches, totalMatches };
}
