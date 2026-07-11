/**
 * Change-triggered gate for the per-turn deferred-tools discovery reminder
 * (spec-enable-tools-discovery: proactive discovery). The reminder is pushed into
 * the model prompt only when the session's deferred set has CHANGED since the last
 * emission, so cumulative history cost is O(defer/enable events), not O(turns) —
 * never a fixed per-turn tax.
 *
 * A context boundary that drops the prior reminder from the window (compaction)
 * clears the signature via `clearDeferredReminder`, so the next dispatch re-emits
 * even when the set is unchanged. A cold resume re-emits naturally because auto-
 * defer changes the set; a warm resume keeps the reminder in replayed history, so
 * no forced re-emit is needed there.
 *
 * Leaf store: a per-session signature Map, no imports beyond the pure renderer.
 */

import type { ToolKey } from './tool-key.js';
import { renderDeferredToolsReminder } from './session-tool-state.js';

const lastSig = new Map<string, string>();

function signature(keys: readonly ToolKey[]): string {
  return [...keys].map(k => k as string).sort().join(',');
}

/**
 * The reminder to append this dispatch as a deferred COMMIT: `text` is the reminder
 * (or null when none should be emitted — empty or unchanged set), and `commit()`
 * advances the stored signature. The caller invokes `commit()` only once the send is
 * actually in flight, so a pre-send failure never marks a reminder as emitted that
 * the model never received (which would wedge re-emission of an unchanged set).
 * Synchronous.
 */
export function computeDeferredReminder(sessionId: string, keys: readonly ToolKey[]): { text: string | null; commit: () => void } {
  if (keys.length === 0) {
    return { text: null, commit: () => lastSig.delete(sessionId) };
  }
  const sig = signature(keys);
  if (lastSig.get(sessionId) === sig) return { text: null, commit: () => {} };
  return { text: renderDeferredToolsReminder(keys), commit: () => lastSig.set(sessionId, sig) };
}

/** Drop the stored signature so the next dispatch re-emits regardless of change.
 *  Called at compaction (prior reminder left the window) and on session teardown. */
export function clearDeferredReminder(sessionId: string): void {
  lastSig.delete(sessionId);
}
