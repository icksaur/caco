/**
 * Chain Stack - Stack collapse algorithm for agent call chains
 * 
 * Collapses return patterns to detect effective call depth:
 * - [1, 2, 1] → [1] (returned to 1, collapsed)
 * - [1, 2, 1, 2] → [1, 2] (returned to 2)
 * - [1, 2, 3] → [1, 2, 3] (no returns, grows)
 */

/**
 * Collapse a call chain using stack algorithm
 * 
 * When an agent returns to a session already in the chain, 
 * we pop back to that session (delegation complete).
 * 
 * @param rawChain - Sequence of session IDs: ['1', '2', '1', '2']
 * @returns Collapsed stack representing effective depth
 * 
 * @example
 * collapseChain(['1', '2', '1']) // → ['1']
 * collapseChain(['1', '2', '1', '2', '1']) // → ['1']
 * collapseChain(['1', '2', '3']) // → ['1', '2', '3']
 */
export function collapseChain(rawChain: string[]): string[] {
  const stack: string[] = [];
  
  for (const sessionId of rawChain) {
    const existingIndex = stack.indexOf(sessionId);
    if (existingIndex !== -1) {
      // Return to existing session - pop back to it
      stack.length = existingIndex + 1;
    } else {
      // New session - push
      stack.push(sessionId);
    }
  }
  
  return stack;
}

/**
 * Get effective depth from collapsed chain
 * 
 * @param rawChain - Sequence of session IDs
 * @returns Depth (length of collapsed stack)
 */
export function getEffectiveDepth(rawChain: string[]): number {
  return collapseChain(rawChain).length;
}

/**
 * Get unique session count from chain
 * 
 * @param rawChain - Sequence of session IDs
 * @returns Number of unique sessions involved
 */
export function getUniqueSessionCount(rawChain: string[]): number {
  return new Set(rawChain).size;
}
