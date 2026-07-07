import { describe, it, expect } from 'vitest';
import {
  boundDelegateResponse,
  delegateTargetError,
  DELEGATE_RESPONSE_CHAR_CAP,
} from '../../src/delegate-tool.js';

describe('delegateTargetError', () => {
  const base = { sessionId8: 'abcd1234', active: true, existsOnDisk: true, busy: false };

  it('returns null when the target is active and idle (OK to send)', () => {
    expect(delegateTargetError(base)).toBeNull();
  });

  it('distinguishes an INACTIVE (on-disk) session from a missing one, with actionable guidance', () => {
    const err = delegateTargetError({ ...base, active: false, existsOnDisk: true, name: 'reviewer' });
    expect(err).toContain('abcd1234');
    expect(err).toContain('"reviewer"');
    expect(err).toContain('INACTIVE');
    expect(err).toMatch(/resume|open/i);
    // must NOT mislead with "does not exist"
    expect(err).not.toMatch(/does not exist/i);
  });

  it('reports a truly-missing session as non-existent, pointing to create_caco_session', () => {
    const err = delegateTargetError({ ...base, active: false, existsOnDisk: false });
    expect(err).toMatch(/does not exist/i);
    expect(err).toContain('create_caco_session');
  });

  it('reports a busy active session with its name', () => {
    const err = delegateTargetError({ ...base, busy: true, name: 'worker' });
    expect(err).toMatch(/busy/i);
    expect(err).toContain('"worker"');
  });

  it('omits the name label when no name is known', () => {
    const err = delegateTargetError({ ...base, active: false, existsOnDisk: true });
    expect(err).not.toContain('("');
  });
});

describe('boundDelegateResponse', () => {
  it('passes short responses through unchanged', () => {
    expect(boundDelegateResponse('hello', 'abcd1234')).toBe('hello');
  });

  it('passes a response exactly at the cap through unchanged', () => {
    const exact = 'x'.repeat(DELEGATE_RESPONSE_CHAR_CAP);
    expect(boundDelegateResponse(exact, 'abcd1234')).toBe(exact);
  });

  it('truncates an oversized response and appends an actionable marker', () => {
    const big = 'y'.repeat(DELEGATE_RESPONSE_CHAR_CAP + 500);
    const out = boundDelegateResponse(big, 'abcd1234');
    expect(out.startsWith('y'.repeat(DELEGATE_RESPONSE_CHAR_CAP))).toBe(true);
    expect(out).toContain('truncated');
    expect(out).toContain('abcd1234');
    // The kept content is exactly the cap; total is cap + marker
    expect(out.length).toBeLessThan(DELEGATE_RESPONSE_CHAR_CAP + 200);
  });

  it('keeps two capped responses under the 8KB generic-shaper threshold as JSON', () => {
    const big = 'z'.repeat(10_000);
    const results = [
      { sessionId: 'a'.repeat(36), response: boundDelegateResponse(big, 'aaaaaaaa') },
      { sessionId: 'b'.repeat(36), response: boundDelegateResponse(big, 'bbbbbbbb') },
    ];
    const payload = JSON.stringify(results, null, 2);
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(8 * 1024);
    // still valid, parseable JSON
    expect(() => JSON.parse(payload)).not.toThrow();
  });
});
