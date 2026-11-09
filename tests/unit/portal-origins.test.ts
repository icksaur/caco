import { describe, it, expect } from 'vitest';
import { parsePortalOrigins } from '../../src/security/portal-origins.js';

describe('parsePortalOrigins (spec-portal-pager P9)', () => {
  it('is empty when unset', () => {
    expect(parsePortalOrigins(undefined)).toEqual([]);
    expect(parsePortalOrigins('')).toEqual([]);
  });

  it('normalizes entries to exact origins', () => {
    expect(parsePortalOrigins('http://localhost:53000/, https://abc-53000.usw2.devtunnels.ms/portal.html'))
      .toEqual(['http://localhost:53000', 'https://abc-53000.usw2.devtunnels.ms']);
  });

  it('drops malformed and non-http entries and duplicates', () => {
    expect(parsePortalOrigins('nope ftp://x http://a:1 http://a:1/'))
      .toEqual(['http://a:1']);
  });
});
