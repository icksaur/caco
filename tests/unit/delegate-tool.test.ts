import { describe, it, expect } from 'vitest';
import {
  boundDelegateResponse,
  delegateTargetError,
  buildDelegateSendBody,
  DELEGATE_TOTAL_BYTE_BUDGET,
} from '../../src/delegate-tool.js';

describe('delegateTargetError', () => {
  const base = { sessionId8: 'abcd1234', loaded: true, existsOnDisk: true, busy: false };

  it('returns null when the target is loaded and idle (OK to send)', () => {
    expect(delegateTargetError(base)).toBeNull();
  });

  it('distinguishes a not-loaded (on-disk) session from a missing one, with actionable guidance', () => {
    const err = delegateTargetError({ ...base, loaded: false, existsOnDisk: true, name: 'reviewer' });
    expect(err).toContain('abcd1234');
    expect(err).toContain('"reviewer"');
    expect(err).toMatch(/not loaded/i);
    expect(err).toMatch(/resume|open/i);
    expect(err).not.toMatch(/does not exist/i);
  });

  it('reports a truly-missing session as non-existent, pointing to create_caco_session', () => {
    const err = delegateTargetError({ ...base, loaded: false, existsOnDisk: false });
    expect(err).toMatch(/does not exist/i);
    expect(err).toContain('create_caco_session');
  });

  it('reports a busy loaded session with its name', () => {
    const err = delegateTargetError({ ...base, busy: true, name: 'worker' });
    expect(err).toMatch(/busy/i);
    expect(err).toContain('"worker"');
  });

  it('omits the name label when no name is known', () => {
    const err = delegateTargetError({ ...base, loaded: false, existsOnDisk: true });
    expect(err).not.toContain('("');
  });

  it('rejects a herd child (orchestratedBy set) with actionable guidance', () => {
    const err = delegateTargetError({ ...base, orchestratedBy: 'parent-9999', name: 'worker' });
    expect(err).toMatch(/herd child/i);
    expect(err).toContain('parent-9');
    expect(err).toMatch(/disown/i);
    expect(err).toContain('"worker"');
  });

  it('reports the child bond BEFORE busy (a busy child is still a child)', () => {
    const err = delegateTargetError({ ...base, orchestratedBy: 'parent-9999', busy: true });
    expect(err).toMatch(/herd child/i);
    expect(err).not.toMatch(/busy processing/i);
  });

  it('allows a normal (unbonded) loaded idle session', () => {
    expect(delegateTargetError({ ...base, orchestratedBy: undefined })).toBeNull();
  });
});

describe('buildDelegateSendBody', () => {
  it('always emits source:agent + fromSession + correlationId together (route contract)', () => {
    const body = buildDelegateSendBody('do the thing', 'caller-1234', 'corr-5678');
    expect(body).toEqual({
      prompt: 'do the thing',
      source: 'agent',
      fromSession: 'caller-1234',
      correlationId: 'corr-5678',
    });
  });

  it('never yields fromSession without correlationId (the 400 that broke delegate)', () => {
    const body = buildDelegateSendBody('m', 'caller', 'corr');
    expect(body.fromSession).toBeTruthy();
    expect(body.correlationId).toBeTruthy();
  });
});

describe('boundDelegateResponse (byte-aware)', () => {
  it('passes short responses through unchanged', () => {
    expect(boundDelegateResponse('hello', 'abcd1234')).toBe('hello');
  });

  it('truncates an oversized ASCII response and appends an actionable marker', () => {
    const big = 'y'.repeat(DELEGATE_TOTAL_BYTE_BUDGET + 5000);
    const out = boundDelegateResponse(big, 'abcd1234');
    expect(out).toMatch(/truncated/);
    expect(out).toContain('abcd1234');
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(DELEGATE_TOTAL_BYTE_BUDGET);
  });

  // The MUST from review: a char cap did NOT bound bytes. These pathological inputs
  // (newline/quote/backslash → 2 escaped bytes each; 4-byte emoji) must still fit.
  for (const [label, ch] of [['newlines', '\n'], ['quotes', '"'], ['backslashes', '\\'], ['emoji', '\u{1F600}']] as const) {
    it(`bounds a ${label}-heavy response by ESCAPED bytes, not chars`, () => {
      const big = ch.repeat(6000);
      const out = boundDelegateResponse(big, 'abcd1234');
      expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(DELEGATE_TOTAL_BYTE_BUDGET);
    });
  }

  it('two pathological responses at half-budget keep the combined pretty JSON under 8KB and parseable', () => {
    const half = Math.floor(DELEGATE_TOTAL_BYTE_BUDGET / 2);
    const mkBig = () => '\n'.repeat(8000);
    const results = [
      { sessionId: 'a'.repeat(36), response: boundDelegateResponse(mkBig(), 'aaaaaaaa', half) },
      { sessionId: 'b'.repeat(36), response: boundDelegateResponse(mkBig(), 'bbbbbbbb', half) },
    ];
    const payload = JSON.stringify(results, null, 2);
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(8 * 1024);
    expect(() => JSON.parse(payload)).not.toThrow();
  });
});
