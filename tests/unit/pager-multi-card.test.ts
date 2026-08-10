// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Multi-card behaviour of public/pager.html.
 *
 * The existing DOM suite renders exactly one card, so every draft assertion in
 * it is satisfiable by an implementation that keys drafts by position, or that
 * only ever preserves the first card. The board is inherently multi-card — the
 * reported symptom is losing text in one card when a DIFFERENT session
 * completes — so these drive two or more cards at once.
 */
const page = readFileSync(join(process.cwd(), 'public', 'pager.html'), 'utf8');
const bodyHtml = /<body>([\s\S]*?)<script>/.exec(page)![1];
const scriptBody = /<script>([\s\S]*)<\/script>/.exec(page)![1];

interface ParkedPoll { resolve: (r: unknown) => void }

let parked: ParkedPoll[] = [];
let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
/** When set, POSTs hang so a test can observe the in-flight window. */
let parkPosts = false;
let parkedPosts: Array<(r: unknown) => void> = [];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(r => setTimeout(r, 0));
};

/**
 * Flush under fake timers, where the real-timer flush would hang: microtasks
 * still settle on their own, but any pending timer has to be advanced.
 */
const flushFake = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

function boot(): void {
  document.body.innerHTML = bodyHtml;
  parked = [];
  posts = [];
  parkPosts = false;
  parkedPosts = [];
  globalThis.fetch = ((url: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === 'POST') {
      posts.push({ url, body: JSON.parse(opts.body || '{}') as Record<string, unknown> });
      const reply = { ok: true, status: 200, json: () => Promise.resolve({}) };
      if (parkPosts) return new Promise(resolve => { parkedPosts.push(resolve); });
      return Promise.resolve(reply);
    }
    return new Promise(resolve => { parked.push({ resolve }); });
  }) as unknown as typeof fetch;
  new Function(scriptBody)();
}

async function deliver(view: Record<string, unknown>): Promise<void> {
  const next = parked.shift();
  if (!next) throw new Error('no poll outstanding');
  next.resolve({ ok: true, status: 200, json: () => Promise.resolve(view) });
  await (vi.isFakeTimers() ? flushFake() : flush());
}

let version = 0;
const view = (waiting: unknown[], busy: unknown[] = []): Record<string, unknown> =>
  ({ version: ++version, busy, busyCount: busy.length, waiting });

const entry = (id: string, name: string): Record<string, unknown> => ({
  sessionId: id, name, cwd: '/repo', idleAt: new Date().toISOString(),
  options: ['Do the first thing', 'Do the second thing'],
});

const cards = (): HTMLElement[] => [...document.querySelectorAll('.card')] as HTMLElement[];
/** The well belonging to a named session, by card identity rather than position. */
function wellOf(name: string): HTMLTextAreaElement {
  const card = cards().find(c => c.querySelector('.name')?.textContent === name);
  if (!card) throw new Error(`no card for ${name}; have: ${cards().map(c => c.querySelector('.name')?.textContent).join(',')}`);
  return card.querySelector('.well') as HTMLTextAreaElement;
}

async function typeInto(w: HTMLTextAreaElement, text: string): Promise<void> {
  w.value = text;
  w.dispatchEvent(new Event('input', { bubbles: true }));
  await (vi.isFakeTimers() ? flushFake() : flush());
}

