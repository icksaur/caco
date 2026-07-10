/**
 * Auto-continuation pure decision core (spec-enable-tools-autocontinue).
 *
 * After a dispatch that revealed tools (via `caco_enable_tools`) goes idle, Caco
 * may auto-send ONE follow-up so a fresh dispatch runs with the newly-enabled
 * tools present (the SDK freezes the tool array per dispatch, so a reveal is only
 * usable in the NEXT dispatch). This module is the pure gate for that decision —
 * no I/O, no SDK, no state — so the fire/skip/cap rules are unit-testable in
 * isolation.
 */

/** Default maximum consecutive auto-continuations before we stop and ask the
 *  operator to intervene. Reset by any human/agent/applet/scheduler dispatch. */
export const AUTO_CONTINUE_CAP = 3;

export interface AutoContinueInput {
  /** Whether this session has any pending revealed tools awaiting a continuation. */
  hasPending: boolean;
  /** Whether the session is currently processing another dispatch. */
  busy: boolean;
  /** Consecutive auto-continuations already fired for this session. */
  attempts: number;
  /** Cap on consecutive auto-continuations. */
  cap: number;
}

export type AutoContinueDecision = 'fire' | 'skip' | 'cap-reached';

/**
 * Decide whether to fire an auto-continuation.
 * - `fire`: a reveal is pending, the session is idle, and we are under the cap.
 * - `cap-reached`: a reveal is pending but we have hit the consecutive cap.
 * - `skip`: nothing pending, or the session is busy.
 *
 * The busy check precedes the cap check on purpose: a busy session should simply
 * skip (the in-flight dispatch will re-evaluate at its own idle), never emit the
 * terminal cap message.
 */
export function decideAutoContinue({ hasPending, busy, attempts, cap }: AutoContinueInput): AutoContinueDecision {
  if (!hasPending) return 'skip';
  if (busy) return 'skip';
  if (attempts >= cap) return 'cap-reached';
  return 'fire';
}
