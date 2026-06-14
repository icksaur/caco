import { describe, it, expect, beforeEach } from 'vitest';
import { recordUsage, clearSession, snapshot } from '../../src/session-throughput.js';

const KNOWN_SID = 'route-test-session';
const UNKNOWN_SID = 'no-such-session-xyz';

beforeEach(() => {
  clearSession(KNOWN_SID);
  clearSession(UNKNOWN_SID);
});

describe('throughput snapshot (route backing)', () => {
  it('returns known:true with populated fields for a session with recorded usage', () => {
    recordUsage(KNOWN_SID, { inputTokens: 1200, outputTokens: 400 });
    const s = snapshot(KNOWN_SID);
    expect(s.known).toBe(true);
    expect(s.totalIn).toBe(1200);
    expect(s.totalOut).toBe(400);
    expect(s.rateLimitCount).toBe(0);
  });

  it('returns known:false with zeroed fields for an unknown session', () => {
    const s = snapshot(UNKNOWN_SID);
    expect(s.known).toBe(false);
    expect(s.requestIn).toBe(0);
    expect(s.requestOut).toBe(0);
    expect(s.totalIn).toBe(0);
    expect(s.totalOut).toBe(0);
    expect(s.rateLimitCount).toBe(0);
    expect(s.updatedAt).toBeTruthy();
  });
});
