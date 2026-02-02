/**
 * Applet Push - Pub/Sub for pushing state to applets
 * 
 * Decouples applet-tools from websocket route.
 * Tools register a push handler, websocket registers to receive pushes.
 */

type StatePushHandler = (sessionId: string | null, state: Record<string, unknown>) => boolean;

let pushHandler: StatePushHandler | null = null;

/**
 * Register a handler to receive state push requests.
 * Called by websocket module during setup.
 */
export function registerStatePushHandler(handler: StatePushHandler): void {
  pushHandler = handler;
}

/**
 * Push state to applets.
 * Called by applet tools.
 * Returns true if any clients received the push.
 */
export function pushStateToApplet(sessionId: string | null, state: Record<string, unknown>): boolean {
  if (!pushHandler) {
    console.warn('[APPLET-PUSH] No handler registered');
    return false;
  }
  return pushHandler(sessionId, state);
}
