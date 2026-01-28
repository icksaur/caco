import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests in Node environment (not browser)
    environment: 'node',
    
    // Include unit tests only (integration tests use node:test runner)
    include: ['tests/unit/**/*.test.ts'],
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'public/ts/**/*.ts'],
      exclude: ['**/types.ts', '**/main.ts'],
      reporter: ['text', 'html'],
    },
    
    // TypeScript support
    typecheck: {
      enabled: false, // We already have tsc --noEmit
    },
  },
});
