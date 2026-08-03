import { describe, it, expect } from 'vitest';
import { parsePagerQuery } from '../../src/routes/pager.js';

describe('parsePagerQuery', () => {
  it('reads a valid since and wait', () => {
    expect(parsePagerQuery({ since: '42', wait: '5000' })).toEqual({ since: 42, wait: 5000 });
  });

  it('treats an absent since as no cursor (answer immediately)', () => {
    expect(parsePagerQuery({ wait: '1000' }).since).toBeUndefined();
  });

  it('treats a non-numeric since as no cursor rather than 0', () => {
    // Coercing to 0 would make a garbage cursor look like "start of time" and
    // park the caller against version 0.
    expect(parsePagerQuery({ since: 'abc' }).since).toBeUndefined();
    expect(parsePagerQuery({ since: '' }).since).toBeUndefined();
  });

  it('accepts since=0', () => {
    expect(parsePagerQuery({ since: '0' }).since).toBe(0);
  });

  it('defaults wait to 0 when absent, non-numeric, or non-positive', () => {
    expect(parsePagerQuery({}).wait).toBe(0);
    expect(parsePagerQuery({ wait: 'soon' }).wait).toBe(0);
    expect(parsePagerQuery({ wait: '0' }).wait).toBe(0);
    expect(parsePagerQuery({ wait: '-1' }).wait).toBe(0);
  });

  it('passes an over-large wait through for the feed to clamp', () => {
    // The parser does not own the ceiling; ActivityVersion.clampWait does, so the
    // cap lives in one place.
    expect(parsePagerQuery({ wait: '60000' }).wait).toBe(60000);
  });
});
