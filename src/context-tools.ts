/**
 * Context Utilities
 * 
 * Merge logic for session context sets (files).
 * Used by auto-populate (session-messages) and PATCH endpoint (sessions route).
 */

/** Known set names for validation (typos trigger warning) */
export const KNOWN_SET_NAMES = new Set(['files']);

/** Max items per set */
const MAX_ITEMS_PER_SET = 10;

/**
 * Merge context set items based on mode.
 * Pure function for testability.
 */
export function mergeContextSet(
  existing: string[],
  items: string[],
  mode: 'replace' | 'merge'
): string[] {
  if (mode === 'replace') {
    return items.slice(0, MAX_ITEMS_PER_SET);
  }
  return [...new Set([...existing, ...items])].slice(0, MAX_ITEMS_PER_SET);
}
