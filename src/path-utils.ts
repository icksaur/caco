/**
 * Path Validation Utilities
 * 
 * Secure path validation for file system operations.
 * Prevents path traversal attacks and escaping allowed directories.
 */

import { resolve, relative, normalize, sep } from 'path';

/**
 * Convert any path to POSIX ('/'-separated) form. The model-facing facade emits
 * '/'-separated relative paths on every platform so grep/glob/read/index results
 * are identical on Windows and Linux (and match real ripgrep output). Round-trips
 * safely: validatePath() resolves '/'-separated input correctly on Windows.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Result of path validation
 */
export type PathValidationResult = 
  | { valid: true; resolved: string; relative: string }
  | { valid: false; error: string };

/**
 * Validate that a requested path is within an allowed base directory.
 * 
 * Security measures:
 * - Resolves to absolute path
 * - Normalizes to remove .. and .
 * - Checks that result is within base directory
 * - Handles symlink edge cases by comparing resolved paths
 * 
 * @param base - The allowed base directory (absolute path)
 * @param requested - The requested path (can be relative or absolute)
 * @returns Validation result with resolved path or error
 * 
 * @example
 * validatePath('/home/user/project', 'src/app.ts')
 * // => { valid: true, resolved: '/home/user/project/src/app.ts', relative: 'src/app.ts' }
 * 
 * validatePath('/home/user/project', '../secrets/passwords.txt')
 * // => { valid: false, error: 'Path escapes allowed directory' }
 */
export function validatePath(base: string, requested: string): PathValidationResult {
  if (!requested) {
    return { valid: false, error: 'Path is required' };
  }

  // Resolve to absolute path
  const resolved = resolve(base, requested);
  
  // Normalize to canonical form
  const normalized = normalize(resolved);
  
  // Get relative path from base
  const relativePath = relative(base, normalized);
  
  // Security checks:
  // 1. Relative path should not start with '..' (escaping base)
  // 2. Resolved path should start with base (double-check)
  // 3. Relative path should not be empty string when requested is not empty
  if (relativePath.startsWith('..')) {
    return { valid: false, error: 'Path escapes allowed directory' };
  }
  
  // Ensure the resolved path truly starts with base
  // (handles edge cases like base=/tmp matching /tmpfoo)
  const resolvedBase = resolve(base);
  if (!normalized.startsWith(resolvedBase + sep) && normalized !== resolvedBase) {
    return { valid: false, error: 'Path escapes allowed directory' };
  }
  
  return {
    valid: true,
    resolved: normalized,
    relative: relativePath || '.'
  };
}

/** Resolved workflow-facade read path: absolute `resolved` + a re-readable `display`. */
export interface ResolvedReadPath {
  /** Absolute, normalized target path. */
  resolved: string;
  /** Base-relative POSIX path when inside `base`, else the absolute POSIX path. */
  display: string;
  /** Whether the target is within `base`. */
  inside: boolean;
}

/**
 * Resolve a workflow-facade READ path with bash-parity reach. A relative path
 * resolves against `base` (the session cwd); an absolute path or `..` escape is
 * ALLOWED — never rejected. The workflow facade shares sh/rg's trust model
 * (docs/spec-caco-run-workflow "privilege parity with bash"): an addressed read
 * (read/reads/peek/list/index) reaches any path the OS user can, so a hard scope
 * here would only be friction, not security (the agent can `sh('cat <path>')`).
 *
 * This is NOT for remote/route input — those keep `validatePath`'s allowlist
 * rejection (see routes/workspace-api.ts). Resolution is lexical (no realpath),
 * matching validatePath. `display` is base-relative when inside `base`, else the
 * absolute path, using the SAME normalized-prefix test as validatePath so a
 * cross-drive Windows path is classified "outside" (shown absolute) rather than a
 * bogus `..\..\` relative.
 */
export function resolveReadPath(base: string, requested: string): ResolvedReadPath {
  const resolvedBase = resolve(base);
  const resolved = normalize(resolve(base, requested));
  const inside = resolved === resolvedBase || resolved.startsWith(resolvedBase + sep);
  const display = inside ? (toPosix(relative(resolvedBase, resolved)) || '.') : toPosix(resolved);
  return { resolved, display, inside };
}

/**
 * Check if a path is within any of the allowed base directories.
 * 
 * @param allowedBases - Array of allowed base directories
 * @param requested - The requested path to validate
 * @returns Validation result with the matching base included
 */
export function validatePathMultiple(
  allowedBases: string[],
  requested: string
): PathValidationResult & { matchedBase?: string } {
  for (const base of allowedBases) {
    const result = validatePath(base, requested);
    if (result.valid) {
      return { ...result, matchedBase: base };
    }
  }
  
  return { valid: false, error: 'Access denied: path not in allowed directories' };
}
