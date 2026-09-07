-- #606 slice 3: retire `oc-scenarios-mirror` and its three per-tenant tables.
--
-- The scenario model is Torn game data — the flowchart for Crane Reaction is
-- the same for every faction on the planet and changes when Torn ships an
-- update, perhaps a few times a year. Mirroring it per tenant on a schedule
-- spent API budget and scraper slots on a constant, and let two tenants
-- disagree about a fact that cannot differ between them. Worse, the mirror ran
-- only where somebody had enabled the job: on 2026-09-06 three of five live
-- tenants held ZERO scenarios and their Simulator was silently empty.
--
-- The model now ships in the image (v3.84.0 onward) and carries everything
-- these tables held that was global.
--
-- ⚠️ WHAT MOVED WHERE, because getting this wrong silently deletes data:
--
--   * structure, roles, endings, diagrams  -> the image (global)
--   * observed_paths                       -> the image. Despite its name this
--     is how many paths TORNPROBABILITY observed, not us.
--   * oc_scenario_node_stats               -> the image. Also global: the
--     mirror wrote it straight from the upstream feed's `stats` frame, so it
--     was never a faction's own results. Dropping it without carrying it first
--     would have stripped the per-node payouts, E(x) and success figures the
--     Simulator renders, and an empty stats map looks exactly like a node
--     nobody has run.
--   * ending_map_* (4 columns)             -> `oc_scenario_quality`, BELOW.
--     These are ours, derived by the maintainer probe sweep (#471/#473)
--     against a tenant's own data, so they stay per-tenant.
--   * fetched_at                           -> nothing. It meant "when we last
--     fetched from tornprobability"; with no fetcher there is no honest value,
--     and a build timestamp would assert a freshness the data does not have.

-- ⚠️ Created and BACKFILLED before anything is dropped. The four columns below
-- exist only here after this migration, and `oc_scenarios` is dropped in the
-- same transaction — so a create-after-drop ordering would lose them with no
-- way back.
CREATE TABLE IF NOT EXISTS public.oc_scenario_quality (
  -- ⚠️ No foreign key, deliberately. The old columns lived on `oc_scenarios`
  -- and died with it; keying to any surviving table would recreate exactly the
  -- coupling this migration exists to remove. A row for a scenario Torn later
  -- renames is harmless — it simply stops being read.
  scenario_name             text PRIMARY KEY,
  -- #471: how well the simulated distribution matched the API's. `ok` means
  -- every reported ending got a node; `confident` means the numbers behind
  -- that assignment line up — a map can be complete and still be wrong about
  -- which ending is which.
  ending_map_residual       numeric,
  ending_map_confident      boolean,
  -- #473: the same disagreement weighted by how much probability each ending
  -- carries. The plain residual is scale-free (right for choosing an
  -- assignment, misleading for judging money); this one is what E(x) can be
  -- trusted on. They disagree in both directions, so both are kept.
  ending_map_money_residual numeric,
  ending_map_money_confident boolean,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Carry the existing measurements across. Guarded so this migration also
-- applies to a database created from a template that never had the mirror.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'oc_scenarios') THEN
    INSERT INTO public.oc_scenario_quality
      (scenario_name, ending_map_residual, ending_map_confident,
       ending_map_money_residual, ending_map_money_confident)
    SELECT name, ending_map_residual, ending_map_confident,
           ending_map_money_residual, ending_map_money_confident
      FROM public.oc_scenarios
     WHERE ending_map_residual IS NOT NULL
        OR ending_map_confident IS NOT NULL
        OR ending_map_money_residual IS NOT NULL
        OR ending_map_money_confident IS NOT NULL
    ON CONFLICT (scenario_name) DO NOTHING;
  END IF;
END $$;

-- ⚠️ CASCADE is required, not convenience: `oc_scenario_node_stats`,
-- `oc_scenario_roles` and `oc_scenario_endings` all carry
-- `REFERENCES oc_scenarios(name) ON DELETE CASCADE`, so the parent cannot be
-- dropped while they exist. They are listed explicitly anyway — an implicit
-- cascade that silently removed something unlisted is precisely the accident
-- this migration must not have.
DROP TABLE IF EXISTS public.oc_scenario_node_stats;
DROP TABLE IF EXISTS public.oc_scenario_roles;
DROP TABLE IF EXISTS public.oc_scenario_endings;
DROP TABLE IF EXISTS public.oc_scenarios CASCADE;

-- The job's own scheduling rows. Leaving these behind would keep it listed on
-- the Global Admin scraper page as a job that no longer exists.
DELETE FROM public.scraper_jobs WHERE job_name = 'oc-scenarios-mirror';
DELETE FROM public.scraper_runs WHERE job_name = 'oc-scenarios-mirror';
