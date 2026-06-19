/**
 * Estimating the context-window tokens a workflow run saved versus doing the
 * same reads as individual tools.
 *
 * `observedBytes` is the total payload the facade returned to the script inside
 * the child process — data that, with ordinary tools, would have entered the
 * model's context (and been re-sent from cache on every later turn).
 * `injectedBytes` is what the workflow result actually puts back into context
 * (the emitted value + shaped logs). The difference is the one-time saving.
 *
 * This is a deliberately conservative LOWER BOUND: it ignores the compounding
 * cost of re-sending those bytes on subsequent turns, and uses a fixed
 * chars-per-token ratio rather than a real tokenizer. It is an estimate, shown
 * as such in the UI.
 */

export const BYTES_PER_TOKEN = 4;

export function estimateSavedTokens(observedBytes: number, injectedBytes: number): number {
  const obs = Number.isFinite(observedBytes) && observedBytes > 0 ? observedBytes : 0;
  const inj = Number.isFinite(injectedBytes) && injectedBytes > 0 ? injectedBytes : 0;
  const savedBytes = Math.max(0, obs - inj);
  return Math.round(savedBytes / BYTES_PER_TOKEN);
}
