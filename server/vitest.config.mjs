import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // ⚠️ ONE embedded Postgres for the whole run — see test/globalPostgres.ts.
    // Every test file used to boot its own cluster (`initdb` + `start` + schema
    // + `stop`, ~1.6s apiece, 83 times) and that was the entire mechanism
    // behind the intermittent red build: `initdb` is I/O-bound and CPU-hungry,
    // vitest runs one worker per core, and this runner has four cores while
    // also hosting all five production tenants and a second Actions runner.
    // The symptom was never an assertion — always `Hook timed out` in whichever
    // file happened to be starting when the box was busiest.
    globalSetup: ['./test/globalPostgres.ts'],

    // ⚠️ The #663 cap of 2 is GONE, deliberately. It was the first attempt at
    // the same flake and it made things worse — measured 100–150s slower —
    // because starving the parallelism does not stop 83 cluster bootstraps from
    // oversubscribing the box; it only makes them queue. With the bootstraps
    // gone a worker that loses the CPU race now just runs slower instead of
    // blowing a hook timeout, so the default (one per core) is safe again.
    // Capped explicitly rather than left undefined so that a future runner with
    // more cores cannot stampede the production containers sharing this box.
    poolOptions: {
      threads: { maxThreads: process.env.CI ? 4 : undefined, minThreads: 1 },
    },

    testTimeout: 120_000,
    // Still generous, but no longer load-bearing: per-file setup is now a
    // `CREATE DATABASE ... TEMPLATE` (~44ms), not a cluster bootstrap.
    hookTimeout: 60_000,
  },
})
