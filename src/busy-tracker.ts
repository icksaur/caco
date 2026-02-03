/**
 * BusyTracker - Tracks which sessions are actively processing
 * 
 * Simple state tracking: which sessions are currently streaming/working.
 * Used to prevent deletion of busy sessions and show busy indicators in UI.
 */

class BusyTracker {
  // sessionIds currently streaming/working
  private busy = new Set<string>();

  /**
   * Mark session as busy (actively streaming/processing)
   */
  markBusy(sessionId: string): void {
    this.busy.add(sessionId);
  }

  /**
   * Mark session as idle (done processing)
   */
  markIdle(sessionId: string): void {
    this.busy.delete(sessionId);
  }

  /**
   * Check if session is currently busy
   */
  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }
}

// Singleton instance
export const busyTracker = new BusyTracker();
