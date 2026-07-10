/**
 * API Documentation Coverage Test
 *
 * Scrapes route registrations from src/routes/*.ts and verifies each endpoint
 * appears in API.md. Catches new or renamed routes that haven't been documented.
 *
 * Coverage is EXHAUSTIVE BY CONSTRUCTION: the file→mount-prefix map is derived
 * from the actual source of truth (src/routes/index.ts re-exports + server.ts
 * app.use mounts), never a hand-maintained allowlist. Any route file that
 * registers routes but is not mounted — the way a whole feature module could
 * previously slip coverage silently — fails the "every route file is mounted"
 * assertion. Add a new mounted route file and it is covered automatically.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const routesDir = join(__dirname, '../../src/routes');
const serverPath = join(__dirname, '../../server.ts');

/** Route files that legitimately register no HTTP routes (so they need no mount
 *  prefix and are exempt from the "every route file is mounted" check). */
const NON_ROUTE_FILES = new Set(['index.ts', 'websocket.ts']);

const ROUTE_REGISTRATION = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'/;

/**
 * Derive `file → mount prefix` from the source of truth:
 *  1. src/routes/index.ts maps each `router as <var>` export to its file.
 *  2. server.ts maps each `app.use('<prefix>', <var>)` to its prefix.
 * Composing the two yields the client-facing prefix for every mounted router,
 * with no hand-maintained list to fall out of date.
 */
function deriveFilePrefixes(): Record<string, string> {
  const indexSrc = readFileSync(join(routesDir, 'index.ts'), 'utf-8');
  const exportToFile: Record<string, string> = {};
  const exportRe = /export\s*\{\s*router as (\w+)\s*\}\s*from\s*'\.\/([\w-]+)\.js'/g;
  for (const m of indexSrc.matchAll(exportRe)) {
    exportToFile[m[1]] = `${m[2]}.ts`;
  }

  const serverSrc = readFileSync(serverPath, 'utf-8');
  const useRe = /app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g;
  const fileToPrefix: Record<string, string> = {};
  for (const m of serverSrc.matchAll(useRe)) {
    const [, prefix, varName] = m;
    const file = exportToFile[varName];
    if (file) fileToPrefix[file] = prefix;
  }
  return fileToPrefix;
}

/** All route files under src/routes that register at least one HTTP route. */
function routeFilesWithRegistrations(): string[] {
  return readdirSync(routesDir).filter((file) => {
    if (!file.endsWith('.ts') || NON_ROUTE_FILES.has(file)) return false;
    return new RegExp(ROUTE_REGISTRATION, 'm').test(readFileSync(join(routesDir, file), 'utf-8'));
  });
}

interface Route {
  method: string;
  path: string;       // Full path as it appears to clients
  file: string;
  line: number;
}

/** Extract route registrations from every mounted route file. */
function extractRoutes(fileToPrefix: Record<string, string>): Route[] {
  const routes: Route[] = [];
  const pattern = new RegExp(ROUTE_REGISTRATION);

  for (const [file, prefix] of Object.entries(fileToPrefix)) {
    const content = readFileSync(join(routesDir, file), 'utf-8');
    for (const [i, line] of content.split('\n').entries()) {
      const match = line.match(pattern);
      if (match) {
        const [, method, routePath] = match;
        // Normalize: strip Express-specific param syntax for matching
        // /sessions/:sessionId/resume → /sessions/:id/resume
        const normalizedPath = routePath.replace(/:sessionId/g, ':id').replace(/\*path/g, '*');
        routes.push({
          method: method.toUpperCase(),
          path: `${prefix}${normalizedPath}`,
          file,
          line: i + 1,
        });
      }
    }
  }

  return routes;
}

describe('API.md coverage', () => {
  const apiDoc = readFileSync(join(__dirname, '../../API.md'), 'utf-8');
  const fileToPrefix = deriveFilePrefixes();
  const routes = extractRoutes(fileToPrefix);

  it('every route file with registrations is mounted (no silent coverage gaps)', () => {
    const unmapped = routeFilesWithRegistrations().filter((file) => !(file in fileToPrefix));
    expect(
      unmapped,
      `These route files register HTTP routes but are not mounted in server.ts, so their routes escape API.md enforcement: ${unmapped.join(', ')}. Mount them (app.use) or, if a file legitimately registers no routes, add it to NON_ROUTE_FILES.`
    ).toEqual([]);
  });

  it('found routes to check', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  for (const route of routes) {
    it(`documents ${route.method} ${route.path}`, () => {
      expect(
        apiDoc.includes(route.path),
        `${route.method} ${route.path} (${route.file}:${route.line}) not found in API.md`
      ).toBe(true);
    });
  }
});
