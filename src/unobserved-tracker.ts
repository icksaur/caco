import { getSessionMeta, updateSessionMeta } from './storage.js';
import { broadcastGlobalEvent } from './event-bus.js';
import { activityVersion } from './activity-version.js';
import type { SessionKind } from './session-meta-store.js';

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
      const meta = getSessionMeta(sessionId);
      if (!meta?.lastIdleAt) continue; // Never went idle
      if (meta.kind === 'swarm') continue;
      if (!meta.lastObservedAt) {
        // Never observed - add to unobserved set
        this.unobservedSet.add(sessionId);
        continue;
      }
      // Check if idle occurred after last observation
      if (new Date(meta.lastIdleAt) > new Date(meta.lastObservedAt)) {
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
    // Update meta.json timestamp (best-effort; corrupt meta is not clobbered)
    let kind: SessionKind | undefined;
    updateSessionMeta(sessionId, meta => {
      meta.lastIdleAt = new Date().toISOString();
      kind = meta.kind;
    });
    
    // Swarm sessions don't become unobserved — parent agent observes them
    if (kind === 'swarm') {
      console.log(`[UNOBSERVED] markIdle: ${sessionId.slice(0, 8)} (swarm session, skipping)`);
      return false;
    }
    
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
    updateSessionMeta(sessionId, meta => { meta.lastObservedAt = new Date().toISOString(); });
    
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
    // The single chokepoint for both mark paths, so the pager board cannot go
    // stale on an observed/unobserved change without also failing to broadcast
    // (spec-pager).
    activityVersion.bump();
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
