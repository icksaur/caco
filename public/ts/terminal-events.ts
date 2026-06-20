const TERMINAL_EVENTS = new Set([
  'session.idle',
  'session.error',
]);

/**
 * Check if an event type signals the end of streaming
 * 
 * @remarks Unit test all changes - see tests/unit/terminal-events.test.ts
 */
export function isTerminalEvent(eventType: string): boolean {
  return TERMINAL_EVENTS.has(eventType);
}
