/**
 * Oracles for the lockfile guard (scripts/check-lockfile.mjs).
 *
 * The failure this prevents has happened twice: an `npm install` run against a
 * corporate mirror rewrites every `resolved` host AND downgrades every
 * `integrity` from sha512 to sha1, and the diff is too large to catch by eye.
 * Both halves must be caught independently — the first time, only the URL was
 * noticed and the weak hashes rode along.
 */

import { describe, it, expect } from 'vitest';
import { findLockfileViolations, type LockfileShape } from '../../scripts/check-lockfile.mjs';

const PUBLIC = 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz';
const MIRROR = 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/left-pad/-/left-pad-1.3.0.tgz';
const SHA512 = 'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEg==';
const SHA1 = 'sha1-q2X8s5A6pfK8X/jwVxKawt1bsts=';

function lock(packages: LockfileShape['packages']): LockfileShape {
  return { packages };
}

describe('findLockfileViolations', () => {
  it('passes a lockfile that is entirely public and sha512', () => {
    const v = findLockfileViolations(lock({
      '': { name: 'caco' },
      'node_modules/left-pad': { version: '1.3.0', resolved: PUBLIC, integrity: SHA512 },
    }));

    expect(v).toEqual([]);
  });

  it('flags a resolved URL pointing at an internal mirror', () => {
    const v = findLockfileViolations(lock({
      'node_modules/left-pad': { version: '1.3.0', resolved: MIRROR, integrity: SHA512 },
    }));

    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('non-public-registry');
    expect(v[0].path).toBe('node_modules/left-pad');
  });

  it('flags a sha1 integrity even when the URL is already public', () => {
    // The first occurrence was "fixed" by rewriting URLs only; the weak hashes
    // survived. This is the assertion that would have caught that.
    const v = findLockfileViolations(lock({
      'node_modules/left-pad': { version: '1.3.0', resolved: PUBLIC, integrity: SHA1 },
    }));

    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('weak-integrity');
  });

  it('reports both problems separately for one mirror-rewritten entry', () => {
    const v = findLockfileViolations(lock({
      'node_modules/left-pad': { version: '1.3.0', resolved: MIRROR, integrity: SHA1 },
    }));

    expect(v.map(x => x.kind).sort()).toEqual(['non-public-registry', 'weak-integrity']);  });

  it('ignores an entry with no resolved URL (workspace link, bundled dep)', () => {
    const v = findLockfileViolations(lock({
      '': { name: 'caco', version: '1.0.0' },
      'node_modules/local-thing': { resolved: undefined, link: true },
    }));

    expect(v).toEqual([]);
  });

  it('does not demand integrity from an entry that has none', () => {
    const v = findLockfileViolations(lock({
      'node_modules/left-pad': { version: '1.3.0', resolved: PUBLIC },
    }));

    expect(v).toEqual([]);
  });

  it('flags a resolved value that is not a URL at all', () => {
    const v = findLockfileViolations(lock({
      'node_modules/left-pad': { version: '1.3.0', resolved: 'not-a-url' },
    }));

    expect(v[0].kind).toBe('unparseable-url');
  });

  it('rejects a lookalike host rather than matching on a substring', () => {
    const v = findLockfileViolations(lock({
      'node_modules/left-pad': {
        resolved: 'https://registry.npmjs.org.evil.example/left-pad/-/left-pad-1.3.0.tgz',
        integrity: SHA512,
      },
    }));

    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('non-public-registry');
  });

  it('tolerates a lockfile with no packages map', () => {
    expect(findLockfileViolations({})).toEqual([]);
    expect(findLockfileViolations(null)).toEqual([]);
  });
});
