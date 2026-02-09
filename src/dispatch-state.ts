/**
 * DispatchState - Tracks active dispatches and their context
 * 
 * Consolidates busy tracking and correlation context into one source of truth.
 * A session is "dispatching" when actively processing a message from the SDK.
 * 
 * During dispatch:
 * - Session is marked busy (can't receive new messages)
 * - correlationId is available for tools to inherit
 * 
 * Lifecycle: start() → getCorrelationId() → end()
 */

export interface ActiveDispatch {
  correlationId: string;
  startedAt: number;
}

export class DispatchState {
  private dispatches = new Map<string, ActiveDispatch>();

  /**
   * Start a dispatch - marks session as busy with correlation context
   */
  start(sessionId: string, correlationId: string): void {
    if (this.dispatches.has(sessionId)) {
      console.warn(`[DISPATCH] Session ${sessionId} already dispatching, overwriting context`);
    }
    this.dispatches.set(sessionId, {
      correlationId,
      startedAt: Date.now()
    });
  }

  /**
   * End a dispatch - clears busy state and correlation context
   */
  end(sessionId: string): void {
    this.dispatches.delete(sessionId);
  }

  /**
   * Check if session is currently dispatching
   */
  isBusy(sessionId: string): boolean {
    return this.dispatches.has(sessionId);
  }

  /**
   * Get correlationId for active dispatch (used by tools)
   * Returns undefined if no dispatch is active
   */
  getCorrelationId(sessionId: string): string | undefined {
    return this.dispatches.get(sessionId)?.correlationId;
  }

  /**
   * Get dispatch info (for debugging/metrics)
   */
  getDispatch(sessionId: string): ActiveDispatch | undefined {
    return this.dispatches.get(sessionId);
  }

  /**
   * Get all active dispatches (for debugging)
   */
  getAllActive(): Map<string, ActiveDispatch> {
    return new Map(this.dispatches);
  }
}

// Singleton instance
export const dispatchState = new DispatchState();
