/**
 * Turn outcome signal (spec-session-wake): one event per turn, at its REAL end.
 * `ok` comes from the idle authority's real-idle branch (after any reveal
 * continuations), `error` from every non-idle dispatch teardown, `cancelled`
 * from the user's Stop (the cancel route), which a failure count must ignore.
 * The first outcome after a run starts wins, so the abort's own idle or error
 * that follows a `cancelled` is ignored by listeners that settle once. Keyed by
 * session, not correlationId: continuations mint fresh correlation ids, while a
 * session runs one turn at a time (a second send gets 409).
 */

export type TurnOutcome = 'ok' | 'error' | 'cancelled';
type Listener = (sessionId: string, outcome: TurnOutcome, reason?: string) => void;

const listeners = new Set<Listener>();

export function onTurnOutcome(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

type RetryListener = (sessionId: string, attempt: number) => void;
const retryListeners = new Set<RetryListener>();

/** A transient retry was scheduled for the session's current turn (no outcome
 *  is emitted for the failed attempt; the chain's final outcome comes once). */
export function onTurnRetry(cb: RetryListener): () => void {
  retryListeners.add(cb);
  return () => { retryListeners.delete(cb); };
}

export function emitTurnRetry(sessionId: string, attempt: number): void {
  for (const cb of retryListeners) {
    try { cb(sessionId, attempt); } catch (e) {
      console.error(`[TURN-OUTCOME] retry listener threw: ${e instanceof Error ? e.name : typeof e}`);
    }
  }
}

export function emitTurnOutcome(sessionId: string, outcome: TurnOutcome, reason?: string): void {
  for (const cb of listeners) {
    try { cb(sessionId, outcome, reason); } catch (e) {
      console.error(`[TURN-OUTCOME] listener threw: ${e instanceof Error ? e.name : typeof e}`);
    }
  }
}
