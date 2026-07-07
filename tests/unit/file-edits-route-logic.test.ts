import { describe, it, expect } from 'vitest';
import { isCardPersist } from '../../src/routes/file-edits.js';

describe('isCardPersist', () => {
  it('accepts a minimal valid card (only relativePath)', () => {
    expect(isCardPersist({ relativePath: 'src/x.ts' })).toBe(true);
  });

  it('accepts a fully-populated valid card', () => {
    expect(isCardPersist({
      relativePath: 'src/x.ts',
      collapsed: true,
      defaultViewerType: 'code',
      activeViewerType: 'diff',
    })).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isCardPersist(null)).toBe(false);
    expect(isCardPersist(undefined)).toBe(false);
    expect(isCardPersist('str')).toBe(false);
    expect(isCardPersist(42)).toBe(false);
  });

  it('rejects a missing or wrong-typed relativePath', () => {
    expect(isCardPersist({})).toBe(false);
    expect(isCardPersist({ relativePath: 123 })).toBe(false);
  });

  it('rejects wrong-typed optional fields', () => {
    expect(isCardPersist({ relativePath: 'a', collapsed: 'yes' })).toBe(false);
    expect(isCardPersist({ relativePath: 'a', defaultViewerType: 1 })).toBe(false);
    expect(isCardPersist({ relativePath: 'a', activeViewerType: {} })).toBe(false);
  });

  it('accepts when optional fields are explicitly undefined', () => {
    expect(isCardPersist({
      relativePath: 'a', collapsed: undefined, defaultViewerType: undefined, activeViewerType: undefined,
    })).toBe(true);
  });
});
