import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withBase, storageKey } from '../../public/ts/base-path.js';
import { pageBasePath, injectPageBase, FETCH_WRAPPER_JS } from '../../src/page-base.js';
import { globSync } from 'node:fs';

const B = '/peer/abc/';

describe('withBase (spec-portal-single-port A1)', () => {
  it('prefixes root-absolute paths under a base', () => {
    expect(withBase('/api/x?y=1', B)).toBe('/peer/abc/api/x?y=1');
    expect(withBase('/', B)).toBe('/peer/abc/');
    expect(withBase('/?session=s', B)).toBe('/peer/abc/?session=s');
  });

  it.each(['api/x', '//h/x', 'http://h/x', 'data:x', 'blob:x', '/peer/abc/api/x'])('leaves %s unchanged', u => {
    expect(withBase(u, B)).toBe(u);
  });

  it('is a no-op at /', () => {
    expect(withBase('/api/x', '/')).toBe('/api/x');
    expect(withBase('/api/x')).toBe('/api/x');
  });

  it('namespaces storage keys only under a prefix', () => {
    expect(storageKey('caco:collapsed-folders', '/')).toBe('caco:collapsed-folders');
    expect(storageKey('caco:collapsed-folders', B)).toBe('caco:collapsed-folders@/peer/abc/');
  });
});

describe('page base injection (A3)', () => {
  it('accepts only a valid header', () => {
    expect(pageBasePath('/peer/aHR0cDovL2xvY2FsaG9zdDo1MzAwMQ/')).toBe('/peer/aHR0cDovL2xvY2FsaG9zdDo1MzAwMQ/');
    for (const bad of [undefined, '', '/', '/peer/', '/peer/a b/', '/peer/a', '/x/a/', '/peer/a/../', '/peer/%3A/', '/peer/a"/']) {
      expect(pageBasePath(bad)).toBe('/');
    }
    expect(pageBasePath(['/peer/k/', '/peer/z/'])).toBe('/peer/k/');
  });

  it('leaves the page unchanged at / and injects base, CACO_BASE and the wrapper first otherwise', () => {
    const html = '<!DOCTYPE html><html><head><title>x</title><script src="a.js"></script></head></html>';
    expect(injectPageBase(html, '/')).toBe(html);
    const out = injectPageBase(html, B);
    expect(out.indexOf('<base href="/peer/abc/">')).toBe(out.indexOf('<head>') + '<head>'.length);
    expect(out).toContain('window.CACO_BASE="/peer/abc/"');
    expect(out.indexOf('window.fetch')).toBeLessThan(out.indexOf('<title>'));
  });
});

