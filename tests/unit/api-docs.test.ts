/**
 * API Documentation Coverage Test
 * 
 * Scrapes route registrations from src/routes/*.ts and verifies
 * each endpoint appears in doc/API.md. Catches new or renamed
 * routes that haven't been documented.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/** Route prefix per file, matching server.ts mount points */
const ROUTE_PREFIXES: Record<string, string> = {
  'sessions.ts': '/api',
  'session-messages.ts': '/api',
  'api.ts': '/api',
  'mcp.ts': '/api/mcp',
  'schedule.ts': '/api',
  'shell.ts': '/api',
};

interface Route {
  method: string;
  path: string;       // Full path as it appears to clients
  file: string;
  line: number;
}

/** Extract route registrations from source files */
function extractRoutes(): Route[] {
  const routesDir = join(__dirname, '../../src/routes');
  const routes: Route[] = [];
  const pattern = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'/;

  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith('.ts') || !(file in ROUTE_PREFIXES)) continue;

    const prefix = ROUTE_PREFIXES[file];
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
  const apiDoc = readFileSync(join(__dirname, '../../doc/API.md'), 'utf-8');
  const routes = extractRoutes();

  it('found routes to check', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  for (const route of extractRoutes()) {
    it(`documents ${route.method} ${route.path}`, () => {
      // Check that the path appears somewhere in the doc
      // Normalize :sessionId → :id in doc matching (doc uses :id shorthand)
      const docPath = route.path;
      expect(
        apiDoc.includes(docPath),
        `${route.method} ${route.path} (${route.file}:${route.line}) not found in API.md`
      ).toBe(true);
    });
  }
});
