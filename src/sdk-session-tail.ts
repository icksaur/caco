/**
 * Bounded, asynchronous tail reader for a session's `events.jsonl`
 * (spec-session-overview, Last-event context). Read only: it never rotates,
 * repairs or resumes anything and never calls the SDK. One `open` + `fstat`
 * on the same handle, so the size and identity belong to the file actually
 * read even if a history rotation renames a new file into place meanwhile.
 *
 * Excerpts may carry private text: they are returned to the caller only and
 * are never logged here.
 */

import { promises as fsp } from 'fs';
import { join } from 'path';
import { STATE_DIR } from './sdk-session-store.js';
import { parseMessageSource, type MessageSource } from './message-source.js';

export const TAIL_DEFAULT_MAX_BYTES = 256 * 1024;
export const TAIL_DEFAULT_CONCURRENCY = 4;
export const TAIL_DEFAULT_DEADLINE_MS = 3000;
export const USER_TEXT_MAX = 300;
export const ASSISTANT_TEXT_MAX = 600;
export const ERROR_TEXT_MAX = 200;
/** The ask heuristic looks at this many trailing characters (after fences are removed). */
export const ASK_TAIL_CHARS = 400;

export interface LastContext {
  status: 'ok' | 'unavailable' | 'skipped-deadline' | 'no-events';
  /** The fs error code when `status` is `unavailable` (e.g. EBUSY, ENOENT). */
  errorCode?: string;
  /** false = the window held no user.message. */
  windowCoversTurn?: boolean;
  lastUser?: { at: string; source: MessageSource; text: string };
  lastAssistant?: { at: string; text: string };
  lastError?: { at: string; text: string };
  lastEventType?: string;
  lastEventAt?: string;
}

export type AskVerdict =
  | { matched: string }
  | { matched: null }
  | { unavailable: 'oversized' | 'truncated-start' };

