/**
 * DispatchState - Tracks active dispatches and their context
 * 
 * Consolidates busy tracking and correlation context into one source of truth.
 * A session is "dispatching" when actively processing a message from the SDK.
 * 
 * Extends EventEmitter: emits 'idle' when a dispatch ends, enabling
 * event-driven completion detection in swarm/delegate tools.
 */

import { EventEmitter } from 'events';

export interface ActiveDispatch {
  correlationId: string;
  startedAt: number;
}

export class DispatchState extends EventEmitter {
  private dispatches = new Map<string, ActiveDispatch>();

  start(sessionId: string, correlationId: string): void {
    if (this.dispatches.has(sessionId)) {
      console.warn(`[DISPATCH] Session ${sessionId} already dispatching, overwriting context`);
    }
    this.dispatches.set(sessionId, {
      correlationId,
      startedAt: Date.now()
    });
  }

  end(sessionId: string): void {
    this.dispatches.delete(sessionId);
    this.emit('idle', sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.dispatches.has(sessionId);
  }

  getCorrelationId(sessionId: string): string | undefined {
    return this.dispatches.get(sessionId)?.correlationId;
  }

  getDispatch(sessionId: string): ActiveDispatch | undefined {
    return this.dispatches.get(sessionId);
  }

  getAllActive(): Map<string, ActiveDispatch> {
    return new Map(this.dispatches);
  }

  waitForIdle(sessionId: string, timeoutMs: number): Promise<'idle' | 'timeout'> {
    return new Promise((resolve) => {
      if (!this.isBusy(sessionId)) { resolve('idle'); return; }

      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.removeListener('idle', onIdle);
      };

      const timer = setTimeout(() => { cleanup(); resolve('timeout'); }, timeoutMs);

      const onIdle = (id: string) => {
        if (id !== sessionId) return;
        cleanup();
        resolve('idle');
      };

      this.on('idle', onIdle);
      if (!this.isBusy(sessionId)) { cleanup(); resolve('idle'); }
    });
  }
}

export function waitForSessionIdle(
  sessionId: string,
  timeoutMs: number,
  isGone: () => boolean
): Promise<'idle' | 'timeout' | 'gone'> {
  return new Promise((resolve) => {
    if (isGone()) { resolve('gone'); return; }
    if (!dispatchState.isBusy(sessionId)) { resolve('idle'); return; }

    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(goneCheck);
      dispatchState.removeListener('idle', onIdle);
    };

    const timer = setTimeout(() => { cleanup(); resolve('timeout'); }, timeoutMs);

    const goneCheck = setInterval(() => {
      if (isGone()) { cleanup(); resolve('gone'); }
    }, 10_000);

    const onIdle = (id: string) => {
      if (id !== sessionId) return;
      cleanup();
      resolve('idle');
    };

    dispatchState.on('idle', onIdle);
    if (!dispatchState.isBusy(sessionId)) { cleanup(); resolve('idle'); }
  });
}

export const dispatchState = new DispatchState();
