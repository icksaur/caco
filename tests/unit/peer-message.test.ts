import { describe, it, expect } from 'vitest';
import { parsePeerSender, sanitizePeerName } from '../../src/peer-message.js';

describe('parsePeerSender (spec-peer-session-tools)', () => {
  const from = { instanceId: 'inst-1234567890', instanceName: 'Devbox', sessionId: 'abcdef1234567890' };

  it('labels a valid sender as name/session8', () => {
    expect(parsePeerSender(from, '1')).toEqual({ ok: true, label: 'Devbox/abcdef12' });
  });

  it('requires the hop header to be exactly 1', () => {
    expect(parsePeerSender(from, undefined).ok).toBe(false);
    expect(parsePeerSender(from, '2').ok).toBe(false);
  });

  it('rejects missing or malformed ids', () => {
    expect(parsePeerSender(null, '1').ok).toBe(false);
    expect(parsePeerSender({ ...from, instanceId: 'has space' }, '1').ok).toBe(false);
    expect(parsePeerSender({ ...from, sessionId: 'a]b' }, '1').ok).toBe(false);
    expect(parsePeerSender({ ...from, sessionId: 'x'.repeat(101) }, '1').ok).toBe(false);
  });

  it('sanitizes the display name and falls back to the instance id', () => {
    expect(sanitizePeerName('Carl\'s ]laptop[', 'inst-1234')).toBe('Carl_s _laptop_');
    expect(sanitizePeerName('x'.repeat(60), 'inst-1234')).toHaveLength(40);
    expect(sanitizePeerName('', 'inst-1234567')).toBe('inst-123');
    expect(sanitizePeerName(42, 'inst-1234567')).toBe('inst-123');
  });
});
