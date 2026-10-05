-- #889 slice 5: battle stats on a grudge target, named to match the war room.
--
-- ⚠️ THE COLUMN NAMES ARE THE POINT. `frontend/src/utils/fairFight.js` already
-- exports `targetBattleStats(row)`, which reads `bsp_str / bsp_spd / bsp_def /
-- bsp_dex / bsp_total`. Naming these the same way means the Fair Fight module
-- reads a grudge row with ZERO changes — no adapter, no second mapping of
-- "which field is defense". That file's own comment says three copies of that
-- mapping is exactly how surfaces end up quietly disagreeing.
--
-- ⚠️ This is naming convergence, NOT coupling. Nothing here references
-- `war_room_state_v2`, and the shared code is a leaf module with no imports.
-- A war-room migration must never be able to break a grudge.
--
-- 0069 shipped a single `battle_stats` total, which cannot express a Fair
-- Fight: the BS score is a sum of square ROOTS, so two targets with identical
-- totals split differently score differently. The four stats are needed, and
-- the total alone only supports an estimate.
--
-- ⚠️ These columns were never populated (slice 4 does not write them), so the
-- renames move no data. They are renames rather than drop-and-add so a future
-- reader can see the shape changed rather than finding columns that silently
-- appeared.
-- ⚠️ **GUARDED RENAMES, and this is not optional.** A NEW tenant database is
-- provisioned from `template.sql` — which already carries the final shape — and
-- then run through the WHOLE migration history. Every migration therefore has
-- to be a no-op against a database that already looks finished.
--
-- `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` handle that for
-- free. **`RENAME COLUMN` has no `IF EXISTS`**, so the bare form below threw
-- `column "battle_stats" does not exist` on every freshly provisioned database
-- and aborted the deploy — for ALL tenants, because one database failing stops
-- the run. Production sat three versions behind until this was found.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'grudge_targets'
                AND column_name = 'battle_stats') THEN
    ALTER TABLE public.grudge_targets RENAME COLUMN battle_stats TO bsp_total;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'grudge_targets'
                AND column_name = 'stats_source') THEN
    ALTER TABLE public.grudge_targets RENAME COLUMN stats_source TO spy_source;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'grudge_targets'
                AND column_name = 'stats_fetched_at') THEN
    ALTER TABLE public.grudge_targets RENAME COLUMN stats_fetched_at TO bsp_fetched_at;
  END IF;
END $$;

ALTER TABLE public.grudge_targets ADD COLUMN IF NOT EXISTS bsp_str bigint;
ALTER TABLE public.grudge_targets ADD COLUMN IF NOT EXISTS bsp_spd bigint;
ALTER TABLE public.grudge_targets ADD COLUMN IF NOT EXISTS bsp_def bigint;
ALTER TABLE public.grudge_targets ADD COLUMN IF NOT EXISTS bsp_dex bigint;

-- ⚠️ When the SPY was taken, which is a different fact from when WE fetched it.
-- A TornStats spy carries its own capture time and may be months old;
-- `bsp_fetched_at` would say "a minute ago" and be useless for judging it. BSP
-- gives no capture time at all, so this stays NULL there — absent, not zero.
ALTER TABLE public.grudge_targets ADD COLUMN IF NOT EXISTS ts_spy_at timestamptz;
