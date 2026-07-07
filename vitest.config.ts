import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests in Node environment (not browser)
    environment: 'node',
    
    // Include unit tests only (integration tests use node:test runner)
    include: ['tests/unit/**/*.test.ts'],

    // Silence informational console.log from production code; warnings + errors still print.
    setupFiles: ['tests/setup.ts'],

    // Exclude tests broken by SDK module resolution issues
    exclude: ['tests/unit/applet-tools.test.ts'],
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'public/ts/**/*.ts'],
      exclude: ['**/types.ts', '**/main.ts'],
      reporter: ['text', 'html'],
      // Ratcheting floors. Global floor set at the 2026-07-06 baseline minus a ~1.5pt
      // churn margin (raised as fuzzy-score / fetch-timeout / hostname-hash and the
      // route-logic tests lifted coverage). Per-directory locks keep well-tested dirs
      // from rotting down to the global floor. Raise these as coverage improves; do NOT
      // lower without cause. src/routes is the weakest backend area (~15%): its lock is
      // a low floor that only protects the route-logic tests added in the coverage push
      // (spec-routes-coverage-push) — raise it as more handler logic gets extracted.
      thresholds: {
        statements: 40,
        branches: 35,
        functions: 41,
        lines: 41,
        'src/security/**': { statements: 90, branches: 80, functions: 95, lines: 90 },
        'src/index/**': { statements: 83, branches: 70, functions: 92, lines: 87 },
        'src/observe/**': { statements: 80, branches: 66, functions: 88, lines: 84 },
        'src/workflow/**': { statements: 80, branches: 72, functions: 80, lines: 86 },
        'src/routes/**': { statements: 14, branches: 10, functions: 14, lines: 14 },
      },
    },
    
    // TypeScript support
    typecheck: {
      enabled: false, // We already have tsc --noEmit
    },
  },
});
