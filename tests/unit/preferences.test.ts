/**
 * preferences tests — pure helpers only (no disk).
 *
 * Oracles: the model-alias map (mapping), the default-on auto-continue rule
 * (only an explicit `false` disables), and default-preferences immutability.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveModelAlias,
  isAutoContinueEnabled,
  getDefaultPreferences,
  DEFAULT_MODEL,
} from '../../src/preferences.js';

describe('resolveModelAlias', () => {
  it('maps a known alias to its canonical id', () => {
    expect(resolveModelAlias('claude-opus-4.5')).toBe('claude-opus-4.6-1m');
    expect(resolveModelAlias('claude-sonnet-4.5')).toBe('claude-sonnet-4.6');
  });

  it('passes an unknown model through unchanged', () => {
    expect(resolveModelAlias('claude-sonnet-4.6')).toBe('claude-sonnet-4.6');
    expect(resolveModelAlias('gpt-5-mini')).toBe('gpt-5-mini');
    expect(resolveModelAlias('')).toBe('');
  });
});

describe('isAutoContinueEnabled', () => {
  it('defaults on for missing/undefined prefs', () => {
    expect(isAutoContinueEnabled(undefined)).toBe(true);
    expect(isAutoContinueEnabled(null)).toBe(true);
    expect(isAutoContinueEnabled({ autoContinueEnabled: undefined })).toBe(true);
  });

  it('is on when explicitly true, off ONLY when explicitly false', () => {
    expect(isAutoContinueEnabled({ autoContinueEnabled: true })).toBe(true);
    expect(isAutoContinueEnabled({ autoContinueEnabled: false })).toBe(false);
  });
});

describe('getDefaultPreferences', () => {
  it('returns the default model and a fresh copy each call', () => {
    const a = getDefaultPreferences();
    const b = getDefaultPreferences();
    expect(a.lastModel).toBe(DEFAULT_MODEL);
    expect(a.autoContinueEnabled).toBe(true);
    expect(a.lastSessionId).toBeNull();
    expect(a).not.toBe(b);
    a.lastModel = 'mutated';
    expect(getDefaultPreferences().lastModel).toBe(DEFAULT_MODEL);
  });
});
