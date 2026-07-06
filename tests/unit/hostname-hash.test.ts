import { describe, it, expect, vi, afterEach } from 'vitest';
import { getServerHostname, getHostnameColors } from '../../public/ts/hostname-hash.js';

afterEach(() => vi.unstubAllGlobals());

describe('getServerHostname', () => {
  it('returns "test" when window is undefined (node/test env)', () => {
    expect(getServerHostname()).toBe('test');
  });

  it('prefers the injected SERVER_HOSTNAME', () => {
    vi.stubGlobal('window', { SERVER_HOSTNAME: 'my-host', location: { hostname: 'ignored' } });
    expect(getServerHostname()).toBe('my-host');
  });

  it('falls back to location.hostname when SERVER_HOSTNAME is absent', () => {
    vi.stubGlobal('window', { location: { hostname: 'fallback.local' } });
    expect(getServerHostname()).toBe('fallback.local');
  });
});

describe('getHostnameColors', () => {
  it('derives 4 vibrant HSL colors from the hostname hash, deterministic + cached', () => {
    vi.stubGlobal('window', { SERVER_HOSTNAME: 'host-a', location: { hostname: 'x' } });

    const colors = getHostnameColors();
    expect(colors).toHaveLength(4);
    // full saturation / medium lightness, hue 0-360
    for (const c of colors) expect(c).toMatch(/^hsl\(\d{1,3}, 70%, 50%\)$/);

    // cached: repeated calls return the identical array (module-level memo)
    expect(getHostnameColors()).toBe(colors);
  });
});
