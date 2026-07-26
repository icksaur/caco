import { describe, it, expect, afterAll } from 'vitest';
import { applyPluginDirectories } from '../../src/plugin-directories-apply.js';

describe('applyPluginDirectories', () => {
  const realFetch = globalThis.fetch;
  afterAll(() => { globalThis.fetch = realFetch; });

  it('PATCHes the target session and reports whether a recreate happened', async () => {
    let seen: { url: string; body: unknown } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) };
      return { ok: true, json: async () => ({ pluginDirectoriesRecreated: true }) };
    }) as unknown as typeof fetch;

    const r = await applyPluginDirectories('http://x', 'sess-1', ['/abs/p']);
    expect(r).toMatchObject({ ok: true, recreated: true });
    expect(seen!.url).toBe('http://x/api/sessions/sess-1');
    expect(seen!.body).toEqual({ pluginDirectories: ['/abs/p'] });
  });

  it('passes an empty array through as the explicit clear', async () => {
    let body: unknown = null;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return { ok: true, json: async () => ({ pluginDirectoriesChanged: true }) };
    }) as unknown as typeof fetch;

    await applyPluginDirectories('http://x', 'sess-1', []);
    expect(body).toEqual({ pluginDirectories: [] });
  });

  it('surfaces warnings from the route', async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ pluginWarnings: ['no plugin.json in /x'] }) })) as unknown as typeof fetch;
    const r = await applyPluginDirectories('http://x', 's', ['/x']);
    expect(r.warnings).toEqual(['no plugin.json in /x']);
  });

  it('returns the route error instead of throwing', async () => {
    globalThis.fetch = (async () => ({ ok: false, statusText: 'Bad Request', json: async () => ({ error: 'Not a directory: /x' }) })) as unknown as typeof fetch;
    const r = await applyPluginDirectories('http://x', 's', ['/x']);
    expect(r).toEqual({ ok: false, error: 'Not a directory: /x' });
  });

  it('returns a transport failure instead of throwing', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await applyPluginDirectories('http://x', 's', ['/x']);
    expect(r).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});
