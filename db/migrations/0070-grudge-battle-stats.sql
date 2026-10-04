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
ALTER TABLE public.grudge_targets RENAME COLUMN battle_stats TO bsp_total;
ALTER TABLE public.grudge_targets RENAME COLUMN stats_source TO spy_source;
ALTER TABLE public.grudge_targets RENAME COLUMN stats_fetched_at TO bsp_fetched_at;

ALTER TABLE public.grudge_targets ADD COLUMN IF NOT EXISTS bsp_str bigint;
ALTER TABLE public.grudge_targets ADD COLUMN IF NOT EXISTS bsp_spd bigint;
ALTER TABLE public.grudge_targets ADD COLUMN IF NOT EXISTS bsp_def bigint;
ALTER TABLE public.grudge_targets ADD COLUMN IF NOT EXISTS bsp_dex bigint;

-- ⚠️ When the SPY was taken, which is a different fact from when WE fetched it.
-- A TornStats spy carries its own capture time and may be months old;
-- `bsp_fetched_at` would say "a minute ago" and be useless for judging it. BSP
-- gives no capture time at all, so this stays NULL there — absent, not zero.
ALTER TABLE public.grudge_targets ADD COLUMN IF NOT EXISTS ts_spy_at timestamptz;
