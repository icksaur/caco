import { describe, it, expect } from 'vitest';
import { verifyWsUpgrade } from '../../src/security/same-origin.js';

/**
 * The /ws upgrade uses the shared same-origin predicate (loopback-trusted by
 * default). Browser WebSockets always send Origin; the absent-Origin case admits
 * only non-browser local clients (not the cross-site threat) — asserted deliberately.
 */
describe('verifyWsUpgrade', () => {
  it('accepts a same-origin loopback upgrade', () => {
    expect(verifyWsUpgrade('http://localhost:53000', 'localhost:53000')).toBe(true);
    expect(verifyWsUpgrade('http://127.0.0.1:53000', '127.0.0.1:53000')).toBe(true);
  });

  it('rejects a cross-origin upgrade', () => {
    expect(verifyWsUpgrade('http://evil.example', 'localhost:53000')).toBe(false);
    expect(verifyWsUpgrade('http://localhost:53001', 'localhost:53000')).toBe(false);
  });

  it('rejects a same-origin upgrade to an untrusted host (DNS rebinding)', () => {
    expect(verifyWsUpgrade('http://evil.example:53000', 'evil.example:53000')).toBe(false);
  });

  it('allows an absent-Origin upgrade (non-browser local client, not the threat)', () => {
    expect(verifyWsUpgrade(undefined, 'localhost:53000')).toBe(true);
  });

  it('rejects when only the Host is present', () => {
    expect(verifyWsUpgrade('http://localhost:53000', undefined)).toBe(false);
  });
});
