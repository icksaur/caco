/**
 * LRU eviction policy for client-side terminals. Pure + dependency-free so it is
 * unit-testable in node (terminal-panel itself imports browser-only xterm).
 */

/** Given session ids in least→most recently used order, the active id (never
 *  evicted), and the cap, return the ids to evict (oldest first). */
export function selectEvictions(orderedSids: string[], activeSid: string, max: number): string[] {
  const evict: string[] = [];
  let remaining = orderedSids.length;
  for (const sid of orderedSids) {
    if (remaining <= max) break;
    if (sid === activeSid) continue;
    evict.push(sid);
    remaining--;
  }
  return evict;
}