beforeEach(() => { boot(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('another session completing while typing in a card', () => {
  it('keeps the text when the completing session joins the board', async () => {
    // alpha is waiting; beta is still running.
    await deliver(view([entry('s-1', 'alpha')], [{ sessionId: 's-2', name: 'beta' }]));
    await typeInto(wellOf('alpha'), 'a careful message');

    // beta completes: it leaves the running list and joins the board.
    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));

    expect(wellOf('alpha').value).toBe('a careful message');
    expect(wellOf('beta').value).toBe('');
  });

  it('keeps the text of a focused card, and of an unfocused one, in the same rebuild', async () => {
    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));
    await typeInto(wellOf('alpha'), 'alpha text');
    await typeInto(wellOf('beta'), 'beta text');
    wellOf('beta').focus();

    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta'), entry('s-3', 'gamma')]));

    expect(wellOf('alpha').value).toBe('alpha text');
    expect(wellOf('beta').value).toBe('beta text');
  });

  it('keeps each card text when the completing session is ordered FIRST', async () => {
    // Server ordering can put the newcomer above the card being typed in, so a
    // draft restored by position rather than session id would swap the two.
    await deliver(view([entry('s-1', 'alpha')]));
    await typeInto(wellOf('alpha'), 'belongs to alpha');

    await deliver(view([entry('s-2', 'beta'), entry('s-1', 'alpha')]));

    expect(wellOf('alpha').value).toBe('belongs to alpha');
    expect(wellOf('beta').value).toBe('');
  });

  it('does not rebuild the board while a well is focused, even as others complete', async () => {
    await deliver(view([entry('s-1', 'alpha')], [{ sessionId: 's-2', name: 'beta' }]));
    const w = wellOf('alpha');
    await typeInto(w, 'mid sentence');
    w.focus();

    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));

    // The held board still shows only alpha, and the caret is untouched.
    expect(cards()).toHaveLength(1);
    expect(document.activeElement).toBe(w);
    expect(w.value).toBe('mid sentence');
    // The running list is still live even while the board is held.
    expect(document.querySelectorAll('.run-row')).toHaveLength(0);
  });

  it('restores every draft once the hold is released', async () => {
    await deliver(view([entry('s-1', 'alpha')], [{ sessionId: 's-2', name: 'beta' }]));
    const w = wellOf('alpha');
    await typeInto(w, 'mid sentence');
    w.focus();
    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));

    w.blur();
    await flush();

    expect(cards()).toHaveLength(2);
    expect(wellOf('alpha').value).toBe('mid sentence');
  });

  it('sends the right text to the right session when several cards hold drafts', async () => {
    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));
    await typeInto(wellOf('alpha'), 'for alpha');
    await typeInto(wellOf('beta'), 'for beta');

    const betaCard = cards().find(c => c.querySelector('.name')?.textContent === 'beta')!;
    (betaCard.querySelector('.send') as HTMLButtonElement).click();
    await flush();

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain('s-2');
    expect(posts[0].body.prompt).toBe('for beta');
  });

  it('leaves the other card draft intact after one card is sent', async () => {
    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));
    await typeInto(wellOf('alpha'), 'for alpha');
    await typeInto(wellOf('beta'), 'for beta');

    const betaCard = cards().find(c => c.querySelector('.name')?.textContent === 'beta')!;
    (betaCard.querySelector('.send') as HTMLButtonElement).click();
    await flush();
    await deliver(view([entry('s-1', 'alpha')]));

    expect(wellOf('alpha').value).toBe('for alpha');
  });

  it('leaves the other card draft intact after one card is dismissed', async () => {
    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));
    await typeInto(wellOf('alpha'), 'for alpha');
    await typeInto(wellOf('beta'), 'for beta');

    const betaCard = cards().find(c => c.querySelector('.name')?.textContent === 'beta')!;
    (betaCard.querySelector('.dismiss') as HTMLButtonElement).click();
    await flush();
    await deliver(view([entry('s-1', 'alpha')]));

    expect(wellOf('alpha').value).toBe('for alpha');
  });

  it('stages an option into its own card without touching another card draft', async () => {
    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));
    await typeInto(wellOf('alpha'), 'typed into alpha');

    const betaCard = cards().find(c => c.querySelector('.name')?.textContent === 'beta')!;
    (betaCard.querySelector('.option') as HTMLButtonElement).click();
    await flush();

    expect(wellOf('beta').value).toBe('Do the first thing');
    expect(wellOf('alpha').value).toBe('typed into alpha');
  });
});

/**
 * The hold is a backstop, not a lock: past MAX_HOLD_MS it applies the pending
 * view even though a well still has focus. The page's own comment accepts
 * losing "the caret and keyboard, never the text" — these pin down what that
 * actually costs, because a detached textarea still looks focused to a user
 * whose on-screen keyboard is open.
 */
