// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Drives public/pager.html in a real DOM (spec-pager-freeform).
 *
 * The page is deliberately build-free, so it is not importable — the harness
 * evaluates its inline IIFE instead. Two traps this is shaped around:
 *  - `fetch` must be stubbed BEFORE evaluation, because the IIFE calls poll() at
 *    load.
 *  - the poll re-arms itself on every response, so a stub that always resolves
 *    spins forever. Here a GET parks until the test hands it a view, which makes
 *    each `deliver()` cause exactly one render and leaves exactly one poll
 *    outstanding.
 */
const page = readFileSync(join(process.cwd(), 'public', 'pager.html'), 'utf8');
const bodyHtml = /<body>([\s\S]*?)<script>/.exec(page)![1];
const scriptBody = /<script>([\s\S]*)<\/script>/.exec(page)![1];

interface ParkedPoll { resolve: (r: unknown) => void }
interface PostCall { url: string; body: Record<string, unknown> }

let parked: ParkedPoll[] = [];
let posts: PostCall[] = [];
let postReply: { status: number; error?: string } = { status: 200 };
let parkPosts = false;
let parkedPosts: Array<(r: unknown) => void> = [];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(r => setTimeout(r, 0));
};

function boot(): void {
  document.body.innerHTML = bodyHtml;
  parked = [];
  posts = [];
  postReply = { status: 200 };
  parkPosts = false;
  parkedPosts = [];

  globalThis.fetch = ((url: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === 'POST') {
      posts.push({ url, body: JSON.parse(opts.body || '{}') as Record<string, unknown> });
      const ok = postReply.status >= 200 && postReply.status < 300;
      const reply = {
        ok, status: postReply.status,
        json: () => Promise.resolve(ok ? {} : { error: postReply.error || 'boom' }),
      };
      if (parkPosts) return new Promise(resolve => { parkedPosts.push(resolve); });
      return Promise.resolve(reply);
    }
    return new Promise(resolve => { parked.push({ resolve }); });
  }) as unknown as typeof fetch;

  new Function(scriptBody)();
}

/** Resolve the outstanding poll with `view`, then let the page render. */
async function deliver(view: Record<string, unknown>): Promise<void> {
  const next = parked.shift();
  if (!next) throw new Error('no poll outstanding');
  next.resolve({ ok: true, status: 200, json: () => Promise.resolve(view) });
  await flush();
}

let version = 0;
const view = (waiting: unknown[], busy: unknown[] = []): Record<string, unknown> =>
  ({ version: ++version, busy, busyCount: busy.length, waiting });

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: 's-1', name: 'alpha', cwd: '/repo', idleAt: new Date().toISOString(),
  options: ['Do the first thing', 'Do the second thing'], ...over,
});

const cards = (): HTMLElement[] => [...document.querySelectorAll('.card')] as HTMLElement[];
const well = (i = 0): HTMLTextAreaElement | null => cards()[i]?.querySelector('.well') ?? null;
const sendBtn = (i = 0): HTMLButtonElement | null => cards()[i]?.querySelector('.send') ?? null;
const dismissBtn = (i = 0): HTMLButtonElement | null => cards()[i]?.querySelector('.dismiss') ?? null;

