/**
 * Vitest global setup — silence informational console.log() from production
 * code paths under test. Errors and warnings still print so real failures
 * remain visible.
 *
 * Individual tests that want to assert on console.log output can override
 * via vi.spyOn(console, 'log') in their describe block.
 */

import { beforeAll, afterAll } from 'vitest';

const originalLog = console.log;

beforeAll(() => {
  console.log = () => {};
});

afterAll(() => {
  console.log = originalLog;
});
