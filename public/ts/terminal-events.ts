/**
 * Terminal Events
 * 
 * Events that signal the end of a streaming session.
 * Used to re-enable the form after streaming completes.
 */

/**
 * Set of event types that signal streaming is complete
 */
const TERMINAL_EVENTS = new Set([
  'session.idle',   // Normal completion
  'session.error',  // Error during processing
]);

/**
 * Check if an event type signals the end of streaming
 * 
 * @remarks Unit test all changes - see tests/unit/terminal-events.test.ts
 */
export function isTerminalEvent(eventType: string): boolean {
  return TERMINAL_EVENTS.has(eventType);
}
