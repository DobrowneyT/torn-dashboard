-- #996 — a target's battle-stat score MEASURED from our own hits.
--
-- Torn reports the real fair fight on every hit, and we know the hitter's exact
-- stats (their own key), so `FF = 1 + 8/3 × defender/attacker` runs backwards:
-- defender score = (FF − 1) × 3/8 × attacker score. A hit at the 3.00 cap only
-- proves "at least 0.75 × attacker", which is kept as a lower bound.
--
-- ⚠️ One row per target, the CURRENT measurement. A hit within the deadband of
-- what we already believed only stamps `confirmed_at`, so the numbers do not
-- wobble with every hit (MonChoon: "some deadband there is reasonable").
CREATE TABLE IF NOT EXISTS public.target_stat_measurements (
  target_id      bigint PRIMARY KEY,
  score          double precision NOT NULL,
  bound          text NOT NULL CHECK (bound IN ('exact', 'at_least')),
  fair_fight     numeric(6,4) NOT NULL,
  attacker_id    bigint NOT NULL,
  attacker_score double precision NOT NULL,
  attack_id      bigint NOT NULL,
  -- When the hit that set this value happened.
  measured_at    timestamptz NOT NULL,
  -- The latest hit that agreed with it, within the deadband.
  confirmed_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- What the War Room shows, copied onto the roster row so it rides the existing
-- live channel. NULL whenever the measurement is expired or a newer spy beats it.
ALTER TABLE public.war_room_state_v2 ADD COLUMN IF NOT EXISTS measured_score double precision;
ALTER TABLE public.war_room_state_v2 ADD COLUMN IF NOT EXISTS measured_bound text;
ALTER TABLE public.war_room_state_v2 ADD COLUMN IF NOT EXISTS measured_at timestamptz;

-- ⚠️ Enabled from the start, unlike most jobs: it spends no Torn calls (it reads
-- what attacks-sync already stored), so there is no budget to opt into.
INSERT INTO public.scraper_jobs (job_name, cron_schedule, enabled)
VALUES ('stat-measurements', NULL, true)
ON CONFLICT (job_name) DO NOTHING;
