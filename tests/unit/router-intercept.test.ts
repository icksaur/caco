/**
 * Tests for shouldInterceptNavigation — the pure decision used by the router to
 * tell an in-document URL change from a real page load.
 */

import { describe, it, expect } from 'vitest';
import { shouldInterceptNavigation } from '../../public/ts/router.js';

const app = new URL('http://host:53000/');

describe('shouldInterceptNavigation', () => {
  it('intercepts a query-only change within the app document', () => {
    expect(shouldInterceptNavigation('http://host:53000/?applet=files', app)).toBe(true);
    expect(shouldInterceptNavigation('http://host:53000/?session=abc&applet=git', app)).toBe(true);
  });

  it('leaves a link to another page to the browser', () => {
    // The regression this exists for: handleNavigation only reads ?session and
    // ?applet and swaps content in place, so intercepting a different document
    // commits the URL and then renders nothing — the address bar changes and the
    // page does not.
    expect(shouldInterceptNavigation('http://host:53000/pager.html', app)).toBe(false);
    expect(shouldInterceptNavigation('http://host:53000/portal.html', app)).toBe(false);
  });

  it('carries the query through the pathname decision', () => {
    // A standalone page with params is still a different document.
    expect(shouldInterceptNavigation('http://host:53000/pager.html?x=1', app)).toBe(false);
  });

  it('leaves other origins alone', () => {
    expect(shouldInterceptNavigation('https://example.com/?applet=files', app)).toBe(false);
  });

  it('treats an unparseable destination as not ours', () => {
    expect(shouldInterceptNavigation('not a url', app)).toBe(false);
  });

  it('still intercepts when the app itself is served from a sub-path', () => {
    // Nothing pins the app to '/', so the rule is "same document", not "root".
    const under = new URL('http://host:53000/caco/');
    expect(shouldInterceptNavigation('http://host:53000/caco/?applet=files', under)).toBe(true);
    expect(shouldInterceptNavigation('http://host:53000/caco/pager.html', under)).toBe(false);
  });
});
