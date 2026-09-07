import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Booting an embedded Postgres and applying the full template takes a
    // while, especially on cold CI runners.
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
