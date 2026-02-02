/**
 * CwdLockManager - Manages working directory locks for sessions
 * 
 * Enforces: only one session can be actively working in a directory at a time.
 * A session "holds" a lock when it's registered, but only "blocks" when busy (streaming).
 * 
 * Separation of concerns:
 * - This class: lock acquisition, release, and busy state
 * - SessionManager: SDK client lifecycle
 */

import { CwdLockedError } from './types.js';

export class CwdLockManager {
  // cwd → sessionId (which session holds the lock)
  private locks = new Map<string, string>();
  
  // sessionIds currently streaming/working
  private busy = new Set<string>();

  /**
   * Acquire lock for a cwd. If another session holds the lock AND is busy, throws.
   * If another session holds but is idle, the stale lock is cleared.
   * @param cwd - Working directory to lock
   * @param sessionId - Session requesting the lock
   * @throws CwdLockedError if cwd is locked by a busy session
   */
  acquire(cwd: string, sessionId: string): void {
    const holder = this.locks.get(cwd);
    
    if (holder && holder !== sessionId) {
      if (this.busy.has(holder)) {
        throw new CwdLockedError(cwd, holder);
      }
      // Stale lock from idle session - clear it
      this.locks.delete(cwd);
    }
    
    this.locks.set(cwd, sessionId);
  }

  /**
   * Release lock for a session (called on session stop)
   * Also clears busy state if set.
   */
  release(sessionId: string): void {
    // Find and remove the lock held by this session
    for (const [cwd, holder] of this.locks) {
      if (holder === sessionId) {
        this.locks.delete(cwd);
        break;
      }
    }
    this.busy.delete(sessionId);
  }

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

  /**
   * Check if a cwd is locked by a busy session (excluding a specific session)
   * Used to check if we CAN acquire before trying
   */
  isBlocked(cwd: string, excludeSession?: string): boolean {
    const holder = this.locks.get(cwd);
    if (!holder) return false;
    if (excludeSession && holder === excludeSession) return false;
    return this.busy.has(holder);
  }

  /**
   * Get the session holding a lock (if any)
   */
  getHolder(cwd: string): string | null {
    return this.locks.get(cwd) || null;
  }

  /**
   * Clear a stale lock directly (for cleanup scenarios)
   */
  clearLock(cwd: string): void {
    this.locks.delete(cwd);
  }
}

// Singleton instance
export const cwdLockManager = new CwdLockManager();
