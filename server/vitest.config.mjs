import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every test file here also boots its own embedded Postgres — same as
    // db/vitest.config.mjs, which already carries this. server/ never did,
    // and ran on vitest's 10s default hook timeout instead: the two flakes
    // this uncovered (a teardown-race "pool is closed", and a bootstrap
    // test's "Hook timed out in 10000ms") were both cold-boot timing, not
    // real failures — both passed clean on an immediate re-run.
    // ⚠️ Cap the worker count on CI. Every test file here boots its OWN
    // embedded Postgres, and vitest defaults to one worker per core — so a
    // 4-core runner tries to `initdb` four clusters at once. That runner also
    // hosts the five production tenant containers AND a second Actions runner,
    // so two suites can overlap: up to eight clusters competing for four cores
    // that are already busy.
    //
    // The symptom is never an assertion. It is `Hook timed out in 180000ms` in
    // whichever file happened to be starting when the box was busiest —
    // admin-provisioning, scrapers-jobs and oc have each drawn the short straw,
    // and every one of them passes in seconds when run alone. Raising the
    // timeout again would only widen the window; the fix is to stop asking the
    // machine for more than it has.
    //
    // Two, not one: this is usually FASTER than the uncapped default under
    // contention, because four starved `initdb`s finish later than two that
    // actually get CPU. Left uncapped off CI, where nothing else competes.
    poolOptions: {
      threads: { maxThreads: process.env.CI ? 2 : undefined, minThreads: 1 },
    },
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
})
