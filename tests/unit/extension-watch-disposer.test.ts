import { describe, it, expect, vi, beforeEach } from 'vitest';

const watchMock = vi.hoisted(() => {
  const watchers: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const watch = vi.fn(() => {
    const w = { close: vi.fn() };
    watchers.push(w);
    return w;
  });
  return { watch, watchers };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, watch: watchMock.watch };
});

describe('watchExtensions disposer', () => {
  beforeEach(() => {
    watchMock.watch.mockClear();
    watchMock.watchers.length = 0;
  });

  it('closes every fs watcher when the returned disposer is called', async () => {
    const { watchExtensions } = await import('../../src/extension-store.js');
    const handle = watchExtensions(() => {});

    expect(watchMock.watchers.length).toBeGreaterThan(0);
    for (const w of watchMock.watchers) expect(w.close).not.toHaveBeenCalled();

    handle.close();
    for (const w of watchMock.watchers) expect(w.close).toHaveBeenCalledTimes(1);

    // Idempotent: a second close does not re-close (watchers were cleared).
    handle.close();
    for (const w of watchMock.watchers) expect(w.close).toHaveBeenCalledTimes(1);
  });
});
