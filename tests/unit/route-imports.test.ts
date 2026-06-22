/**
 * Smoke test: every src/routes/*.ts module must import cleanly without
 * touching uninitialized module-level state (e.g. `export let sessionState`
 * before createSessionState runs).
 *
 * Catches the class of bug where a route file calls a side effect at module
 * load (e.g. `sessionState.onSessionEnd(...)`) before the singleton exists.
 */

import { describe, it, expect } from 'vitest';

describe('route module side-effects', () => {
  // routes/index.ts re-exports every route module. If any has a load-time
  // side effect that touches uninitialized module-level state, this import
  // will throw — same code path the server runs at startup.
  it('routes/index.ts imports cleanly without throwing', async () => {
    await expect(import('../../src/routes/index.js')).resolves.toBeDefined();
    // 30s (not the 5s default): this import transitively transforms the entire
    // route layer via tsx/esbuild — a heavy one-time cost that can exceed 5s
    // under full-suite parallel CPU contention (passes in ~1.7s isolated). The
    // generous deadline removes the flake without masking a real hang.
  }, 30000);
});

