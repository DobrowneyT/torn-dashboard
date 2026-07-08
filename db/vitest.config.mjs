import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Booting an embedded Postgres and applying the full template takes a
    // while, especially on cold CI runners.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
})