async function type(text: string, i = 0): Promise<void> {
  const w = well(i)!;
  w.value = text;
  w.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

beforeEach(() => { boot(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('pager page harness', () => {
  it('renders a card with its option buttons', async () => {
    await deliver(view([entry()]));

    expect(cards()).toHaveLength(1);
    const opts = [...cards()[0].querySelectorAll('.option')].map(b => b.textContent);
    expect(opts).toEqual(['Do the first thing', 'Do the second thing']);
  });

  it('leaves exactly one poll outstanding after each render', async () => {
    await deliver(view([entry()]));
    expect(parked).toHaveLength(1);
  });
});

describe('the free-text well', () => {
  it('offers a well with the something-else placeholder on a card with options', async () => {
    await deliver(view([entry()]));

    expect(well()).not.toBeNull();
    expect(well()!.placeholder).toContain('something else');
  });

  it('sits between the options and the action row', async () => {
    // Send lives in the foot, so the well must be directly above it for the two
    // to read as one control.
    await deliver(view([entry()]));
    const kids = [...cards()[0].children].map(n => n.className);

    expect(kids.indexOf('options')).toBeLessThan(kids.indexOf('well-wrap'));
    expect(kids.indexOf('well-wrap')).toBeLessThan(kids.indexOf('card-foot'));
  });

  it('hides Send until there is something to send', async () => {
    await deliver(view([entry()]));
    expect(sendBtn()!.hidden).toBe(true);

    await type('   ');
    expect(sendBtn()!.hidden).toBe(true);

    await type('do something else');
    expect(sendBtn()!.hidden).toBe(false);

    await type('');
    expect(sendBtn()!.hidden).toBe(true);
  });

  it('sends the trimmed text to that card own session and takes the card away', async () => {
    await deliver(view([entry({ sessionId: 'sess-abc' })]));
    await type('  do something else  ');

    sendBtn()!.click();
    await flush();

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/sessions/sess-abc/messages');
    expect(posts[0].body).toEqual({ prompt: 'do something else' });
    expect(cards()).toHaveLength(0);
  });

  it('locks the well and every button while a send is in flight', async () => {
    await deliver(view([entry()]));
    await type('hello');
    const w = well()!, s = sendBtn()!, d = dismissBtn()!;
    const opt = cards()[0].querySelector('.option') as HTMLButtonElement;

    // Hold the POST open so the in-flight state is observable.
    let release: () => void = () => {};
    globalThis.fetch = (() => new Promise(res => {
      release = () => res({ ok: true, status: 200, json: () => Promise.resolve({}) });
    })) as unknown as typeof fetch;

    s.click();
    await flush();

    expect([w.disabled, s.disabled, d.disabled, opt.disabled]).toEqual([true, true, true, true]);
    release();
  });
});

describe('drafts survive anything the user did not do', () => {
  it('keeps the text when the board rebuilds', async () => {
    await deliver(view([entry()]));
    await type('half a sentence');

    // Any other session going busy re-renders the whole board.
    await deliver(view([entry()], [{ sessionId: 's-9', name: 'other' }]));

    expect(well()!.value).toBe('half a sentence');
    expect(sendBtn()!.hidden).toBe(false);
  });

  it('re-grows a restored draft so a multi-line message is not clipped', async () => {
    // jsdom has no layout, so this pins that the auto-grow ran on restore (it
    // sets height to 'auto' before measuring) rather than the resulting pixels.
    // The visual result is covered by manual signoff, but the regression this
    // catches — a restored draft left in a one-row, overflow:hidden box — is the
    // one that makes surviving text look lost.
    await deliver(view([entry()]));
    await type('line one\nline two\nline three');

    await deliver(view([entry()], [{ sessionId: 's-9', name: 'other' }]));

    expect(well()!.value).toBe('line one\nline two\nline three');
    expect(well()!.style.height).toBe('auto');
  });

  it('keeps the text when the session briefly leaves the board and returns', async () => {
    // The busy blip is why drafts are not pruned like `acted`: another client
    // sending would otherwise delete text this user is still writing.
    await deliver(view([entry()]));
    await type('half a sentence');

    await deliver(view([], [{ sessionId: 's-1', name: 'alpha' }]));
    expect(cards()).toHaveLength(0);

    await deliver(view([entry()]));
    expect(well()!.value).toBe('half a sentence');
  });

  it('drops the draft once the message is actually sent', async () => {
    await deliver(view([entry()]));
    await type('sent text');
    sendBtn()!.click();
    await flush();

    // The send makes the session busy, so it leaves the board and the local
    // suppression lifts; it returns later holding a fresh offer.
    await deliver(view([], [{ sessionId: 's-1', name: 'alpha' }]));
    await deliver(view([entry()]));

    expect(well()!.value).toBe('');
    expect(sendBtn()!.hidden).toBe(true);
  });

  it('drops the draft when the card is dismissed', async () => {
    await deliver(view([entry()]));
    await type('abandoned text');
    dismissBtn()!.click();
    await flush();

    await deliver(view([]));
    await deliver(view([entry()]));

    expect(well()!.value).toBe('');
  });
});

describe('the board holds still while the user is typing', () => {
  const other = { sessionId: 's-9', name: 'other' };

  async function focusWell(): Promise<HTMLTextAreaElement> {
    const w = well()!;
    w.focus();
    await flush();
    expect(document.activeElement).toBe(w);
    return w;
  }

  it('keeps running rows live while the board is held', async () => {
    // The page must not look frozen: only the board is deferred.
    await deliver(view([entry()]));
    await focusWell();

    await deliver(view([entry({ name: 'renamed' })], [other]));

    expect([...document.querySelectorAll('.run-name')].map(n => n.textContent)).toEqual(['other']);
    expect(cards()[0].querySelector('.name')!.textContent).toBe('alpha');
  });

  it('does not rebuild the board or move focus while a well is focused', async () => {
    await deliver(view([entry()]));
    const w = await focusWell();
    await type('mid sentence');

    await deliver(view([entry()], [other]));

    expect(well()).toBe(w);
    expect(document.activeElement).toBe(w);
    expect(w.value).toBe('mid sentence');
  });

  it('applies the stashed view once focus leaves', async () => {
    await deliver(view([entry()]));
    const w = await focusWell();
    await deliver(view([entry({ name: 'renamed' })]));
    expect(cards()[0].querySelector('.name')!.textContent).toBe('alpha');

    w.blur();
    await flush();

    expect(cards()[0].querySelector('.name')!.textContent).toBe('renamed');
  });

  it('keeps only the newest stashed view, not a queue', async () => {
    await deliver(view([entry()]));
    const w = await focusWell();

    await deliver(view([entry({ name: 'first' })]));
    await deliver(view([entry({ name: 'second' })]));
    await deliver(view([entry({ name: 'third' })]));
    w.blur();
    await flush();

    expect(cards()[0].querySelector('.name')!.textContent).toBe('third');
  });

  it('stays held when focus moves between two wells', async () => {
    await deliver(view([entry({ sessionId: 's-1' }), entry({ sessionId: 's-2', name: 'beta' })]));
    well(0)!.focus();
    await flush();
    // Stash something first: without a pending view, releasing the hold is a
    // no-op and a missing re-check would go unnoticed.
    await deliver(view([entry({ sessionId: 's-1', name: 'renamed' }), entry({ sessionId: 's-2', name: 'beta' })]));
    expect(cards()[0].querySelector('.name')!.textContent).toBe('alpha');

    const second = well(1)!;
    second.focus();
    await flush();

    // focusout fires before the next element takes focus, so releasing without
    // re-checking would rebuild the board out from under the user mid-move.
    expect(cards()[0].querySelector('.name')!.textContent).toBe('alpha');
    expect(document.activeElement).toBe(second);
  });

  it('only a well on the board holds the board', async () => {
    // Scoping the predicate to the board keeps an unrelated textarea elsewhere on
    // the page from freezing triage if one is ever added.
    await deliver(view([entry()]));
    const stray = document.createElement('textarea');
    stray.className = 'well';
    document.body.appendChild(stray);
    stray.focus();
    await flush();

    await deliver(view([entry({ name: 'renamed' })]));

    expect(cards()[0].querySelector('.name')!.textContent).toBe('renamed');
    stray.remove();
  });

  it('does not prune the acted suppression from a board render it skipped', async () => {
    // The prune belongs with the draw, not with every response. If it ran on a
    // view whose cards were never rendered, a card the user just dismissed would
    // lose its suppression and reappear.
    await deliver(view([entry({ sessionId: 's-1' }), entry({ sessionId: 's-2', name: 'beta' })]));
    dismissBtn(0)!.click();
    await flush();
    expect(cards()).toHaveLength(1);

    well(0)!.focus();
    await flush();
    // Skipped while held — this is the view that would prune s-1's suppression.
    await deliver(view([entry({ sessionId: 's-2', name: 'beta' })]));
    // s-1 is back in the newest view, which is the one that will actually apply.
    await deliver(view([entry({ sessionId: 's-1' }), entry({ sessionId: 's-2', name: 'beta' })]));
    well(0)!.blur();
    await flush();

    expect(cards()).toHaveLength(1);
    expect(cards()[0].querySelector('.name')!.textContent).toBe('beta');
  });

  it('cannot wedge when the focused well is removed by something else', async () => {
    // The hold is a predicate over live DOM, not a flag, so a focused node that
    // disappears must not strand the board.
    await deliver(view([entry()]));
    const w = await focusWell();
    w.remove();

    await deliver(view([entry({ name: 'renamed' })]));

    expect(cards()[0].querySelector('.name')!.textContent).toBe('renamed');
  });

  it('releases the hold when the page is hidden', async () => {
    await deliver(view([entry()]));
    await focusWell();
    await deliver(view([entry({ name: 'renamed' })]));

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(cards()[0].querySelector('.name')!.textContent).toBe('renamed');
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('releases the hold after the maximum duration with no event at all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      boot();
      await deliver(view([entry()]));
      await focusWell();
      await deliver(view([entry({ name: 'renamed' })]));
      expect(cards()[0].querySelector('.name')!.textContent).toBe('alpha');

      await vi.advanceTimersByTimeAsync(60_000);
      await flush();

      expect(cards()[0].querySelector('.name')!.textContent).toBe('renamed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a failed send does not cost the user their typing', () => {
  it('keeps the draft and re-enables the controls on an unexpected failure', async () => {
    await deliver(view([entry()]));
    await type('precious text');
    postReply = { status: 500, error: 'server exploded' };

    sendBtn()!.click();
    await flush();

    expect(cards()).toHaveLength(1);
    expect(well()!.value).toBe('precious text');
    expect(well()!.disabled).toBe(false);
    expect(sendBtn()!.disabled).toBe(false);
    expect(cards()[0].querySelector('.card-msg')!.textContent).toContain('server exploded');

    // The live textarea keeps its value whether or not the draft was stored, so
    // only a rebuild proves the text would actually survive.
    await deliver(view([entry()]));
    expect(well()!.value).toBe('precious text');
  });

  it('cannot be sent twice when a background view rebuilds the board mid-flight', async () => {
    // Tapping Send blurs the well, which releases the hold and rebuilds the
    // board — while the POST is still in flight. A rebuilt card is a fresh node
    // that never saw lock(true), so without suppressing the card at the moment
    // the action starts, the second tap delivers a duplicate message.
    await deliver(view([entry()]));
    well()!.focus();
    await flush();
    await type('once only');
    await deliver(view([entry()], [{ sessionId: 's-9', name: 'other' }]));

    parkPosts = true;
    well()!.blur();
    sendBtn()!.click();
    await flush();

    expect(posts).toHaveLength(1);
    const stillThere = sendBtn();
    if (stillThere && !stillThere.hidden) {
      stillThere.click();
      await flush();
    }
    expect(posts).toHaveLength(1);

    parkedPosts.forEach(r => r({ ok: true, status: 200, json: () => Promise.resolve({}) }));
    await flush();
  });

  it('takes the card away when the session is already busy or gone', async () => {
    await deliver(view([entry()]));
    await type('too late');
    postReply = { status: 409 };

    sendBtn()!.click();
    await flush();

    expect(cards()).toHaveLength(0);
  });

  it('keeps the text after a 409, because the message was never delivered', async () => {
    // A 409 is the session being busy, not the user resolving the card. Treating
    // it like a successful send would destroy typing over something the user did
    // not do.
    await deliver(view([entry()]));
    await type('never delivered');
    postReply = { status: 409 };
    sendBtn()!.click();
    await flush();

    await deliver(view([], [{ sessionId: 's-1', name: 'alpha' }]));
    await deliver(view([entry()]));

    expect(well()!.value).toBe('never delivered');
  });
});
