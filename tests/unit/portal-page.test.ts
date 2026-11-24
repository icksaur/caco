import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * portal.html under the hub proxy (spec-portal-single-port, Phase C / A8). Runs
 * the page's real inline script in jsdom against a stubbed server.
 */

const HUB = 'http://localhost:53000';
const P1 = { url: 'http://localhost:53001', hostname: 'one', name: 'one', origin: 'http://localhost:53001', addedBy: 'portal', proxyPath: '/peer/AAA/' };
const P2 = { url: 'http://localhost:53002', hostname: 'two', name: 'two', origin: 'http://localhost:53002', addedBy: 'portal', proxyPath: '/peer/BBB/' };
const RAW = { url: 'http://10.0.0.9:53000', hostname: 'far', name: 'far', origin: 'http://10.0.0.9:53000', addedBy: 'portal' };

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); dom = undefined; });

async function loadPortal(serverPeers: unknown[] = [P1, P2, RAW], stored?: unknown[]) {
  const html = readFileSync(join(__dirname, '../../public/portal.html'), 'utf8')
    .replace(/<script type="module"[^>]*><\/script>/, '');
  const calls: Array<{ url: string; method: string }> = [];
  dom = new JSDOM(html, {
    url: `${HUB}/portal.html`,
    runScripts: 'dangerously',
    beforeParse(window) {
      if (stored) window.localStorage.setItem('caco:portal:peers', JSON.stringify(stored));
      (window as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string, init?: { method?: string }) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET' });
        if (String(url) === '/api/peers' && (init?.method ?? 'GET') === 'GET') return { ok: true, json: async () => serverPeers };
        if (String(url).endsWith('/export')) return { ok: true, blob: async () => 'tar' };
        return { ok: true, status: 200, json: async () => ({}) };
      });
      window.alert = () => {};
    },
  });
  await new Promise(r => setTimeout(r, 30));
  const w = dom.window;
  const frame = (name: string) => {
    const peers = JSON.parse(w.localStorage.getItem('caco:portal:peers')!) as Array<{ id: string; name: string }>;
    const id = peers.find(p => p.name === name)!.id;
    return { id, el: w.document.getElementById('frame-' + id) as HTMLIFrameElement };
  };
  const post = (source: unknown, data: unknown) =>
    w.dispatchEvent(new w.MessageEvent('message', { data, origin: HUB, source: source as Window }));
  return { w, calls, frame, post };
}

describe('portal frames through the hub proxy', () => {
  it('loads proxyable peers at their proxyPath and others at their own URL', async () => {
    const { frame, w } = await loadPortal();
    expect(frame('one').el.getAttribute('src')).toBe('/peer/AAA/');
    expect(frame('two').el.getAttribute('src')).toBe('/peer/BBB/');
    expect(frame('far').el.getAttribute('src')).toBe('http://10.0.0.9:53000');
    const icons = [...w.document.querySelectorAll<HTMLImageElement>('.peer-icon')].map(i => i.getAttribute('src'));
    expect(icons).toContain('/peer/AAA/api/favicon');
    expect(icons).toContain('http://10.0.0.9:53000/api/favicon');
  });

  it('re-points a stored frame when the server reports a proxyPath', async () => {
    const { frame } = await loadPortal([P1], [{ id: 'local', url: HUB, name: 'local' }, { id: 'x1', url: 'http://localhost:53001', name: 'one' }]);
    expect(frame('one').el.getAttribute('src')).toBe('/peer/AAA/');
  });

  it('gives the merged pager each frame\'s real origin', async () => {
    const { w } = await loadPortal();
    const peers = (w as unknown as { cacoPortal: { getPeers(): Array<{ name: string; frameOrigin: string }> } }).cacoPortal.getPeers();
    expect(Object.fromEntries(peers.map(p => [p.name, p.frameOrigin]))).toMatchObject({ one: HUB, two: HUB, far: 'http://10.0.0.9:53000' });
  });

  it('attributes status messages by sending window, not origin', async () => {
    const { w, frame, post } = await loadPortal();
    const two = frame('two');
    post(two.el.contentWindow, { type: 'caco:status', busyCount: 1, unobservedCount: 0, hostname: 'two' });
    post({}, { type: 'caco:status', busyCount: 0, unobservedCount: 3, hostname: 'intruder' });
    expect(w.document.getElementById('badge-' + two.id)!.classList.contains('busy')).toBe(true);
    expect(w.document.getElementById('badge-' + frame('one').id)!.className).toBe('peer-badge');
    expect(w.document.body.textContent).not.toContain('intruder');
  });

  it('transfers a dragged session between two proxied peers through the proxy', async () => {
    const { w, calls, frame, post } = await loadPortal();
    post(frame('one').el.contentWindow, { type: 'caco:transfer:dragstart', sessionId: 's1', sessionName: 'S' });
    const target = w.document.querySelector<HTMLElement>(`.peer[data-id="${frame('two').id}"]`)!;
    target.dispatchEvent(new w.Event('drop', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 30));
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(expect.arrayContaining([
      'GET /peer/AAA/api/sessions/s1/export',
      'POST /peer/BBB/api/sessions/import?force=true',
    ]));
  });

  it('only the dragging frame can end its drag', async () => {
    const { w, calls, frame, post } = await loadPortal();
    post(frame('one').el.contentWindow, { type: 'caco:transfer:dragstart', sessionId: 's1', sessionName: 'S' });
    post(frame('far').el.contentWindow, { type: 'caco:transfer:dragend' });
    w.document.querySelector<HTMLElement>(`.peer[data-id="${frame('two').id}"]`)!.dispatchEvent(new w.Event('drop', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 30));
    expect(calls.some(c => c.url === '/peer/AAA/api/sessions/s1/export')).toBe(true);
  });

  it('keeps a stored peer at its own URL when the server offers no proxyPath', async () => {
    const stored = [{ id: 'local', url: HUB, name: 'local' }, { id: 'x1', url: 'http://localhost:53001', name: 'one' }];
    const { w } = await loadPortal([], stored);
    expect(w.document.getElementById('frame-x1')!.getAttribute('src')).toBe('http://localhost:53001');
  });

  it('ignores a navigation request from an unknown window', async () => {
    const { frame, post } = await loadPortal();
    const target = frame('two').el.contentWindow!;
    const spy = vi.spyOn(target, 'postMessage');
    post({}, { type: 'caco:navigate', targetUrl: 'http://localhost:53002', sessionId: 's9' });
    expect(spy).not.toHaveBeenCalled();
    post(frame('one').el.contentWindow, { type: 'caco:navigate', targetUrl: 'http://localhost:53002', sessionId: 's9' });
    expect(spy).toHaveBeenCalledWith({ type: 'caco:navigateSession', sessionId: 's9' }, HUB);
  });

  it('ignores a drag from an unknown window', async () => {
    const { w, calls, frame, post } = await loadPortal();
    post({}, { type: 'caco:transfer:dragstart', sessionId: 's1', sessionName: 'S' });
    w.document.querySelector<HTMLElement>(`.peer[data-id="${frame('two').id}"]`)!.dispatchEvent(new w.Event('drop', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 30));
    expect(calls.some(c => c.url.endsWith('/export'))).toBe(false);
  });
});
