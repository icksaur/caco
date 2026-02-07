/**
 * UnobservedTracker - Single Source of Truth for Unobserved Sessions
 * 
 * Manages the set of sessions that have completed work but haven't been
 * viewed by any client. This provides:
 * 
 * 1. O(1) count and membership checks
 * 2. Single entry point for all state mutations
 * 3. Automatic persistence to meta.json files
 * 4. Easy unit testing
 * 
 * State Flow:
 *   session.idle event → markIdle(sessionId) → add to set, persist
 *   /observe API call  → markObserved(sessionId) → remove from set, persist
 *   session deleted    → remove(sessionId) → remove from set (no persist needed)
 * 
 * Multi-client Sync:
 *   - All mutations broadcast via WebSocket with current count
 *   - Clients update badge directly from event data (no refetch)
 *   - If client A observes, client B sees update via broadcast
 */

import { getSessionMeta, setSessionMeta, type SessionMeta } from './storage.js';

/**
 * Callback for broadcasting state changes to all clients
 */
type BroadcastCallback = (event: {
  type: string;
  data: { sessionId: string; unobservedCount: number };
}) => void;

class UnobservedTracker {
  private unobservedSet: Set<string> = new Set();
  private broadcastFn: BroadcastCallback | null = null;
  private initialized = false;

  /**
   * Set the broadcast function (called after WebSocket module loads)
   * This avoids circular dependency issues
   */
  setBroadcast(fn: BroadcastCallback): void {
    this.broadcastFn = fn;
  }

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
    // Update meta.json timestamp
    const meta = getSessionMeta(sessionId) ?? { name: '' };
    meta.lastIdleAt = new Date().toISOString();
    setSessionMeta(sessionId, meta);
    
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
    // Update meta.json timestamp
    const meta = getSessionMeta(sessionId) ?? { name: '' };
    meta.lastObservedAt = new Date().toISOString();
    setSessionMeta(sessionId, meta);
    
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

  /**
   * Broadcast state change to all clients
   */
  private broadcast(type: string, sessionId: string): void {
    if (this.broadcastFn) {
      this.broadcastFn({
        type,
        data: {
          sessionId,
          unobservedCount: this.unobservedSet.size
        }
      });
    }
  }
}

// Singleton instance
export const unobservedTracker = new UnobservedTracker();
