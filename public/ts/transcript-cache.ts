/**
 * Transcript MRU cache
 *
 * Caches a recently-loaded session's rendered history event array so a
 * switch-back can re-render locally instead of re-streaming history over the
 * WebSocket. Reuse is gated by a freshness token (the server's events.jsonl
 * {size, mtimeMs}, from /resume) plus the WS connection id — so a session that
 * changed (append, rotation, repair) or a reconnect deterministically falls back
 * to a full re-stream. Bounded MRU (N=3); plain event-array data, not DOM.
 *
 * LIFECYCLE: entries are written on a clean idle historyComplete and pruned on
 * onSessionArchived (wired in initMessageStreaming) and by the MRU cap.
 */

import type { SessionEvent } from './types.js';

/** Mirror of the server's events.jsonl version (src/sdk-session-store.ts). */
export interface EventVersion {
  size: number;
  mtimeMs: number;
}

export interface TranscriptCacheEntry {
  events: SessionEvent[];
  version: EventVersion;
  connectionId: number;
}

const MAX_ENTRIES = 3;
const cache = new Map<string, TranscriptCacheEntry>();

export function versionsEqual(
  a: EventVersion | null | undefined,
  b: EventVersion | null | undefined,
): boolean {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Read an entry, marking it most-recently-used. */
export function getCachedTranscript(sessionId: string): TranscriptCacheEntry | undefined {
  const entry = cache.get(sessionId);
  if (entry) {
    cache.delete(sessionId);
    cache.set(sessionId, entry);
  }
  return entry;
}

export function putCachedTranscript(sessionId: string, entry: TranscriptCacheEntry): void {
  cache.delete(sessionId);
  cache.set(sessionId, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function dropCachedTranscript(sessionId: string): void {
  cache.delete(sessionId);
}

/** Test seam. */
export function clearTranscriptCache(): void {
  cache.clear();
}
