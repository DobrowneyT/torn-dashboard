/**
 * Names of the prepared template databases on the run's shared cluster.
 *
 * ⚠️ A module with NO imports, and that is the whole reason it exists.
 * `globalPostgres.ts` (the vitest globalSetup) creates these; `sharedPostgres.ts`
 * (imported by test files) clones them. globalSetup runs in a different context
 * where importing `vitest` throws "Vitest failed to access its internal state",
 * so it cannot import the file that calls `inject()` — and test files should not
 * drag `embedded-postgres` into every worker just to learn a string. Neither
 * side can own these names, so nothing does.
 */

/** Cloned by `startTestStack` — a real new-faction database. */
export const FACTION_TEMPLATE_DB = 'tpl_faction'

/** Cloned by the admin-plane tests — the shared `global` database. */
export const GLOBAL_TEMPLATE_DB = 'tpl_global'
