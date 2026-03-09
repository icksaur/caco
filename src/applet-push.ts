export type StatePushHandler = (sessionId: string | null, state: Record<string, unknown>) => boolean;

export function createAppletPush(handler: StatePushHandler) {
  return {
    pushStateToApplet(sessionId: string | null, state: Record<string, unknown>): boolean {
      return handler(sessionId, state);
    }
  };
}
