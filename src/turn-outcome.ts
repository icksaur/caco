/**
 * Turn outcome signal (spec-session-wake): one event per turn, at its REAL end.
 * `ok` comes from the idle authority's real-idle branch (after any reveal
 * continuations), `error` from every non-idle dispatch teardown. Keyed by
 * session, not correlationId: continuations mint fresh correlation ids, while a
 * session runs one turn at a time (a second send gets 409).
 */

export type TurnOutcome = 'ok' | 'error';
type Listener = (sessionId: string, outcome: TurnOutcome, reason?: string) => void;

const listeners = new Set<Listener>();

export function onTurnOutcome(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function emitTurnOutcome(sessionId: string, outcome: TurnOutcome, reason?: string): void {
  for (const cb of listeners) {
    try { cb(sessionId, outcome, reason); } catch (e) {
      console.error(`[TURN-OUTCOME] listener threw: ${e instanceof Error ? e.name : typeof e}`);
    }
  }
}
