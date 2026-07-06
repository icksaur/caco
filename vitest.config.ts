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
      // churn margin (tightened after adding fuzzy-score / fetch-timeout / hostname-hash
      // tests raised the floor to ~40.9% stmts). Per-directory locks keep the well-tested
      // core (security/index/observe/workflow) from rotting down to the global floor.
      // Raise these as coverage improves; do NOT lower without cause. Weak areas
      // (src/routes ~11%, public/ts ~30%) are only protected by the global floor
      // today — add dir locks for them once their coverage climbs.
      thresholds: {
        statements: 39,
        branches: 34,
        functions: 40,
        lines: 40,
        'src/security/**': { statements: 90, branches: 80, functions: 95, lines: 90 },
        'src/index/**': { statements: 83, branches: 70, functions: 92, lines: 87 },
        'src/observe/**': { statements: 80, branches: 66, functions: 88, lines: 84 },
        'src/workflow/**': { statements: 80, branches: 72, functions: 80, lines: 86 },
      },
    },
    
    // TypeScript support
    typecheck: {
      enabled: false, // We already have tsc --noEmit
    },
  },
});
