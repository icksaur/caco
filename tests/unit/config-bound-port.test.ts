import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * After a fallback bind, every server self-call (agent tools, delegate, herd,
 * scheduler) must reach the port actually bound. They all import SERVER_URL and
 * read it at call time, so it is an ESM live binding reassigned once at bind.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('bound port', () => {
  it('moves SERVER_URL to the bound port, as seen by an importer', async () => {
    vi.stubEnv('CACO_SERVER_URL', '');
    vi.stubEnv('CACO_PORT', '53000');
    vi.resetModules();
    const { setBoundPort, getBoundPort } = await import('../../src/config.js');
    // A separate module importing SERVER_URL statically, as the consumers do.
    // A copied value would keep the requested port.
    const { readServerUrl } = await import('../fixtures/server-url-consumer.js');
    expect(readServerUrl()).toBe('http://localhost:53000');

    setBoundPort(53002);

    expect(getBoundPort()).toBe(53002);
    expect(readServerUrl()).toBe('http://localhost:53002');
  });

  it('leaves an explicit CACO_SERVER_URL alone', async () => {
    vi.stubEnv('CACO_SERVER_URL', 'http://example.internal:9000');
    vi.resetModules();
    const config = await import('../../src/config.js');

    config.setBoundPort(53002);

    expect(config.SERVER_URL).toBe('http://example.internal:9000');
    expect(config.getBoundPort()).toBe(53002);
  });

  it('reports the requested port until something is bound', async () => {
    vi.stubEnv('CACO_PORT', '53010');
    vi.resetModules();
    const config = await import('../../src/config.js');
    expect(config.getBoundPort()).toBe(53010);
  });
});

describe('serverUrlFor', () => {
  it('prints a concrete host as given', async () => {
    const { serverUrlFor } = await import('../../src/config.js');
    expect(serverUrlFor('127.0.0.1', 53001)).toBe('http://127.0.0.1:53001');
  });

  it('prints localhost for a wildcard host, which is not browsable', async () => {
    const { serverUrlFor } = await import('../../src/config.js');
    expect(serverUrlFor('0.0.0.0', 53000)).toBe('http://localhost:53000');
    expect(serverUrlFor('::', 53000)).toBe('http://localhost:53000');
  });

  it('brackets an IPv6 literal', async () => {
    const { serverUrlFor } = await import('../../src/config.js');
    expect(serverUrlFor('::1', 53000)).toBe('http://[::1]:53000');
  });
});
