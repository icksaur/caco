import { describe, it, expect, vi } from 'vitest';
import { ExtensionRuntime } from '../../src/extension-runtime.js';
import type { WebSocket } from 'ws';

/**
 * Oracles for the ExtensionRuntime lifecycle (P7 slice 2).
 *
 * Make-unrepresentable hardening: a duplicate client-message registration is a
 * programming error (throws, was silent overwrite), and unload() releases the
 * stale handler closures that previously accumulated across reloads.
 */

const noopHandler = (_ws: WebSocket, _data: unknown) => {};

describe('ExtensionRuntime', () => {
  it('throws when two extensions register the same client message type', () => {
    const rt = new ExtensionRuntime();
    rt.registerClientMessageHandler('ping', noopHandler, 'ext-a');

    expect(() => rt.registerClientMessageHandler('ping', vi.fn(), 'ext-b')).toThrow(/already registered/);

    // The original handler must still win — the second must NOT silently overwrite.
    expect(rt.getClientMessageHandler('ping')).toBe(noopHandler);
  });

  it('unload() releases handlers so they do not survive a reload', () => {
    const rt = new ExtensionRuntime();
    rt.registerClientMessageHandler('ping', noopHandler, 'ext-a');
    expect(rt.getClientMessageHandler('ping')).toBe(noopHandler);

    rt.unload();

    // Without unload the handler stays resident (the accumulation vector).
    expect(rt.getClientMessageHandler('ping')).toBeUndefined();
  });

  it('after unload the same type can be registered again without throwing', () => {
    const rt = new ExtensionRuntime();
    rt.registerClientMessageHandler('ping', noopHandler, 'ext-a');
    rt.unload();

    const replacement = vi.fn();
    expect(() => rt.registerClientMessageHandler('ping', replacement, 'ext-a')).not.toThrow();
    expect(rt.getClientMessageHandler('ping')).toBe(replacement);
  });
});
