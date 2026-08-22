import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every test file here also boots its own embedded Postgres — same as
    // db/vitest.config.mjs, which already carries this. server/ never did,
    // and ran on vitest's 10s default hook timeout instead: the two flakes
    // this uncovered (a teardown-race "pool is closed", and a bootstrap
    // test's "Hook timed out in 10000ms") were both cold-boot timing, not
    // real failures — both passed clean on an immediate re-run.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
})
