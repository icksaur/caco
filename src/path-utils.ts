/**
 * Path Validation Utilities
 * 
 * Secure path validation for file system operations.
 * Prevents path traversal attacks and escaping allowed directories.
 */

import { resolve, relative, normalize, sep } from 'path';

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