describe('when the hold backstop expires mid-composition', () => {
  it('keeps the text already typed', async () => {    vi.useFakeTimers();
    try {
      await deliver(view([entry('s-1', 'alpha')], [{ sessionId: 's-2', name: 'beta' }]));
      const w = wellOf('alpha');
      await typeInto(w, 'a long message so far');
      w.focus();
      await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));

      await vi.advanceTimersByTimeAsync(61_000);

      expect(wellOf('alpha').value).toBe('a long message so far');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the textarea the user was typing into attached and focused', async () => {
    vi.useFakeTimers();
    try {
      await deliver(view([entry('s-1', 'alpha')], [{ sessionId: 's-2', name: 'beta' }]));
      const original = wellOf('alpha');
      await typeInto(original, 'a long message so far');
      original.focus();
      await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));

      await vi.advanceTimersByTimeAsync(61_000);

      // The backstop applies the pending view, so the newcomer appears — but the
      // node holding the caret is the same one, still in the document.
      expect(cards()).toHaveLength(2);
      expect(document.body.contains(original)).toBe(true);
      expect(wellOf('alpha')).toBe(original);
      expect(document.activeElement).toBe(original);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps recording keystrokes after the backstop fires', async () => {
    vi.useFakeTimers();
    try {
      await deliver(view([entry('s-1', 'alpha')], [{ sessionId: 's-2', name: 'beta' }]));
      const original = wellOf('alpha');
      await typeInto(original, 'first half');
      original.focus();
      await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));

      await vi.advanceTimersByTimeAsync(61_000);

      // The user keeps typing: on a phone the keyboard is still up and nothing
      // signalled a swap, so these keystrokes must still count.
      await typeInto(original, 'first half and second half');

      expect(wellOf('alpha').value).toBe('first half and second half');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still shows the newcomer card in server order around the held one', async () => {
    vi.useFakeTimers();
    try {
      await deliver(view([entry('s-2', 'beta')]));
      const w = wellOf('beta');
      await typeInto(w, 'mid sentence');
      w.focus();
      // alpha is ordered BEFORE beta, so it must be inserted above the held card
      // without the held card moving.
      await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));
      await vi.advanceTimersByTimeAsync(61_000);

      const names = cards().map(c => c.querySelector('.name')?.textContent);
      expect(names).toEqual(['alpha', 'beta']);
      expect(document.activeElement).toBe(w);
      expect(w.value).toBe('mid sentence');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the held card display fields without rebuilding it', async () => {
    vi.useFakeTimers();
    try {
      await deliver(view([entry('s-1', 'alpha')]));
      const w = wellOf('alpha');
      await typeInto(w, 'mid sentence');
      w.focus();
      const renamed = { ...entry('s-1', 'alpha'), name: 'renamed', cwd: '/elsewhere' };
      await deliver(view([renamed]));
      await vi.advanceTimersByTimeAsync(61_000);

      // Staleness is what the backstop exists to clear, so the passive fields
      // must update — but through the SAME node, not a replacement.
      const card = cards()[0];
      expect(card.querySelector('.name')?.textContent).toBe('renamed');
      expect(card.querySelector('.cwd')?.textContent).toBe('/elsewhere');
      expect(card.querySelector('.well')).toBe(w);
      expect(document.activeElement).toBe(w);
      expect(w.value).toBe('mid sentence');
      // The offer is unchanged, so the options are still live.
      expect(card.classList.contains('stale')).toBe(false);
      expect((card.querySelector('.option') as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A kept card is not rebuilt, so its option buttons can outlive the offer they
 * were built from. Staging one would overwrite what the user is writing with
 * text the session has moved past — a wrong action, not just an old label.
 */
describe('a held card whose offer has moved on', () => {
  it('disables its options and says so when the offer changes', async () => {
    vi.useFakeTimers();
    try {
      await deliver(view([entry('s-1', 'alpha')]));
      const w = wellOf('alpha');
      await typeInto(w, 'my own words');
      w.focus();
      const changed = { ...entry('s-1', 'alpha'), options: ['Something entirely different'] };
      await deliver(view([changed]));
      await vi.advanceTimersByTimeAsync(61_000);

      const card = cards()[0];
      expect(card.classList.contains('stale')).toBe(true);
      expect(card.querySelector('.stale-note')).not.toBeNull();
      [...card.querySelectorAll('.option')].forEach(o => {
        expect((o as HTMLButtonElement).disabled).toBe(true);
      });
      // The user's own text and caret are untouched, and Send still works.
      expect(w.value).toBe('my own words');
      expect(document.activeElement).toBe(w);
      expect((card.querySelector('.send') as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the card but marks it stale when the session leaves the board', async () => {
    vi.useFakeTimers();
    try {
      await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));
      const w = wellOf('alpha');
      await typeInto(w, 'half written');
      w.focus();
      await deliver(view([entry('s-2', 'beta')]));   // alpha is gone from the board
      await vi.advanceTimersByTimeAsync(61_000);

      const card = cards().find(c => c.getAttribute('data-session') === 's-1')!;
      expect(card).toBeDefined();
      expect(card.classList.contains('stale')).toBe(true);
      expect(w.value).toBe('half written');
      expect(document.activeElement).toBe(w);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not keep a card whose send is still in flight', async () => {
    vi.useFakeTimers();
    try {
      await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));
      const w = wellOf('alpha');
      await typeInto(w, 'sent already');
      w.focus();

      // Park the POST so the card is still in the DOM, still focused, and
      // already suppressed. Only the backstop can rebuild under a focused well,
      // so that is the path this guard has to survive: a card preserved here
      // would come back with a live Send, which is the double-send the
      // suppression exists to prevent.
      parkPosts = true;
      const alphaCard = cards().find(c => c.getAttribute('data-session') === 's-1')!;
      (alphaCard.querySelector('.send') as HTMLButtonElement).click();
      await flushFake();
      expect(document.body.contains(alphaCard)).toBe(true);   // still in flight

      await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));
      await vi.advanceTimersByTimeAsync(61_000);

      expect(cards().map(c => c.getAttribute('data-session'))).toEqual(['s-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not keep a card the user has already acted on', async () => {
    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));
    const w = wellOf('alpha');
    await typeInto(w, 'sent already');
    w.focus();

    const alphaCard = cards().find(c => c.getAttribute('data-session') === 's-1')!;
    (alphaCard.querySelector('.send') as HTMLButtonElement).click();
    await flush();
    await deliver(view([entry('s-1', 'alpha'), entry('s-2', 'beta')]));

    expect(cards().map(c => c.getAttribute('data-session'))).toEqual(['s-2']);
  });
});