export interface TailResult {
  context: LastContext;
  ask: AskVerdict;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Fixed phrase list for the ask heuristic (case-insensitive). */
export const ASK_PHRASES: readonly string[] = [
  'let me know', 'should i', 'want me to', 'would you like', 'do you want', 'shall i',
  'which option', 'please confirm', 'your call', 'waiting for you', 'need you to',
];
const CAN_YOU_RE = /can you (check|confirm|run|send|approve)/i;
/** A trailing `?`, allowing closing quotes, brackets or markdown emphasis after it. */
const TRAILING_QUESTION_RE = /\?["')\]*_`]*$/;

/** Remove fenced code blocks with their contents. An unclosed fence removes
 *  everything to the end. A fence closes only with the same character and at
 *  least the opening length (CommonMark). */
export function stripFences(text: string): string {
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (m) { fence = { ch: m[1][0], len: m[1].length }; continue; }
    out.push(line);
  }
  return out.join('\n');
}

/** The ask heuristic on a COMPLETE assistant message (before clipping). */
export function detectAsk(text: string): { matched: string } | { matched: null } {
  const tail = stripFences(text).trimEnd().slice(-ASK_TAIL_CHARS);
  if (!tail) return { matched: null };
  if (TRAILING_QUESTION_RE.test(tail)) return { matched: '?' };
  const lower = tail.toLowerCase();
  for (const p of ASK_PHRASES) if (lower.includes(p)) return { matched: p };
  const m = CAN_YOU_RE.exec(tail);
  return m ? { matched: m[0].toLowerCase() } : { matched: null };
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Keep the start; a trailing `...` marks the cut. */
export function clipHead(s: string, max: number): string {
  const c = collapse(s);
  return c.length <= max ? c : `${c.slice(0, max - 3)}...`;
}

/** Keep the END (a request to the user is usually the last thing said); a
 *  leading `...` marks the cut. */
export function clipTail(s: string, max: number): string {
  const c = collapse(s);
  return c.length <= max ? c : `...${c.slice(c.length - (max - 3))}`;
}

/** Redact error text before clipping: URLs reduced to scheme and host,
 *  bearer tokens, key/token/secret assignments, JWTs and long opaque tokens
 *  replaced with `[redacted]`. */
export function redactErrorText(s: string): string {
  return s
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#'"<>]+)[^\s'"<>]*/gi, (_m, scheme: string, auth: string) => {
      const host = auth.includes('@') ? auth.slice(auth.lastIndexOf('@') + 1) : auth;
      return `${scheme}://${host}`;
    })
    .replace(/\bbearer\s+[^\s"',;]+/gi, '[redacted]')
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|token|key|secret|password|passwd|pwd|sig|signature|auth|authorization|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"'&,;]+/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]');
}

// ---------------------------------------------------------------------------
// Window decoding
// ---------------------------------------------------------------------------

export interface DecodedWindow {
  lines: string[];
  /** The window started mid-file (its partial first line was dropped). */
  truncatedStart: boolean;
  /** The window started mid-file and held no complete line: one line is longer than the window. */
  oversized: boolean;
}

/** Split a byte window into whole lines. Boundaries are `\n` bytes, which
 *  never occur inside a UTF-8 sequence, so only whole lines are decoded and a
 *  character cut at either edge is discarded with its line. A trailing line
 *  with no `\n` may be mid-append and is dropped. */
export function decodeWindow(buf: Buffer, startsMidFile: boolean): DecodedWindow {
  let from = 0;
  if (startsMidFile) {
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return { lines: [], truncatedStart: true, oversized: true };
    from = nl + 1;
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < from) return { lines: [], truncatedStart: startsMidFile, oversized: startsMidFile };
  const text = buf.toString('utf8', from, lastNl);
  const lines = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter(l => l.trim());
  return { lines, truncatedStart: startsMidFile, oversized: false };
}

interface PersistedEvent {
  type?: unknown;
  timestamp?: unknown;
  data?: { content?: unknown; message?: unknown } | null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Build the context and ask verdict from the decoded window. Pure. */
export function summarizeTail(w: DecodedWindow): TailResult {
  const events: PersistedEvent[] = [];
  for (const line of w.lines) {
    try {
      const e = JSON.parse(line) as unknown;
      if (e && typeof e === 'object' && typeof (e as PersistedEvent).type === 'string') events.push(e as PersistedEvent);
    } catch { /* skip an unparseable line */ }
  }
  if (events.length === 0) {
    return {
      context: { status: 'no-events', windowCoversTurn: false },
      ask: w.oversized ? { unavailable: 'oversized' } : w.truncatedStart ? { unavailable: 'truncated-start' } : { matched: null },
    };
  }
  const ctx: LastContext = { status: 'ok', windowCoversTurn: false };
  const last = events[events.length - 1];
  ctx.lastEventType = last.type as string;
  if (str(last.timestamp)) ctx.lastEventAt = last.timestamp as string;

  for (let i = events.length - 1; i >= 0 && !(ctx.lastUser && ctx.lastAssistant && ctx.lastError); i--) {
    const e = events[i];
    const at = str(e.timestamp) ?? '';
    if (e.type === 'user.message' && !ctx.lastUser) {
      const parsed = parseMessageSource(str(e.data?.content) ?? '');
      ctx.lastUser = { at, source: parsed.source, text: clipHead(parsed.cleanContent, USER_TEXT_MAX) };
      ctx.windowCoversTurn = true;
    } else if (e.type === 'assistant.message' && !ctx.lastAssistant) {
      const content = str(e.data?.content);
      if (content?.trim()) ctx.lastAssistant = { at, text: clipTail(content, ASSISTANT_TEXT_MAX) };
    } else if (e.type === 'session.error' && !ctx.lastError) {
      const msg = str(e.data?.message) ?? 'error';
      ctx.lastError = { at, text: clipHead(redactErrorText(msg), ERROR_TEXT_MAX) };
    }
  }

  // Ask: the last substantive assistant message of the latest turn. Walking
  // back, a user.message ends the turn; a session.error after the message
  // rejects it; lifecycle events (turn_end, usage, tool completions, idle)
  // are skipped.
  let ask: AskVerdict = { matched: null };
  let errorAfter = false;
  let found: string | undefined;
  let sawUser = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'session.error') { errorAfter = true; continue; }
    if (e.type === 'user.message') { sawUser = true; break; }
    if (e.type === 'assistant.message') {
      const content = str(e.data?.content);
      if (content?.trim()) { found = content; break; }
    }
  }
  if (found !== undefined) {
    if (!errorAfter) ask = detectAsk(found);
  } else if (!sawUser && w.truncatedStart) {
    // The turn (and possibly its message) starts before the window.
    ask = { unavailable: 'truncated-start' };
  }
  return { context: ctx, ask };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** The subset of fs.promises.FileHandle the reader uses (injectable for tests). */
export interface TailFileHandle {
  stat(): Promise<{ size: number; mtimeMs: number; dev: number; ino: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export type TailOpener = (path: string) => Promise<TailFileHandle>;

const defaultOpen: TailOpener = path => fsp.open(path, 'r') as unknown as Promise<TailFileHandle>;

export function eventsPathFor(sessionId: string): string {
  return join(STATE_DIR, sessionId, 'events.jsonl');
}

interface CacheEntry { identity: string; result: TailResult }
const cache = new Map<string, CacheEntry>();
const CACHE_LIMIT = 512;

/** Test hook. */
export function clearTailCache(): void {
  cache.clear();
}

function unavailable(code: string): TailResult {
  return { context: { status: 'unavailable', errorCode: code }, ask: { matched: null } };
}

/**
 * Read the last `maxBytes` of a session's events and summarize them. Never
 * throws: an fs error yields `status: 'unavailable'` with its code, never an
 * empty healthy context. Cached by session, `maxBytes` and the file identity
 * (`dev:ino`, size, mtime from the same fstat); busy sessions are not cached.
 */
export async function readSessionTailAsync(
  sessionId: string,
  maxBytes: number = TAIL_DEFAULT_MAX_BYTES,
  opts: { busy?: boolean; path?: string; open?: TailOpener } = {},
): Promise<TailResult> {
  const path = opts.path ?? eventsPathFor(sessionId);
  const open = opts.open ?? defaultOpen;
  const key = `${sessionId}\u0000${maxBytes}`;
  let fh: TailFileHandle | undefined;
  try {
    fh = await open(path);
    const st = await fh.stat();
    const identity = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (!opts.busy) {
      const hit = cache.get(key);
      if (hit && hit.identity === identity) return hit.result;
    }
    const start = Math.max(0, st.size - maxBytes);
    const length = st.size - start;
    const buf = Buffer.alloc(length);
    let off = 0;
    while (off < length) {
      const { bytesRead } = await fh.read(buf, off, length - off, start + off);
      if (bytesRead <= 0) break; // the file shrank under us: use what we have
      off += bytesRead;
    }
    const result = summarizeTail(decodeWindow(buf.subarray(0, off), start > 0));
    if (opts.busy) {
      cache.delete(key);
    } else {
      cache.delete(key);
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      cache.set(key, { identity, result });
    }
    return result;
  } catch (e) {
    return unavailable((e as NodeJS.ErrnoException)?.code ?? 'EIO');
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ });
  }
}

export interface TailRequest { sessionId: string; busy?: boolean }

/**
 * Read many tails with bounded concurrency and a whole-call deadline. A
 * session not reached (or not finished) by the deadline reports
 * `status: 'skipped-deadline'`; a late read finishes in the background and
 * only closes its handle.
 */
export async function readSessionTails(
  items: TailRequest[],
  opts: {
    maxBytes?: number; concurrency?: number; deadlineMs?: number;
    now?: () => number;
    read?: (sessionId: string, maxBytes: number, busy: boolean) => Promise<TailResult>;
  } = {},
): Promise<Map<string, TailResult>> {
  const maxBytes = opts.maxBytes ?? TAIL_DEFAULT_MAX_BYTES;
  const concurrency = Math.max(1, opts.concurrency ?? TAIL_DEFAULT_CONCURRENCY);
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? TAIL_DEFAULT_DEADLINE_MS);
  const read = opts.read ?? ((id, mb, busy) => readSessionTailAsync(id, mb, { busy }));
  const skipped: TailResult = { context: { status: 'skipped-deadline' }, ask: { matched: null } };
  const out = new Map<string, TailResult>();
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      const remaining = deadline - now();
      if (remaining <= 0) { out.set(item.sessionId, skipped); continue; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<TailResult>(resolve => { timer = setTimeout(() => resolve(skipped), remaining); });
      try {
        out.set(item.sessionId, await Promise.race([read(item.sessionId, maxBytes, !!item.busy), timeout]));
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
