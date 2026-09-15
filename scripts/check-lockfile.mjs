#!/usr/bin/env node

/**
 * check:lockfile — fail the build when package-lock.json carries anything that
 * only works on one machine's network, or weakens supply-chain integrity.
 *
 * Motivation: this repo is public, but it is also installed from a corporate
 * machine whose npm is pointed at an internal mirror. When `npm install` runs
 * there, npm rewrites EVERY `resolved` URL in the lockfile to the mirror's
 * host and (observed 2026-09-15) downgrades every `integrity` hash from the
 * registry's sha512 to a sha1 the mirror computes itself. Committing that
 * lockfile does two bad things at once:
 *
 *   1. Leaks internal infrastructure hostnames into a public repo, and makes
 *      `npm install` fail for everyone else with EALLOWREMOTE / 404.
 *   2. Silently downgrades tamper-detection to sha1, which is broken.
 *
 * Both are invisible in review — a lockfile diff is thousands of lines and the
 * host change hides among them. It has happened twice. This gate makes the
 * third time impossible.
 *
 * Contract: every `resolved` URL must point at the public registry, and every
 * entry that has an `integrity` must use sha512 (npm's current default). An
 * entry with no `resolved` (workspace links, bundled deps) is not checked.
 *
 * Fixing a flagged lockfile: re-resolve each offending entry against
 * registry.npmjs.org, taking BOTH the public `dist.tarball` and the public
 * `dist.integrity` — rewriting the URL alone leaves the weak hash behind.
 *
 * Zero deps, ESM, portable. Usage: node scripts/check-lockfile.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lockPath = join(__dirname, '..', 'package-lock.json');

/** The only host a committed `resolved` URL may point at. */
const PUBLIC_REGISTRY_HOST = 'registry.npmjs.org';

/**
 * Pure over the lockfile object so the rules are testable without a fixture
 * file on disk. Returns one finding per offending entry.
 */
export function findLockfileViolations(lock) {
  const violations = [];
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const { resolved, integrity } = entry;
    if (typeof resolved === 'string' && resolved.length > 0) {
      let host = null;
      try {
        host = new URL(resolved).host;
      } catch {
        violations.push({ path, kind: 'unparseable-url', detail: resolved });
        continue;
      }
      if (host !== PUBLIC_REGISTRY_HOST) {
        violations.push({ path, kind: 'non-public-registry', detail: host });
      }
    }
    // Only entries that HAVE an integrity are checked; absence is a separate
    // (legitimate) case such as a local file: link.
    if (typeof integrity === 'string' && integrity.length > 0 && !integrity.startsWith('sha512-')) {
      violations.push({ path, kind: 'weak-integrity', detail: integrity.split('-')[0] });
    }
  }
  return violations;
}

/** Run the check and exit. Guarded so importing this module for its rules
 *  (the unit test does) neither reads the real lockfile nor calls process.exit. */
function main() {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const violations = findLockfileViolations(lock);

  if (violations.length === 0) {
    const checked = Object.values(lock.packages ?? {}).filter(e => e?.resolved).length;
    console.log(`✓ package-lock.json: ${checked} resolved entries, all on ${PUBLIC_REGISTRY_HOST} with sha512`);
    return 0;
  }

  const byKind = new Map();
  for (const v of violations) {
    if (!byKind.has(v.kind)) byKind.set(v.kind, []);
    byKind.get(v.kind).push(v);
  }

  console.error('✗ package-lock.json contains machine-specific or weakened entries:\n');
  for (const [kind, list] of byKind) {
    const hosts = [...new Set(list.map(v => v.detail))];
    console.error(`  ${kind}: ${list.length} entr${list.length === 1 ? 'y' : 'ies'} (${hosts.slice(0, 3).join(', ')}${hosts.length > 3 ? ', …' : ''})`);
    for (const v of list.slice(0, 5)) console.error(`    ${v.path}`);
    if (list.length > 5) console.error(`    … and ${list.length - 5} more`);
  }
  console.error(
    '\nThis lockfile was almost certainly produced by an `npm install` run against ' +
    'an internal mirror. Re-resolve the offending entries against ' +
    `https://${PUBLIC_REGISTRY_HOST}, taking BOTH dist.tarball and dist.integrity ` +
    '(the URL alone is not enough — the mirror also rewrites the hash).'
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
