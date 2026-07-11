import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests in Node environment (not browser)
    environment: 'node',
    
    // Include unit tests only (integration tests use node:test runner)
    include: ['tests/unit/**/*.test.ts'],

    // Silence informational console.log from production code; warnings + errors still print.
    setupFiles: ['tests/setup.ts'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'public/ts/**/*.ts'],
      // terminal-panel.ts: xterm.js renders to a real canvas jsdom can't implement;
      // unit-testing it is fake, so it's the one fixed up-front frontend exclusion
      // (spec-frontend-coverage). The frontend denominator is public/ts minus this file.
      exclude: ['**/types.ts', '**/main.ts', 'public/ts/terminal-panel.ts'],
      reporter: ['text', 'html', 'json-summary'],
      // Ratcheting floors. Global floor tracks the current baseline minus a ~1.5pt
      // churn margin (last raised 2026-07-10, spec-backend-coverage-80 COMPLETE:
      // backend src/** reached 81.6%; src/routes 24→69%). The authoritative backend-80
      // gate is `npm run check:coverage` (src/** aggregate, FLOOR now 80 = goal met);
      // these vitest floors are the fine-grained anti-rot net. Raise as coverage
      // improves; do NOT lower without cause.
      thresholds: {
        statements: 77,
        branches: 67,
        functions: 76,
        lines: 79,
        'src/security/**': { statements: 90, branches: 80, functions: 95, lines: 90 },
        'src/index/**': { statements: 83, branches: 70, functions: 92, lines: 87 },
        'src/observe/**': { statements: 80, branches: 66, functions: 88, lines: 84 },
        'src/workflow/**': { statements: 80, branches: 72, functions: 80, lines: 86 },
        'src/routes/**': { statements: 67, branches: 56, functions: 68, lines: 68 },
        'public/ts/**': { statements: 73, branches: 62, functions: 68, lines: 76 },
      },
    },
    
    // TypeScript support
    typecheck: {
      enabled: false, // We already have tsc --noEmit
    },
  },
});
