// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * pager.html?portal=1 (spec-portal-pager P7): the board comes from the portal's
 * merged view through window.parent.cacoPortalPager, and actions go back through
 * it. In jsdom the top window is its own parent, so the fake bridge lives there.
 */
const page = readFileSync(join(process.cwd(), 'public', 'pager.html'), 'utf8');
const bodyHtml = /<body>([\s\S]*?)<script>/.exec(page)![1];
const scriptBody = /<script>([\s\S]*)<\/script>/.exec(page)![1];

interface Call { kind: string; key: string; text?: string }
let calls: Call[] = [];
let push: ((v: unknown) => void) | null = null;
let nextResult: { ok: boolean; status?: number; error?: string } = { ok: true };
let fetched = 0;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(r => setTimeout(r, 0));
};

function settle(): Promise<void> {
  if (nextResult.ok) return Promise.resolve();
  return Promise.reject(Object.assign(new Error(nextResult.error || 'boom'), { status: nextResult.status }));
}

function boot(): void {
  window.history.replaceState(null, '', '/pager.html?portal=1');
  document.body.innerHTML = bodyHtml;
  calls = []; push = null; nextResult = { ok: true }; fetched = 0;
  globalThis.fetch = (() => { fetched++; return new Promise(() => {}); }) as unknown as typeof fetch;
  (window as unknown as Record<string, unknown>).cacoPortalPager = {
    subscribe(cb: (v: unknown) => void) { push = cb; return () => {}; },
    send(key: string, text: string) { calls.push({ kind: 'send', key, text }); return settle(); },
    dismiss(key: string) { calls.push({ kind: 'dismiss', key }); return settle(); },
    open(key: string) { calls.push({ kind: 'open', key }); },
  };
  new Function(scriptBody)();
}

const card = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1', name: 'alpha', cwd: '/r', idleAt: new Date().toISOString(), options: ['Yes', 'No'],
  key: 'b1:s1', instanceId: 'b1', instanceName: 'devbox1', ...over,
});

const merged = (waiting: unknown[], extra: Record<string, unknown> = {}) => ({
  busy: [], waiting, waitingTruncated: false, portalOrigin: 'http://localhost:53000',
  instances: [{ id: 'b1', name: 'devbox1', status: 'live' }], ...extra,
});

async function deliver(v: unknown): Promise<void> { push!(v); await flush(); }

const cards = (): HTMLElement[] => [...document.querySelectorAll('.card')] as HTMLElement[];

beforeEach(async () => { boot(); await flush(); });
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).cacoPortalPager;
  window.history.replaceState(null, '', '/');
});

describe('pager.html portal mode', () => {
  it('subscribes to the portal bridge instead of polling', () => {
    expect(push).not.toBeNull();
    expect(fetched).toBe(0);
  });

  it('labels cards by instance and keys them by instance and session', async () => {
    await deliver(merged([card(), card({ key: 'local:s1', instanceId: 'local', instanceName: 'laptop' })]));
    expect(cards().map(c => c.getAttribute('data-session'))).toEqual(['b1:s1', 'local:s1']);
    expect(cards().map(c => c.querySelector('.inst')!.textContent)).toEqual(['devbox1', 'laptop']);
  });

  it('stages an option and sends it through the bridge to the keyed instance', async () => {
    await deliver(merged([card()]));
    (cards()[0].querySelector('.option') as HTMLButtonElement).click();
    (cards()[0].querySelector('.send') as HTMLButtonElement).click();
    await flush();
    expect(calls).toEqual([{ kind: 'send', key: 'b1:s1', text: 'Yes' }]);
    expect(cards()).toHaveLength(0);
  });

  it('dismisses through the bridge', async () => {
    await deliver(merged([card()]));
    (cards()[0].querySelector('.dismiss') as HTMLButtonElement).click();
    await flush();
    expect(calls).toEqual([{ kind: 'dismiss', key: 'b1:s1' }]);
  });

  it('keeps the card and draft when a bridge send fails', async () => {
    nextResult = { ok: false, status: 0, error: 'devbox1 did not answer' };
    await deliver(merged([card()]));
    const well = cards()[0].querySelector('.well') as HTMLTextAreaElement;
    well.value = 'my words';
    well.dispatchEvent(new Event('input', { bubbles: true }));
    (cards()[0].querySelector('.send') as HTMLButtonElement).click();
    await flush();
    expect(cards()).toHaveLength(1);
    expect(cards()[0].querySelector('.card-msg')!.textContent).toBe('Send failed: devbox1 did not answer');
    await deliver(merged([card()], { busy: [{ sessionId: 'x', name: 'other', key: 'b1:x', instanceName: 'devbox1' }] }));
    expect((cards()[0].querySelector('.well') as HTMLTextAreaElement).value).toBe('my words');
  });

  it('drafts are per instance: the same session id on two instances does not share text', async () => {
    await deliver(merged([card(), card({ key: 'b2:s1', instanceId: 'b2', instanceName: 'devbox2' })]));
    const w0 = cards()[0].querySelector('.well') as HTMLTextAreaElement;
    w0.value = 'only here';
    w0.dispatchEvent(new Event('input', { bubbles: true }));
    w0.blur();
    await deliver(merged([card(), card({ key: 'b2:s1', instanceId: 'b2', instanceName: 'devbox2', name: 'renamed' })]));
    expect((cards()[0].querySelector('.well') as HTMLTextAreaElement).value).toBe('only here');
    expect((cards()[1].querySelector('.well') as HTMLTextAreaElement).value).toBe('');
  });

  it('clicking the session name opens it through the portal', async () => {
    await deliver(merged([card()]));
    (cards()[0].querySelector('.name') as HTMLElement).click();
    expect(calls).toEqual([{ kind: 'open', key: 'b1:s1' }]);
  });

  it('shows busy rows with their instance and a row per non-live instance', async () => {
    await deliver(merged([], {
      busy: [{ sessionId: 'x', name: 'build', key: 'b1:x', instanceName: 'devbox1' }],
      instances: [
        { id: 'b1', name: 'devbox1', status: 'live' },
        { id: 'b2', name: 'devbox2', status: 'unreachable' },
        { id: 'b3', name: 'devbox3', status: 'refused' },
      ],
    }));
    const rows = [...document.querySelectorAll('.run-row')].map(r => r.textContent);
    expect(rows).toEqual(['devbox1build']);
    const inst = [...document.querySelectorAll('.inst-row')].map(r => r.textContent);
    expect(inst[0]).toBe('devbox2: unreachable');
    expect(inst[1]).toContain('CACO_PORTAL_ORIGINS=http://localhost:53000');
    expect(document.getElementById('conn')!.textContent).toBe('1 of 3 instances live');
  });
});
