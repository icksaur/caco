/**
 * HistoryLoader
 * 
 * Single owner of the history request→stream→complete lifecycle.
 * One way to load history. Impossible to double-request.
 * 
 * Replaces: waitForHistoryComplete, isHistoryPending, isHistoryStale,
 * historyGeneration counter, and server-side pendingHistory dedup.
 */

import { getActiveSessionId, setLoadingHistory } from './app-state.js';
import { setFormEnabled } from './view-controller.js';
import { onHistoryComplete, getConnectionId, subscribeToSession, requestHistory } from './websocket.js';
import { clearContextFooter } from './context-footer.js';
import { regions } from './dom-regions.js';
import { sessionTracker } from './session-state-tracker.js';
import { loadModels } from './model-selector.js';

const TIMEOUT_MS = 30000;

interface PendingLoad {
  sessionId: string;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
  unsub: () => void;
}

class HistoryLoader {
  private pending: PendingLoad | null = null;
  private lastSessionId: string | null = null;
  private lastConnectionId = -1;

  /**
   * Load history for a session. Cancels any in-flight request.
   * Clears chat, subscribes to WS, requests history, waits for completion.
   * Sets tracker busy state and form state from server response.
   */
  async load(sessionId: string): Promise<void> {
    this.cancel();
    
    setLoadingHistory(true);
    regions.chat.clear();
    clearContextFooter(); // Direct call OK — historyLoader is composed by chatView, footerSessionId already set
    subscribeToSession(sessionId);
    requestHistory(sessionId);
    
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        console.warn('[HISTORY] Timed out waiting for historyComplete');
        this.finish(resolve);
      }, TIMEOUT_MS);
      
      const unsub = onHistoryComplete((data) => {
        this.finish(resolve, data);
      });
      
      this.pending = { sessionId, resolve, timer, unsub };
    });
  }

  /**
   * Whether the last loaded history is stale.
   * True if sessionId differs or WS reconnected since last load.
   */
  isStale(sessionId: string): boolean {
    return this.lastSessionId !== sessionId
        || getConnectionId() !== this.lastConnectionId;
  }

  /**
   * Whether a history load is currently in-flight.
   */
  get loading(): boolean {
    return this.pending !== null;
  }

  private finish(resolve: () => void, data?: { isBusy?: boolean }): void {
    if (!this.pending) return;
    const { sessionId, timer, unsub } = this.pending;
    clearTimeout(timer);
    unsub();
    
    this.lastSessionId = sessionId;
    this.lastConnectionId = getConnectionId();
    this.pending = null;
    
    setLoadingHistory(false);
    
    const isBusy = data?.isBusy ?? false;
    const activeId = getActiveSessionId();
    if (activeId) {
      sessionTracker.setBusy(activeId, isBusy);
    }
    setFormEnabled(!isBusy);
    
    if (regions.chat.el.children.length === 0) {
      loadModels();
    }
    resolve();
  }

  private cancel(): void {
    if (!this.pending) return;
    const { timer, unsub, resolve } = this.pending;
    clearTimeout(timer);
    unsub();
    setLoadingHistory(false);
    this.pending = null;
    resolve();
  }
}

export const historyLoader = new HistoryLoader();

export { HistoryLoader };
