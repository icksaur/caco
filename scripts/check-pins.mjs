#!/usr/bin/env node

/**
 * check:pins — fail the build when a pinned npm `overrides` entry is no longer
 * needed, so we notice tech-debt pins the moment they become removable.
 *
 * Motivation: our internal npm feed (packagefeedproxy.microsoft.io) occasionally
 * lags the public registry by days-to-weeks. When a transitive dep like `vite`
 * resolves to a version the feed hasn't mirrored yet, `npm install` 404s. The
 * escape hatch is an `overrides` entry pinning the transitive dep down to the
 * highest version the feed does carry. Without a gate, that pin lingers forever;
 * with this gate, the next `npm run build` after the feed catches up will fail
 * loudly telling us to remove the override.
 *
 * Contract: for every `overrides` entry whose value is a plain string version
 * (`"1.2.3"` or `"^1.2.3"` etc.), we ask the ACTIVE registry (whatever
 * `npm config get registry` is set to — internal feed for company machines,
 * public for others) for that package's version list. If the feed carries any
 * published stable version STRICTLY NEWER than the pinned version, the world
 * has moved on and the pin should be re-examined — this script exits non-zero.
 *
 * "Strictly newer" (not >=) is deliberate: the pin's floor version is normally
 * ON the feed (that's why we could pin to it). A newer stable appearing is the
 * signal that the reason we pinned may be resolved. We don't try to reason
 * about transitive-dep availability — a human must confirm that removing the
 * override actually installs cleanly.
 *
 * Nested overrides (an object as value) are documented as a heads-up but not
 * checked automatically — the semantics of the enclosing "only if parent is X"
 * clause makes "is the pin still needed?" package-specific.
 *
 * Zero deps, ESM, portable.
 *
 * Usage: node scripts/check-pins.mjs
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const overrides = pkg.overrides ?? {};
const entries = Object.entries(overrides);

if (entries.length === 0) {
  console.log('✓ no overrides to check');
  process.exit(0);
}

/**
 * Strip a leading semver-range operator so we can compare against feed versions.
 * We treat all range operators the same: the effective "pin floor" is the number.
 * A pin like "^8.2.2" says "you already accept anything >= 8.2.2 <9.0.0", so if
 * the feed carries 8.2.2 the pin is redundant.
 */
function pinFloor(spec) {
  const m = /^[~^><=v\s]*([\d.]+)/.exec(spec);
  return m ? m[1] : spec;
}

/** semver compare: -1 / 0 / +1. Ignores prerelease tags (we only compare stables). */
function cmp(a, b) {
  const pa = a.split('.').map(n => Number.parseInt(n, 10));
  const pb = b.split('.').map(n => Number.parseInt(n, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/** True if `v` is a stable release (no prerelease tag). */
function isStable(v) {
  return !/[-+]/.test(v);
}

let stalePins = 0;
let unresolved = 0;

for (const [name, spec] of entries) {
  if (typeof spec !== 'string') {
    console.log(`ℹ  ${name}: nested override, manual review only`);
    continue;
  }
  const floor = pinFloor(spec);
  let versions;
  try {
    const raw = execSync(`npm view ${name} versions --json`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    versions = JSON.parse(raw);
    if (!Array.isArray(versions)) versions = [versions];
  } catch (err) {
    console.warn(`⚠  ${name}: failed to query registry (${err.message.split('\n')[0]})`);
    unresolved++;
    continue;
  }
  const stableAbove = versions.filter(v => isStable(v) && cmp(v, floor) > 0);
  if (stableAbove.length > 0) {
    const highest = stableAbove.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
    const cmd = '`npm install`';
    console.error(
      `✗ ${name}: pinned to "${spec}" but the active registry now carries stable ${highest} (> ${floor}). ` +
      `Consider removing the override from package.json and re-running ${cmd} — ` +
      'the reason we pinned may no longer apply.'
    );
    stalePins++;
  } else {
    console.log(`✓ ${name}: pin "${spec}" still current (registry max stable <= ${floor})`);
  }
}

if (stalePins > 0) {
  console.error(`\n✗ ${stalePins} stale pin(s) in package.json overrides — remove and reinstall.`);
  process.exit(1);
}
if (unresolved > 0) {
  // Registry unreachable is advisory, not a build fail — offline dev must still work.
  console.warn(`\n⚠  ${unresolved} pin(s) could not be checked; treat as advisory.`);
}
console.log('\n✓ all overrides are still required');
