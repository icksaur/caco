import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ctrl+P took two presses to open the file finder.
 *
 * The shortcut navigates to `?applet=files&openFinder=1`. The applet reads that
 * in its `onUrlParamsChange` callback — which the runtime invokes SYNCHRONOUSLY
 * at registration (applet-runtime.ts calls `callback(getAppletUrlParams())`
 * before subscribing to popstate). Registration happens inside `bootSession`,
 * *before* it assigns `sessionId`. `openPicker` refuses when there is neither a
 * session nor an explicit root override, so the first press was swallowed
 * without a trace and the second worked because boot had finished by then.
 *
 * `openPath` already had a defer-and-drain for exactly this race; `openFinder`
 * did not. These pin the invariant that a param consumed at boot must not
 * depend on state boot has not set yet.
 *
 * The applet is a build-free ES5 IIFE and cannot be imported, so this asserts
 * against source. That is weaker than executing it, and is preferred over
 * inlining a copy of the logic, which would only prove the copy matches itself.
 */
const script = readFileSync(
  join(process.cwd(), 'applets', 'files', 'script.js'), 'utf8');
const runtime = readFileSync(
  join(process.cwd(), 'public', 'ts', 'applet-runtime.ts'), 'utf8');

const lineOf = (needle: string): number => {
  const i = script.indexOf(needle);
  expect(i, `not found: ${needle}`).toBeGreaterThan(-1);
  return script.slice(0, i).split('\n').length;
};

describe('the boot race that made Ctrl+P need two presses', () => {
  it('still exists: onUrlParamsChange fires before it subscribes to popstate', () => {
    // If this ever stops being synchronous, the defer below becomes harmless
    // rather than necessary — but the applet should not silently rely on that.
    const fn = runtime.slice(runtime.indexOf('export function onUrlParamsChange'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('callback(getAppletUrlParams())');
    expect(body.indexOf('callback(getAppletUrlParams())'))
      .toBeLessThan(body.indexOf("addEventListener('popstate'"));
  });

  it('registers the params callback before sessionId is assigned', () => {
    // The ordering that makes the defer necessary. If boot is ever reordered so
    // sessionId comes first, this fails and the defer can be reconsidered.
    expect(lineOf('window.appletAPI.onUrlParamsChange('))
      .toBeLessThan(lineOf('sessionId = existingId;'));
  });
});

describe('openFinder defers until the session is known', () => {
  it('does not call openPicker directly when there is no session or root', () => {
    const start = script.indexOf('if (params.openFinder)');
    expect(start).toBeGreaterThan(-1);
    const block = script.slice(start, start + 900);
    expect(block).toContain('if (sessionId || rootOverride)');
    expect(block).toContain('_pendingOpenFinder = {');
  });

  it('drains the pending finder as soon as the session id is set', () => {
    // Both boot paths: the existing-session path and the session-created path.
    const existing = script.indexOf('sessionId = existingId;');
    expect(script.slice(existing, existing + 400)).toContain('_drainPendingOpenFinder()');
    const created = script.indexOf('sessionId = sid;');
    expect(script.slice(created, created + 200)).toContain('_drainPendingOpenFinder()');
  });

  it('gates the drain on sessionId, not on cachedCwd', () => {
    const start = script.indexOf('function _drainPendingOpenFinder');
    const body = script.slice(start, start + 500);
    // cachedCwd arrives from a metadata round trip; waiting on it would make a
    // keypress depend on the network for no reason, since openPicker resolves
    // the root itself.
    expect(body).toContain('!sessionId');
    expect(body).not.toContain('cachedCwd');
  });

  it('consumes the request so a later drain cannot reopen the picker', () => {
    const start = script.indexOf('function _drainPendingOpenFinder');
    const body = script.slice(start, start + 500);
    expect(body.indexOf('_pendingOpenFinder = null'))
      .toBeLessThan(body.indexOf('openPicker('));
  });

  it('keeps the openPath drain working, which shares the same race', () => {
    const start = script.indexOf('function _drainPendingOpenPath');
    const body = script.slice(start, start + 700);
    expect(body).toContain('_handleOpenPath(');
    expect(body).toContain('_drainPendingOpenFinder()');
  });
});
