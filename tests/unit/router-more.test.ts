import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUrlParams, shouldShowAppletOnNavigation } from '../../public/ts/router.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shouldShowAppletOnNavigation additional cases', () => {
  it('does not reveal the applet panel for an empty applet slug', () => {
    expect(shouldShowAppletOnNavigation('', 'push')).toBe(false);
  });
});

describe('getUrlParams', () => {
  it('extracts decoded session and applet params while ignoring unrelated params', () => {
    vi.stubGlobal('window', {
      location: { href: 'https://caco.example/chat?x=1&session=session%201&applet=file-viewer&mode=wide' },
    });

    expect(getUrlParams()).toEqual({ session: 'session 1', applet: 'file-viewer' });
  });

  it('returns nulls when params are absent', () => {
    vi.stubGlobal('window', { location: { href: 'https://caco.example/chat?x=1' } });

    expect(getUrlParams()).toEqual({ session: null, applet: null });
  });
});
