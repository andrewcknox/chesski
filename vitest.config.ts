import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts to avoid importing the CJS vault/stockfish server plugins.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
