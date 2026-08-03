import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { StringDecoder } from 'string_decoder';
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
 *
 * NOT exported: this loads the whole history, so it must not be reachable as a
 * casual default. Callers that need the front of a session use
 * `readSessionHeadResult` (bounded); the one caller that genuinely needs every
 * event is `readSessionEvents`, which renders history.
 */
function readSessionEventsResult(sessionId: string): DiskRead<SessionEvent[]> {  const eventsPath = sessionPath(sessionId, 'events.jsonl');
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

/**
 * What callers who only care about the FRONT of a session's history can learn
 * without reading the history.
 *
 * Discovery needs the `session.start` line (for cwd) and auto-resume needs to
 * know whether anything follows it — between them that is two lines, but both
 * used to load the whole file to get them. `start` is the first parseable event
 * (exactly the old `events[0]`); `hasMore` is `events.length > 1`.
 */
export interface SessionHead {
  start: SessionEvent | null;
  hasMore: boolean;
}

/**
 * Bytes read from the front of events.jsonl to answer head questions. Measured
 * across every session on disk, the `session.start` line is 220-670 bytes, so
 * this window is ~100x the largest real first line and always spans the first
 * two events. It is a PERFORMANCE bound, never a correctness one: a window that
 * cannot answer conclusively falls back to the full read.
 */
function headReadBytes(): number {
  const v = Number(process.env.CACO_HEAD_READ_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 64 * 1024;
}

/** Read up to `maxBytes` from the front of a file. `reachedEof` is decided by
 *  the read itself rather than by a prior `stat`: discovery runs while other
 *  sessions may be appending, and a stale size would let appended bytes go
 *  unread while still claiming the whole file was seen. */
function readHeadString(path: string, maxBytes: number): { text: string; reachedEof: boolean } {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    let off = 0;
    while (off < maxBytes) {
      const n = readSync(fd, buf, off, maxBytes - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { text: buf.toString('utf-8', 0, off), reachedEof: off < maxBytes };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a session's first events from a bounded window at the front of the file,
 * with the same `missing` / `corrupt` / `ok` classification as
 * `readSessionEventsResult` — a real session must never be dropped from
 * discovery because its history failed to read.
 *
 * Every real session is answered from the window, so startup cost is bounded by
 * the session COUNT rather than by total history size. The equivalence is by
 * construction rather than by assumption: whenever the window cannot decide
 * (no parseable line yet, or only one, and the file continues past the window)
 * this defers to the full read, so the result is always what reading the whole
 * file would have produced.
 */
export function readSessionHeadResult(sessionId: string): DiskRead<SessionHead> {
  const eventsPath = sessionPath(sessionId, 'events.jsonl');
  if (!existsSync(eventsPath)) return { ok: false, kind: 'missing' };

  const window = headReadBytes();
  let text: string;
  let reachedEof: boolean;
  try {
    ({ text, reachedEof } = readHeadString(eventsPath, window));
  } catch (error) {
    return { ok: false, kind: 'corrupt', error: error instanceof Error ? error : new Error(String(error)) };
  }

  const lines = text.split('\n');
  // Mid-file the window almost certainly cuts a line in half; a truncated line
  // must not be judged malformed, so drop it and let the fallback decide.
  if (!reachedEof) lines.pop();

  let start: SessionEvent | null = null;
  let hasMore = false;
  let nonEmptyLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    nonEmptyLines++;
    let event: SessionEvent;
    try { event = JSON.parse(line); } catch { continue; }
    if (start === null) start = event;
    else { hasMore = true; break; }
  }

  // Conclusive: a second event settles hasMore, and EOF settles its absence.
  if (start !== null && (hasMore || reachedEof)) return { ok: true, value: { start, hasMore } };
  if (start === null && reachedEof) {
    return nonEmptyLines > 0
      ? { ok: false, kind: 'corrupt', error: new Error('events.jsonl has no parseable lines') }
      : { ok: true, value: { start: null, hasMore: false } };
  }

  // Inconclusive (only reachable when the front of a file is unparseable or a
  // single line exceeds the window): answer exactly as the full read would.
  const full = readSessionEventsResult(sessionId);
  if (!full.ok) return full;
  return { ok: true, value: { start: full.value[0] ?? null, hasMore: full.value.length > 1 } };
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

/**
 * Threshold past which `forEachFileLine` stops accumulating a line and discards
 * it. This is what makes memory bounded for ANY file shape — without it, a file
 * containing no newlines would grow the carry buffer until it hit the very
 * string cap this streaming is meant to avoid. It bounds the RETAINED carry, so
 * a line emitted just as the threshold is crossed can be up to one chunk longer;
 * peak memory is constant either way. Three orders of magnitude above any real
 * event line.
 */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

/**
 * Feed every line of a file to `onLine` without ever holding the file in memory:
 * a fixed-size read buffer plus a capped carry, so peak memory is constant at
 * any file size — including past Node's ~512 MiB string cap. Return `false` from
 * `onLine` to stop early.
 *
 * `StringDecoder` carries a multi-byte character split across a chunk boundary
 * into the next chunk, so decoding chunk-by-chunk is exact rather than
 * approximately right.
 */
function forEachFileLine(path: string, onLine: (line: string) => boolean | void): void {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let discardingOverlongLine = false;
    let bytesRead: number;
    while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
      let text = decoder.write(buf.subarray(0, bytesRead));
      if (discardingOverlongLine) {
        const nl = text.indexOf('\n');
        if (nl < 0) continue; // still inside the over-long line
        discardingOverlongLine = false;
        text = text.slice(nl + 1);
      }
      const lines = (carry + text).split('\n');
      // The last element is either a partial line or '' — hold it for the next
      // chunk rather than emitting a line the file does not contain.
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (onLine(line) === false) return;
      }
      if (carry.length > MAX_LINE_CHARS) {
        carry = '';
        discardingOverlongLine = true;
      }
    }
    if (!discardingOverlongLine) {
      carry += decoder.end();
      if (carry) onLine(carry);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * The session's current model, or null when the events log records none.
 *
 * The model is only ever set by a `session.start` (selectedModel) or a
 * `session.model_change` (newModel); last write wins. A cheap substring guard
 * skips `JSON.parse` on the (potentially hundreds of thousands of) other event
 * lines. Every line is still visited, because the last model_change can be
 * anywhere in the file — but the file is streamed rather than materialized, so
 * memory is constant and the ~512 MiB string cap is never hit.
 *
 * That cap was not a theoretical limit here: `defaultPreserveModel` calls this
 * to persist the model to meta BEFORE rotation front-truncates the events that
 * record it, and rotation is what happens to exactly the sessions large enough
 * to trip the cap. A read failure there returns null and rotation proceeds, so
 * the model would be lost permanently.
 */
export function parseSessionModel(sessionId: string): string | null {
  const eventsPath = sessionPath(sessionId, 'events.jsonl');
  if (!existsSync(eventsPath)) return null;
  let model: string | null = null;
  try {
    forEachFileLine(eventsPath, line => {
      const isStart = line.includes('"session.start"');
      const isChange = !isStart && line.includes('"session.model_change"');
      if (!isStart && !isChange) return;
      let event: SessionEvent;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'session.start' && event.data?.selectedModel) {
        model = String(event.data.selectedModel);
      } else if (event.type === 'session.model_change') {
        // SDK emits { previousModel, newModel }
        const newModel = (event.data as { newModel?: unknown })?.newModel ?? (event.data as { model?: unknown })?.model;
        if (newModel) model = String(newModel);
      }
    });
  } catch {
    return null;
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
