import { describe, it, expect } from 'vitest';
import { extractSessionUsage } from '../../src/session-usage-cache.js';

describe('extractSessionUsage — retain the full usage_info breakdown (not just tokenLimit/currentTokens)', () => {
  it('keeps toolDefinitionsTokens/systemTokens/conversationTokens when present', () => {
    const u = extractSessionUsage({
      tokenLimit: 200000,
      currentTokens: 45000,
      toolDefinitionsTokens: 8200,
      systemTokens: 3100,
      conversationTokens: 33700,
    });
    expect(u).toEqual({
      tokenLimit: 200000,
      currentTokens: 45000,
      toolDefinitionsTokens: 8200,
      systemTokens: 3100,
      conversationTokens: 33700,
    });
  });

  it('returns the base pair when the breakdown fields are absent (no fabricated zeros)', () => {
    const u = extractSessionUsage({ tokenLimit: 200000, currentTokens: 100 });
    expect(u).toEqual({ tokenLimit: 200000, currentTokens: 100 });
    expect(u).not.toHaveProperty('toolDefinitionsTokens');
  });

  it('returns null when the required tokenLimit/currentTokens are missing', () => {
    expect(extractSessionUsage({ toolDefinitionsTokens: 8200 })).toBeNull();
    expect(extractSessionUsage({ tokenLimit: 200000 })).toBeNull();
    expect(extractSessionUsage(undefined)).toBeNull();
  });
});
