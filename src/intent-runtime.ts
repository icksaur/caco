/**
 * In-memory runtime state for per-session intent.
 *
 * `currentIntent` and `intentHistory` were previously persisted to
 * `~/.caco/sessions/<id>/meta.json` on every emit — one full JSON serialize +
 * fsync + rename per assistant turn, for a signal that only renders as the
 * italic sub-line in the session sidebar (spec-intent-in-memory). That cost
 * paid for nothing across restarts: the moment Caco restarts every session is
 * idle, no one is triaging active work, and the sub-line's value evaporates.
 *
 * This module holds that state in RAM. `setSessionIntent` still touches
 * meta.json when it needs to latch the first valid intent into
 * `meta.autoName` (that IS load-bearing — it's the persistent session title
 * fallback in the spec-auto-name-sessions ladder). Every subsequent emit
 * writes only here.
 *
 * Legacy meta.json files that still hold `currentIntent`/`intentHistory` are
 * honored via lazy seeding on first read, so existing sessions and imported
 * archives continue to display the same sub-line until the session next
 * emits.
 */

export const INTENT_HISTORY_LIMIT = 5;

export interface IntentHistoryEntry {
  text: string;
  ts: number;
}

/** Legacy meta.json fields a caller can pass to lazily seed the runtime map
 *  on first read. Structural, not a full SessionMeta — keeps intent-runtime
 *  free of any dependency on session-meta-store (which itself imports from
 *  here). Callers already have meta in hand when they read intent state. */
export interface IntentSeedHint {
  currentIntent?: string;
  intentHistory?: Array<{ text: string; ts: number } | null | undefined>;
}

interface IntentRuntimeState {
  currentIntent?: string;
  intentHistory: IntentHistoryEntry[];
  /** True once we've attempted a lazy seed from meta.json. Prevents re-reading
   *  legacy state after the first projection — one attempt is enough. */
  seededFromMeta: boolean;
  /** True once `setSessionIntent` has done its once-per-process check for
   *  whether meta.autoName needs latching. Post-latch (or post-observed-latched)
   *  every subsequent intent is pure in-memory: zero disk reads, zero writes.
   *  This is the cost-saving core of spec-intent-in-memory. */
  autoNameChecked: boolean;
}

const state = new Map<string, IntentRuntimeState>();

function ensureEntry(sessionId: string): IntentRuntimeState {
  let entry = state.get(sessionId);
  if (!entry) {
    entry = { intentHistory: [], seededFromMeta: false, autoNameChecked: false };
    state.set(sessionId, entry);
  }
  return entry;
}

/** One-time hydration from a caller-supplied meta.json snapshot for sessions
 *  carrying legacy on-disk intent state. Reads pass meta already in hand so
 *  intent-runtime has no reverse dependency on session-meta-store. */
function seedFromHintOnce(entry: IntentRuntimeState, hint: IntentSeedHint | undefined): void {
  if (entry.seededFromMeta) return;
  entry.seededFromMeta = true;
  if (!hint) return;
  if (entry.currentIntent === undefined && typeof hint.currentIntent === 'string') {
    entry.currentIntent = hint.currentIntent;
  }
  if (entry.intentHistory.length === 0 && Array.isArray(hint.intentHistory)) {
    entry.intentHistory = hint.intentHistory
      .filter((h): h is { text: string; ts: number } => !!h && typeof h.text === 'string' && typeof h.ts === 'number')
      .slice(-INTENT_HISTORY_LIMIT);
  }
}

/** Update runtime intent state. Returns the previous intent (or undefined) so
 *  callers can detect the "first valid intent" transition without a re-read. */
export function recordIntent(sessionId: string, intent: string): { previous: string | undefined; historyLength: number } {
  const entry = ensureEntry(sessionId);
  const previous = entry.currentIntent;
  entry.currentIntent = intent;
  entry.intentHistory.push({ text: intent, ts: Date.now() });
  if (entry.intentHistory.length > INTENT_HISTORY_LIMIT) {
    entry.intentHistory.splice(0, entry.intentHistory.length - INTENT_HISTORY_LIMIT);
  }
  return { previous, historyLength: entry.intentHistory.length };
}

/** Current intent for the session, or undefined if none has been recorded and
 *  no legacy meta.json value was seeded. Callers with meta in hand pass it as
 *  `seedHint` so pre-refactor sessions still show their sub-line on first
 *  projection after restart. */
export function getCurrentIntent(sessionId: string, seedHint?: IntentSeedHint): string | undefined {
  const entry = ensureEntry(sessionId);
  seedFromHintOnce(entry, seedHint);
  return entry.currentIntent;
}

/** Snapshot of the bounded history for the session (most recent last). */
export function getIntentHistory(sessionId: string, seedHint?: IntentSeedHint): IntentHistoryEntry[] {
  const entry = ensureEntry(sessionId);
  seedFromHintOnce(entry, seedHint);
  return [...entry.intentHistory];
}

/** Drop runtime state for a session that has been destroyed/archived. The Map
 *  otherwise grows over the process lifetime. Bounded by session count so this
 *  is not a leak in practice; the cleanup is just tidy. */
export function forgetIntent(sessionId: string): void {
  state.delete(sessionId);
}

/** True iff `setSessionIntent` still needs to consult meta.json for this
 *  session's autoName state. Flipped by `markAutoNameChecked` after the first
 *  successful check, so every later intent stays pure in-memory. */
export function needsAutoNameCheck(sessionId: string): boolean {
  return !ensureEntry(sessionId).autoNameChecked;
}

/** Record that we've already checked (and if applicable, latched) autoName
 *  for this session — no need to touch disk again for future intents. */
export function markAutoNameChecked(sessionId: string): void {
  ensureEntry(sessionId).autoNameChecked = true;
}

/** Test-only: wipe the entire runtime map. Not exported through storage.ts. */
export function _resetIntentRuntimeForTests(): void {
  state.clear();
}
