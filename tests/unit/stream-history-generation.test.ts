/**
 * P7 slice 3 (BE): streamHistory must stamp the request's generation on every
 * replay frame so a superseded client load can discard them.
 */

import { describe, it, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import { streamHistory } from '../../src/routes/websocket.js';

interface SentFrame { type: string; generation?: number }

function fakeWs() {
  const sent: SentFrame[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: vi.fn((data: string) => { sent.push(JSON.parse(data)); }),
  } as unknown as WebSocket;
  return { ws, sent };
}

describe('streamHistory generation stamping', () => {
  it('stamps the passed generation on the historyComplete of the no-session path', async () => {
    const { ws, sent } = fakeWs();

    // sessionId 'default' takes the early path emitting a single historyComplete.
    await streamHistory(ws, 'default', 7);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('historyComplete');
    expect(sent[0].generation).toBe(7);
  });

  it('omits generation when none is provided (legacy caller)', async () => {
    const { ws, sent } = fakeWs();

    await streamHistory(ws, 'default');

    expect(sent[0].generation).toBeUndefined();
  });
});
