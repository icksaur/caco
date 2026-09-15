/**
 * Types for the lockfile guard's pure rule function, so the unit test can
 * import it without `any`. The script itself stays plain ESM JS (it is a gate
 * script run by node directly, not part of the TS build).
 */

export interface LockfileViolation {
  /** The `packages` key, e.g. `node_modules/left-pad`. */
  path: string;
  kind: 'non-public-registry' | 'weak-integrity' | 'unparseable-url';
  /** The offending value: a host, a hash algorithm, or the raw URL. */
  detail: string;
}

export interface LockfileShape {
  packages?: Record<string, {
    resolved?: string;
    integrity?: string;
    [k: string]: unknown;
  } | null | undefined>;
}

export function findLockfileViolations(lock: LockfileShape | null | undefined): LockfileViolation[];
