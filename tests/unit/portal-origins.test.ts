import { describe, it, expect } from 'vitest';
import { parsePortalOrigins, DEFAULT_PORTAL_ORIGINS } from '../../src/security/portal-origins.js';

describe('parsePortalOrigins (spec-portal-pager P9)', () => {
  it('defaults to the portal at the default Caco port on localhost when unset', () => {
    expect(DEFAULT_PORTAL_ORIGINS).toEqual(['http://localhost:53000', 'http://127.0.0.1:53000']);
    expect(parsePortalOrigins(undefined)).toEqual(['http://localhost:53000', 'http://127.0.0.1:53000']);
    expect(parsePortalOrigins('  ')).toEqual(['http://localhost:53000', 'http://127.0.0.1:53000']);
  });

  it('a set list replaces the default entirely', () => {
    expect(parsePortalOrigins('http://localhost:54000')).toEqual(['http://localhost:54000']);
  });

  it('none disables other origins, case-insensitively', () => {
    expect(parsePortalOrigins('none')).toEqual([]);
    expect(parsePortalOrigins(' NONE ')).toEqual([]);
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
