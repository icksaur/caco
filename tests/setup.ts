/**
 * Vitest global setup — silence console noise from production code paths under
 * test. Many unit tests deliberately exercise error branches (corrupt JSON,
 * dropped connections, failed loads), whose `console.warn`/`console.error` are
 * expected output, not signal — so a clean run stays readable.
 *
 * All three of `console.log`/`warn`/`error` are replaced with no-ops for the run
 * and restored afterwards. This does NOT hinder tests that assert on console:
 * `vi.spyOn(console, 'error')` wraps whichever function is currently installed
 * (the no-op) and its own restore returns to that no-op, so call-count assertions
 * still work AND stay silent. Real test failures (assertions, unhandled
 * rejections) are surfaced by Vitest independently of these streams.
 */

import { beforeAll, afterAll } from 'vitest';

const original = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

beforeAll(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

afterAll(() => {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
});
