import { afterEach, describe, expect, it, vi } from 'vitest';

function expectedColorsForHostname(hostname: string): string[] {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  let h3 = 0xdeadbeef;
  let h4 = 0xcafebabe;

  for (let i = 0; i < hostname.length; i++) {
    const c = hostname.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x85ebca6b);
    h3 ^= c;
    h3 = Math.imul(h3, 0xc2b2ae35);
    h4 ^= c;
    h4 = Math.imul(h4, 0x27d4eb2f);
  }

  return [h1, h2, h3, h4].map(hash => `hsl(${Math.round(((hash & 0xFF) / 255) * 360)}, 70%, 50%)`);
}

async function importFreshModule() {
  vi.resetModules();
  return import('../../public/ts/hostname-hash.js');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getHostnameColors exact hashing', () => {
  it('prefers SERVER_HOSTNAME and maps its four hash bytes to corner HSL colors', async () => {
    vi.stubGlobal('window', { SERVER_HOSTNAME: 'build-box', location: { hostname: 'browser-host' } });
    const { getHostnameColors } = await importFreshModule();

    expect(getHostnameColors()).toEqual(expectedColorsForHostname('build-box'));
  });

  it('uses location.hostname when no injected hostname exists', async () => {
    vi.stubGlobal('window', { location: { hostname: 'edge-node.local' } });
    const { getHostnameColors } = await importFreshModule();

    expect(getHostnameColors()).toEqual(expectedColorsForHostname('edge-node.local'));
  });

  it('hashes the empty hostname deterministically from the initial hash seeds', async () => {
    vi.stubGlobal('window', { location: { hostname: '' } });
    const { getHostnameColors } = await importFreshModule();

    expect(getHostnameColors()).toEqual(expectedColorsForHostname(''));
  });
});
