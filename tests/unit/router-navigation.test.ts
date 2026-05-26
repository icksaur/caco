/**
 * Tests for shouldShowAppletOnNavigation — the pure decision used by
 * router.handleNavigation to decide whether a URL change should reveal
 * the applet panel.
 */

import { describe, it, expect } from 'vitest';
import { shouldShowAppletOnNavigation } from '../../public/ts/router.js';

describe('shouldShowAppletOnNavigation', () => {
  it('shows when user clicks a link to an applet (push navigation)', () => {
    expect(shouldShowAppletOnNavigation('text-editor', 'push')).toBe(true);
  });

  it('shows on back/forward into a URL with an applet (traverse)', () => {
    expect(shouldShowAppletOnNavigation('git-status', 'traverse')).toBe(true);
  });

  it('does NOT show on replaceState housekeeping (replace)', () => {
    // restoreApplet uses window.history.replaceState to fix up the URL
    // after session activation. Must not flip panel visibility.
    expect(shouldShowAppletOnNavigation('text-editor', 'replace')).toBe(false);
  });

  it('does NOT show when URL has no applet param, regardless of nav type', () => {
    expect(shouldShowAppletOnNavigation(null, 'push')).toBe(false);
    expect(shouldShowAppletOnNavigation(null, 'replace')).toBe(false);
    expect(shouldShowAppletOnNavigation(null, 'traverse')).toBe(false);
  });
});
