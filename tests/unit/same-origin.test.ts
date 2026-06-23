import { describe, it, expect } from 'vitest';
import { isSameOriginRequest, parseTrustedHosts } from '../../src/security/same-origin.js';

const TRUSTED = parseTrustedHosts(undefined); // loopback defaults

/**
 * Oracle: an independent reference table over (origin, host, trusted). The
 * allow/deny verdict is computed by hand here, NOT by reusing the predicate.
 */
interface Row {
  name: string;
  origin: string | undefined;
  host: string | undefined;
  trusted: ReadonlySet<string>;
  expect: boolean;
}

const rows: Row[] = [
  { name: 'same-origin localhost + trusted', origin: 'http://localhost:53000', host: 'localhost:53000', trusted: TRUSTED, expect: true },
  { name: 'same-origin 127.0.0.1 + trusted', origin: 'http://127.0.0.1:53000', host: '127.0.0.1:53000', trusted: TRUSTED, expect: true },
  { name: 'same-origin [::1] + trusted', origin: 'http://[::1]:53000', host: '[::1]:53000', trusted: TRUSTED, expect: true },
  { name: 'absent origin → allow (self-call/navigation)', origin: undefined, host: 'localhost:53000', trusted: TRUSTED, expect: true },
  { name: 'cross-origin foreign host → deny', origin: 'http://evil.example', host: 'localhost:53000', trusted: TRUSTED, expect: false },
  { name: 'cross-origin by port → deny', origin: 'http://localhost:53001', host: 'localhost:53000', trusted: TRUSTED, expect: false },
  { name: 'DNS rebinding (origin==host but untrusted host) → deny', origin: 'http://evil.example:53000', host: 'evil.example:53000', trusted: TRUSTED, expect: false },
  { name: 'origin present, host absent → deny', origin: 'http://localhost:53000', host: undefined, trusted: TRUSTED, expect: false },
  { name: 'malformed origin → deny', origin: 'not-a-url', host: 'localhost:53000', trusted: TRUSTED, expect: false },
  { name: 'null origin (opaque) → deny', origin: 'null', host: 'localhost:53000', trusted: TRUSTED, expect: false },
  { name: 'default http port equivalence (origin :no-port vs host :80) → allow', origin: 'http://localhost', host: 'localhost:80', trusted: TRUSTED, expect: true },
  { name: 'default https port equivalence (host :443) → allow', origin: 'https://localhost:443', host: 'localhost:443', trusted: TRUSTED, expect: true },
  { name: 'http origin with :443 vs host no-port → deny (scheme-aware, no false-accept)', origin: 'http://localhost:443', host: 'localhost', trusted: TRUSTED, expect: false },
  { name: 'https origin with :80 vs host no-port → deny (scheme-aware)', origin: 'https://localhost:80', host: 'localhost', trusted: TRUSTED, expect: false },
  { name: 'http origin no-port vs host :443 → deny (wrong default port)', origin: 'http://localhost', host: 'localhost:443', trusted: TRUSTED, expect: false },
  { name: 'case-insensitive host match → allow', origin: 'http://LocalHost:53000', host: 'localhost:53000', trusted: TRUSTED, expect: true },
  { name: 'added trusted host (tunnel via CACO_TRUSTED_HOSTS)', origin: 'https://abc.devtunnels.ms', host: 'abc.devtunnels.ms', trusted: parseTrustedHosts('abc.devtunnels.ms'), expect: true },
  { name: 'tunnel host not added → deny', origin: 'https://abc.devtunnels.ms', host: 'abc.devtunnels.ms', trusted: TRUSTED, expect: false },
];

describe('isSameOriginRequest (oracle table)', () => {
  for (const r of rows) {
    it(r.name, () => {
      expect(isSameOriginRequest(r.origin, r.host, r.trusted)).toBe(r.expect);
    });
  }
});

describe('parseTrustedHosts', () => {
  it('defaults to the loopback set', () => {
    const s = parseTrustedHosts(undefined);
    expect(s.has('localhost')).toBe(true);
    expect(s.has('127.0.0.1')).toBe(true);
    expect(s.has('[::1]')).toBe(true);
  });

  it('adds comma-listed hosts additively, lowercased and trimmed', () => {
    const s = parseTrustedHosts(' Foo.Example , bar.local ');
    expect(s.has('foo.example')).toBe(true);
    expect(s.has('bar.local')).toBe(true);
    expect(s.has('localhost')).toBe(true);
  });

  it('ignores blanks', () => {
    const s = parseTrustedHosts(',, ,');
    expect(s.has('localhost')).toBe(true);
    expect(s.size).toBe(3);
  });
});
