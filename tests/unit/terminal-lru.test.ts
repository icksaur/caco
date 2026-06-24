import { describe, it, expect } from 'vitest';
import { selectEvictions } from '../../public/ts/terminal-lru.js';

/**
 * LRU eviction policy for client-side terminals (cap = 3). Input is least→most
 * recently used; the active session is never evicted; only the oldest beyond the
 * cap are dropped.
 */
describe('selectEvictions', () => {
  it('evicts nothing at or under the cap', () => {
    expect(selectEvictions(['a', 'b', 'c'], 'c', 3)).toEqual([]);
    expect(selectEvictions(['a', 'b'], 'b', 3)).toEqual([]);
  });

  it('evicts the oldest beyond the cap', () => {
    // 4 terms, active is the newest (d): drop the single oldest (a).
    expect(selectEvictions(['a', 'b', 'c', 'd'], 'd', 3)).toEqual(['a']);
  });

  it('never evicts the active session even when it is the oldest', () => {
    // active = a (oldest). Keep a + the 2 newest; evict b (next oldest).
    const evicted = selectEvictions(['a', 'b', 'c', 'd'], 'a', 3);
    expect(evicted).not.toContain('a');
    expect(evicted).toEqual(['b']);
  });

  it('evicts multiple when far over the cap, skipping the active', () => {
    // 6 terms, cap 3, active = f → evict the 3 oldest non-active (a,b,c).
    expect(selectEvictions(['a', 'b', 'c', 'd', 'e', 'f'], 'f', 3)).toEqual(['a', 'b', 'c']);
  });

  it('protects the active while evicting around it', () => {
    // active = b. Need to drop 2 of 5; b is protected → evict a then c.
    expect(selectEvictions(['a', 'b', 'c', 'd', 'e'], 'b', 3)).toEqual(['a', 'c']);
  });

  it('handles a single terminal', () => {
    expect(selectEvictions(['a'], 'a', 3)).toEqual([]);
  });
});
