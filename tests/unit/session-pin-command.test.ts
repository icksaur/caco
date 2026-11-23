import { describe, it, expect, beforeEach, vi } from 'vitest';

const showToast = vi.hoisted(() => vi.fn());
const cached = vi.hoisted(() => ({ sessions: [] as Array<{ sessionId: string; folder?: string }> }));

vi.mock('../../public/ts/toast.js', () => ({ showToast }));
vi.mock('../../public/ts/session-panel.js', () => ({
  archiveSession: vi.fn(),
  stageSessionForArchive: vi.fn(),
  renameSession: vi.fn(),
  getCachedSessions: () => cached.sessions,
}));

import { findCommand } from '../../public/ts/command-registry.js';
import { setActiveSession } from '../../public/ts/app-state.js';

function stubFetch(ok = true) {
  const fetchMock = vi.fn(async (_input: string, _init?: { method: string; body: string }) => ({ ok, json: async () => (ok ? { ok: true } : { error: 'bad folder' }) }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function patchBody(fetchMock: { mock: { calls: unknown[][] } }): unknown {
  const init = fetchMock.mock.calls[0]?.[1] as { method: string; body: string };
  expect(init.method).toBe('PATCH');
  return JSON.parse(init.body);
}

describe('/caco.session-pin', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    showToast.mockClear();
    cached.sessions = [];
    setActiveSession('s1', '/repo');
  });

  it('pins with 📌 by default', async () => {
    const fetchMock = stubFetch();
    await findCommand('caco.session-pin')!.handler('');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/s1');
    expect(patchBody(fetchMock)).toEqual({ folder: '📌' });
    expect(showToast).toHaveBeenCalledWith('Pinned', { type: 'success', autoHideMs: 3000 });
  });

  it('pins with a custom emoji, even when the session is not cached', async () => {
    const fetchMock = stubFetch();
    await findCommand('session-pin')!.handler(' ⭐ ');
    expect(patchBody(fetchMock)).toEqual({ folder: '⭐' });
  });

  it('rejects a non-emoji argument without a request', async () => {
    const fetchMock = stubFetch();
    await findCommand('caco.session-pin')!.handler('work');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Usage: /session-pin [emoji]');
  });

  it('does not PATCH when the session already has that glyph', async () => {
    cached.sessions = [{ sessionId: 's1', folder: '📌' }];
    const fetchMock = stubFetch();
    await findCommand('caco.session-pin')!.handler('');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Already pinned');
  });

  it('changes a pinned session to a different glyph', async () => {
    cached.sessions = [{ sessionId: 's1', folder: '📌' }];
    const fetchMock = stubFetch();
    await findCommand('caco.session-pin')!.handler('🔥');
    expect(patchBody(fetchMock)).toEqual({ folder: '🔥' });
  });

  it('reports server errors', async () => {
    stubFetch(false);
    await findCommand('caco.session-pin')!.handler('');
    expect(showToast).toHaveBeenCalledWith('bad folder');
  });

  it('needs an active session', async () => {
    setActiveSession(null, '');
    const fetchMock = stubFetch();
    await findCommand('caco.session-pin')!.handler('');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('No active session');
  });
});
