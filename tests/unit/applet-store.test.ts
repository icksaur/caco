import { describe, it, expect } from 'vitest';
import { loadApplet } from '../../src/applet-store.js';

describe('SLUG_ALIASES', () => {
  it('file-edits resolves to the files applet (V5 rename + back-compat)', async () => {
    const bundle = await loadApplet('file-edits');
    expect(bundle).not.toBeNull();
    expect(bundle?.meta.slug).toBe('files');
  });

  it('files resolves directly to itself', async () => {
    const bundle = await loadApplet('files');
    expect(bundle).not.toBeNull();
    expect(bundle?.meta.slug).toBe('files');
  });
});
