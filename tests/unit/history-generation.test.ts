/**
 * P7 slice 3: history generation-token discard.
 *
 * A replay frame from a superseded history load carries the OLD generation and
 * must be dropped so it cannot interleave into the active DOM. Live broadcasts
 * carry no generation and must NEVER be dropped by this rule.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionEvent } from '../../public/ts/types.js';

vi.mock('../../public/ts/debug.js', () => ({ debug: vi.fn() }));
vi.mock('../../public/ts/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../public/ts/app-state.js', () => ({
  getActiveSessionId: vi.fn(() => null),
}));
vi.mock('../../public/ts/session-observed.js', () => ({
  markSessionObserved: vi.fn(),
}));

function ev(id: string): SessionEvent {
  return { type: 'assistant.message', data: { id } } as unknown as SessionEvent;
}

describe('history generation discard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('drops event frames tagged with a superseded generation, keeps current and live', async () => {
    const ws = await import('../../public/ts/websocket.js');
    const received: string[] = [];
    ws.onEvent((e) => {
      received.push(((e as { data?: { id?: string } }).data?.id) ?? '?');
    });

    // Two history loads: gen 1 then gen 2. currentHistoryGen is now 2.
    ws.requestHistory('s');
    ws.requestHistory('s');

    ws.handleMessage({ type: 'event', sessionId: 's', generation: 1, event: ev('stale') });   // dropped
    ws.handleMessage({ type: 'event', sessionId: 's', generation: 2, event: ev('current') }); // kept
    ws.handleMessage({ type: 'event', sessionId: 's', event: ev('live') });                   // kept (untagged)

    expect(received).toEqual(['current', 'live']);
  });

  it('does not resolve a historyComplete for a superseded generation', async () => {
    const ws = await import('../../public/ts/websocket.js');
    const completed: Array<number | undefined> = [];
    let n = 0;
    ws.onHistoryComplete(() => { completed.push(++n); });

    ws.requestHistory('s'); // gen 1
    ws.requestHistory('s'); // gen 2

    ws.handleMessage({ type: 'historyComplete', sessionId: 's', generation: 1 }); // ignored
    ws.handleMessage({ type: 'historyComplete', sessionId: 's', generation: 2 }); // resolves

    expect(completed).toEqual([1]);
  });

  it('keeps an untagged live event while a history load is in flight', async () => {
    const ws = await import('../../public/ts/websocket.js');
    const received: string[] = [];
    ws.onEvent((e) => {
      received.push(((e as { data?: { id?: string } }).data?.id) ?? '?');
    });

    ws.requestHistory('s'); // load in flight, gen 1
    ws.handleMessage({ type: 'event', sessionId: 's', event: ev('live') }); // untagged → never dropped

    expect(received).toEqual(['live']);
  });

  it('warns when a session-scoped frame arrives without a sessionId', async () => {
    const ws = await import('../../public/ts/websocket.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    ws.handleMessage({ type: 'event', event: ev('orphan') });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without a sessionId'));
    warn.mockRestore();
  });
});
