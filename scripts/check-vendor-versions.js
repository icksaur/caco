#!/usr/bin/env node

/**
 * Check vendored library versions against npm registry.
 * Warns on outdated major/minor versions; exits 0 (advisory only).
 *
 * Usage: node scripts/check-vendor-versions.js
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'public', 'vendor-versions.json'), 'utf8')
);

let warnings = 0;

for (const [pkg, vendored] of Object.entries(manifest)) {
  try {
    const latest = execSync(`npm view ${pkg} version`, { encoding: 'utf8' }).trim();
    if (latest !== vendored) {
      const [vMajor] = vendored.split('.');
      const [lMajor] = latest.split('.');
      const level = vMajor !== lMajor ? 'MAJOR' : 'minor';
      console.warn(`⚠  ${pkg}: vendored ${vendored} → latest ${latest} (${level})`);
      warnings++;
    }
  } catch {
    console.warn(`⚠  ${pkg}: failed to check (npm view error)`);
    warnings++;
  }
}

if (warnings === 0) {
  console.log('✓ All vendored libraries are up to date');
} else {
  console.log(`\n${warnings} vendored ${warnings === 1 ? 'library' : 'libraries'} behind latest`);
}
