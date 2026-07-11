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
      reporter: ['text', 'html', 'json-summary'],
      // Ratcheting floors. Global floor tracks the current baseline minus a ~1.5pt
      // churn margin (last raised 2026-07-10, Phase 1 of spec-backend-coverage-80:
      // fs stores + route harnesses lifted backend src/** 50.5→54.7%). Per-directory
      // locks keep well-tested dirs from rotting down to the global floor. The
      // authoritative backend-80 gate is `npm run check:coverage` (src/** aggregate);
      // these vitest floors are the fine-grained anti-rot net. Raise as coverage
      // improves; do NOT lower without cause.
      thresholds: {
        statements: 44,
        branches: 39,
        functions: 45,
        lines: 45,
        'src/security/**': { statements: 90, branches: 80, functions: 95, lines: 90 },
        'src/index/**': { statements: 83, branches: 70, functions: 92, lines: 87 },
        'src/observe/**': { statements: 80, branches: 66, functions: 88, lines: 84 },
        'src/workflow/**': { statements: 80, branches: 72, functions: 80, lines: 86 },
        'src/routes/**': { statements: 22, branches: 18, functions: 23, lines: 22 },
      },
    },
    
    // TypeScript support
    typecheck: {
      enabled: false, // We already have tsc --noEmit
    },
  },
});
