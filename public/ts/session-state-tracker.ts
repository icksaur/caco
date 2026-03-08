/**
 * SessionStateTracker
 * 
 * Single source of truth for per-session state on the frontend.
 * Consumers subscribe via onChange instead of managing their own state.
 * 
 * State sources feed in via setBusy/setUnobserved/setIntent/syncFromList.
 * UI subscribers react to changes (form state, session panel, menu badges).
 */

export interface TrackedSession {
  busy: boolean;
  unobserved: boolean;
  intent: string | null;
}

type ChangeListener = (sessionId: string, state: TrackedSession) => void;

function defaultState(): TrackedSession {
  return { busy: false, unobserved: false, intent: null };
}

class SessionStateTracker {
  private sessions = new Map<string, TrackedSession>();
  private listeners = new Set<ChangeListener>();

  private getOrCreate(sessionId: string): TrackedSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = defaultState();
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private notify(sessionId: string, state: TrackedSession): void {
    for (const cb of this.listeners) {
      try { cb(sessionId, state); } catch (e) { console.error('[TRACKER] Listener error:', e); }
    }
  }

  setBusy(sessionId: string, busy: boolean): void {
    const s = this.getOrCreate(sessionId);
    if (s.busy === busy) return;
    s.busy = busy;
    this.notify(sessionId, s);
  }

  setUnobserved(sessionId: string, unobserved: boolean): void {
    const s = this.getOrCreate(sessionId);
    if (s.unobserved === unobserved) return;
    s.unobserved = unobserved;
    this.notify(sessionId, s);
  }

  setIntent(sessionId: string, intent: string | null): void {
    const s = this.getOrCreate(sessionId);
    if (s.intent === intent) return;
    s.intent = intent;
    this.notify(sessionId, s);
  }

  /**
   * Bulk sync from /api/sessions response.
   * Updates existing, adds new, removes sessions no longer in the list.
   */
  syncFromList(sessions: Array<{ sessionId: string; isBusy?: boolean; isUnobserved?: boolean; currentIntent?: string | null }>): void {
    const seen = new Set<string>();

    for (const item of sessions) {
      seen.add(item.sessionId);
      const s = this.getOrCreate(item.sessionId);
      let changed = false;

      const busy = item.isBusy ?? false;
      if (s.busy !== busy) { s.busy = busy; changed = true; }

      const unobserved = item.isUnobserved ?? false;
      if (s.unobserved !== unobserved) { s.unobserved = unobserved; changed = true; }

      const intent = item.currentIntent ?? null;
      if (s.intent !== intent) { s.intent = intent; changed = true; }

      if (changed) this.notify(item.sessionId, s);
    }

    // Remove sessions no longer in the server list
    for (const [id] of this.sessions) {
      if (!seen.has(id)) {
        this.sessions.delete(id);
      }
    }
  }

  get(sessionId: string): TrackedSession | undefined {
    return this.sessions.get(sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.busy ?? false;
  }

  getIntent(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.intent ?? null;
  }

  getBusyCount(excludeId?: string): number {
    let count = 0;
    for (const [id, s] of this.sessions) {
      if (s.busy && id !== excludeId) count++;
    }
    return count;
  }

  getUnobservedCount(): number {
    let count = 0;
    for (const [, s] of this.sessions) {
      if (s.unobserved) count++;
    }
    return count;
  }

  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

export const sessionTracker = new SessionStateTracker();

// Export class for testing
export { SessionStateTracker };
