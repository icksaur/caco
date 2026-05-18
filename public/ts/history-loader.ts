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
import { onHistoryComplete, getConnectionId, subscribeToSession, requestHistory, onEvent } from './websocket.js';
import { clearContextFooter, updateContextUsage } from './context-footer.js';
import { regions } from './dom-regions.js';
import { scrollToBottom } from './ui-utils.js';
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
    clearContextFooter();
    subscribeToSession(sessionId);

    const tRequest = performance.now();
    let tFirstEvent = 0;
    let eventCount = 0;
    const unsubEvent = onEvent(() => {
      eventCount += 1;
      if (tFirstEvent === 0) tFirstEvent = performance.now();
    });

    requestHistory(sessionId);

    return new Promise<void>(resolve => {
      const wrappedResolve = () => {
        unsubEvent();
        const tComplete = performance.now();
        const waitMs = (tFirstEvent || tComplete) - tRequest;
        const streamMs = tFirstEvent ? tComplete - tFirstEvent : 0;
        console.log(`[PERF] history ${sessionId.slice(0,8)}: ttfe=${waitMs.toFixed(1)}ms stream=${streamMs.toFixed(1)}ms events=${eventCount}`);
        resolve();
      };
      const timer = setTimeout(() => {
        console.warn('[HISTORY] Timed out waiting for historyComplete');
        this.finish(wrappedResolve);
      }, TIMEOUT_MS);

      const unsub = onHistoryComplete((data) => {
        this.finish(wrappedResolve, data);
      });

      this.pending = { sessionId, resolve: wrappedResolve, timer, unsub };
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

  private finish(resolve: () => void, data?: { isBusy?: boolean; usage?: { tokenLimit: number; currentTokens: number } }): void {
    if (!this.pending) return;
    const { sessionId, timer, unsub } = this.pending;
    clearTimeout(timer);
    unsub();
    
    this.lastSessionId = sessionId;
    this.lastConnectionId = getConnectionId();
    this.pending = null;
    
    setLoadingHistory(false);
    scrollToBottom();
    
    const isBusy = data?.isBusy ?? false;
    const activeId = getActiveSessionId();
    if (activeId) {
      sessionTracker.setBusy(activeId, isBusy);
      if (data?.usage) {
        updateContextUsage(data.usage, activeId);
      }
    }
    setFormEnabled(!isBusy);

    // Clean up stale thinking indicator from history replay
    if (!isBusy) {
      const chat = regions.chat as { removeThinking?: () => void; removeStreamingCursors?: () => void };
      chat.removeThinking?.();
      chat.removeStreamingCursors?.();
    }
    
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
