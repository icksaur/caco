import { getSessionMeta, updateSessionMeta } from './storage.js';
import { isUnobservedFromMeta } from './session-meta-store.js';
import { broadcastGlobalEvent } from './event-bus.js';

type BroadcastCallback = (event: {
  type: string;
  data: { reason: string; sessionId: string; unobservedCount: number };
}) => void;

export class UnobservedTracker {
  private unobservedSet: Set<string> = new Set();
  private initialized = false;

  constructor(private broadcastFn: BroadcastCallback) {}

  /**
   * Initialize tracker by hydrating from existing session metadata
   * Called once on server startup after session-manager loads sessions
   * 
   * @param sessionIds - List of known session IDs to check
   */
  hydrate(sessionIds: string[]): void {
    if (this.initialized) return;
    
    for (const sessionId of sessionIds) {
      // The SAME predicate the live path's decision produces, applied to the
      // stamps that decision wrote. Deriving it differently here is what let the
      // badge disagree with itself across a restart. Note there is deliberately
      // no `kind` test: a delegate target is an ordinary interactive session, so
      // attendance can only come from the request source, recorded as
      // `lastAttendedAt` (spec-observation-authority).
      if (isUnobservedFromMeta(getSessionMeta(sessionId))) {
        this.unobservedSet.add(sessionId);
      }
    }
    
    this.initialized = true;
    console.log(`[UNOBSERVED] Hydrated ${this.unobservedSet.size} unobserved sessions from ${sessionIds.length} total`);
  }

  /**
   * Mark session as idle (completed work)
   * Called when session.idle event is received from SDK
   * 
   * @param sessionId - Session that went idle
   * @returns true if session became unobserved (wasn't already in set)
   */
  markIdle(sessionId: string): boolean {
    // Persist the VERDICT alongside the timestamp. Only idles that need
    // observation reach here — the authority gates this call — so writing
    // `unobserved: true` records exactly what the live set is about to hold, and
    // hydrate reads it back rather than re-deriving it from timestamps that
    // cannot express who requested the work (spec-observation-authority).
    //
    // No kind test: `kind === 'swarm'` used to stand in for "an agent is watching
    // this", which is equally true of delegate targets — ordinary interactive
    // sessions no kind could ever catch. The request source answers it for every
    // kind, upstream at the authority.
    updateSessionMeta(sessionId, meta => {
      meta.lastIdleAt = new Date().toISOString();
      meta.unobserved = true;
    });
    
    // Add to unobserved set
    if (this.unobservedSet.has(sessionId)) {
      console.log(`[UNOBSERVED] markIdle: ${sessionId.slice(0, 8)} (already unobserved)`);
      return false;
    }
    
    this.unobservedSet.add(sessionId);
    console.log(`[UNOBSERVED] markIdle: ${sessionId.slice(0, 8)} → unobserved (count: ${this.unobservedSet.size})`);
    
    // Broadcast with count for direct badge update
    this.broadcast('session.idle', sessionId);
    
    return true;
  }

  /**
   * Mark session as observed (user has seen the completed response)
   * Called when client sends POST /sessions/:id/observe
   * 
   * @param sessionId - Session that was observed
   * @returns true if session was unobserved (count decremented)
   */
  markObserved(sessionId: string): boolean {
    // Update meta.json timestamp (best-effort; corrupt meta is not clobbered)
    updateSessionMeta(sessionId, meta => { meta.lastObservedAt = new Date().toISOString(); meta.unobserved = false; });
    
    // Remove from unobserved set
    if (!this.unobservedSet.has(sessionId)) {
      console.log(`[UNOBSERVED] markObserved: ${sessionId.slice(0, 8)} (wasn't unobserved)`);
      return false;
    }
    
    this.unobservedSet.delete(sessionId);
    console.log(`[UNOBSERVED] markObserved: ${sessionId.slice(0, 8)} → observed (count: ${this.unobservedSet.size})`);
    
    // Broadcast with count for direct badge update
    this.broadcast('session.observed', sessionId);
    
    return true;
  }

  /**
   * Get current count of unobserved sessions
   * O(1) operation
   */
  getCount(): number {
    return this.unobservedSet.size;
  }

  /**
   * Check if a specific session is unobserved
   * O(1) operation
   * 
   * @param sessionId - Session to check
   */
  isUnobserved(sessionId: string): boolean {
    return this.unobservedSet.has(sessionId);
  }

  /**
   * Remove session from tracking (called on session delete)
   * Does not broadcast - deletion has its own event
   * 
   * @param sessionId - Session being deleted
   */
  remove(sessionId: string): void {
    if (this.unobservedSet.delete(sessionId)) {
      console.log(`[UNOBSERVED] remove: ${sessionId.slice(0, 8)} deleted (count: ${this.unobservedSet.size})`);
    }
  }

  /**
   * Get list of unobserved session IDs (for debugging/testing)
   */
  getUnobservedIds(): string[] {
    return Array.from(this.unobservedSet);
  }

  private broadcast(type: string, sessionId: string): void {
    this.broadcastFn({
      type: 'session.listChanged',
      data: {
        reason: type.replace('session.', ''),
        sessionId,
        unobservedCount: this.unobservedSet.size
      }
    });
  }
}

export const unobservedTracker = new UnobservedTracker(
  (event) => broadcastGlobalEvent(event)
);