describe('fetch wrapper (A2)', () => {
  function sandbox(base: string | undefined) {
    const calls: unknown[] = [];
    class FakeRequest {
      url: string; method: string; headers: unknown; signal: unknown;
      constructor(input: string | FakeRequest, init?: Partial<FakeRequest>) {
        const src = typeof input === 'string' ? undefined : input;
        this.url = new URL(typeof input === 'string' ? input : input.url, 'http://hub:53000/peer/abc/').href;
        this.method = init?.method ?? src?.method ?? 'GET';
        this.headers = init?.headers ?? src?.headers;
        this.signal = init?.signal ?? src?.signal;
      }
    }
    const fetch = vi.fn((input: unknown) => { calls.push(input); return Promise.resolve('ok'); });
    const window: Record<string, unknown> = { CACO_BASE: base, fetch };
    runInNewContext(FETCH_WRAPPER_JS, { window, location: { href: 'http://hub:53000/peer/abc/?session=s', origin: 'http://hub:53000' }, URL, Request: FakeRequest });
    return { f: window.fetch as (i: unknown, init?: unknown) => Promise<unknown>, fetch, calls, FakeRequest };
  }

  it('is not installed without a base or at /', () => {
    for (const b of [undefined, '/']) {
      const s = sandbox(b);
      expect(s.f).toBe(s.fetch);
    }
  });

  it('prefixes same-origin root-absolute strings, URLs and Requests, never twice', async () => {
    const s = sandbox(B);
    await s.f('/api/sessions?x=1');
    await s.f('api/relative');
    await s.f('/peer/abc/api/already');
    await s.f(new URL('http://hub:53000/api/u'));
    await s.f(new URL('http://other:1/api/u'));
    await s.f('//other/api');
    const req = new s.FakeRequest('http://hub:53000/api/r', { method: 'POST', headers: { a: 1 } });
    await s.f(req);
    expect(s.calls.slice(0, 6)).toEqual([
      '/peer/abc/api/sessions?x=1', 'api/relative', '/peer/abc/api/already',
      '/peer/abc/api/u', new URL('http://other:1/api/u'), '//other/api',
    ]);
    const sent = s.calls[6] as InstanceType<typeof s.FakeRequest>;
    expect(sent.url).toBe('http://hub:53000/peer/abc/api/r');
    expect(sent.method).toBe('POST');
    expect(sent.headers).toEqual({ a: 1 });
  });

  it('installs once', () => {
    const s = sandbox(B);
    const first = s.f;
    runInNewContext(FETCH_WRAPPER_JS, { window: { CACO_BASE: B, fetch: first }, location: { href: 'http://hub:53000/', origin: 'http://hub:53000' }, URL });
    expect((first as unknown as { __cacoBase?: boolean }).__cacoBase).toBe(true);
  });
});

describe('no raw root-absolute URLs outside fetch (A4)', () => {
  const root = join(__dirname, '../..');
  const files = [
    ...globSync('public/ts/**/*.ts', { cwd: root }),
    'public/index.html', 'public/pager.html',
    ...globSync('applets/**/*.{js,html,css}', { cwd: root }).filter(f => !/codemirror-bundle/.test(f)),
  ];
  // A literal starting with "/<letter or ?>" in a non-fetch URL context.
  const CONTEXT = /(\bsrc\s*=|\bhref\s*=|url\(|\bimport\(|new WebSocket\(|location\.href\s*=|location\.assign\(|sendBeacon\()\s*[`'"]\/[A-Za-z?]/;
  const ATTR = /\b(src|href)=\\?"\/[A-Za-z?]/;

  it('finds none', () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(join(root, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/withBase|CACO_BASE/.test(line)) return;
        if (CONTEXT.test(line) || ATTR.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('catches a raw literal', () => {
    expect(CONTEXT.test("img.src = '/api/x';")).toBe(true);
    expect(CONTEXT.test('link.href = `/themes/${t}.css`;')).toBe(true);
    expect(CONTEXT.test("new WebSocket('/ws')")).toBe(true);
    expect(ATTR.test('<a href="/?session=1">')).toBe(true);
    expect(CONTEXT.test("img.src = 'api/x';")).toBe(false);
  });
});

describe('browser storage keys are classified (A6)', () => {
  const PER_INSTANCE = ['caco:collapsed-folders', 'ext:'];
  const SHARED = ['caco:theme', 'cacoDebug', 'caco:terminalPanelHeight', 'storageKey'];
  it('every key used in public/ts is per-instance (through storageKey) or shared on purpose', () => {
    const root = join(__dirname, '../..');
    const unknown: string[] = [];
    for (const f of globSync('public/ts/**/*.ts', { cwd: root })) {
      for (const m of readFileSync(join(root, f), 'utf8').matchAll(/(?:local|session)Storage\.(?:get|set|remove)Item\(([^,)]+)/g)) {
        const arg = m[1].trim();
        if (arg.startsWith('storageKey(')) continue;
        if ([...SHARED, ...PER_INSTANCE].some(k => arg.includes(k)) || /TERM_HEIGHT_KEY|STORAGE_KEY/.test(arg)) {
          if (PER_INSTANCE.some(k => arg.includes(k))) unknown.push(`${f}: ${arg} must use storageKey`);
          continue;
        }
        unknown.push(`${f}: ${arg}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
