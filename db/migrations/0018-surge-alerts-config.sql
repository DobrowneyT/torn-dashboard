-- #208: PUSH-surge alert config on the war room. A single global on/off (off by
-- default — a termed war should stay silent until leadership opts in), plus
-- per-direction rate thresholds (N members Okay within M seconds) and a
-- per-direction cooldown. War leads / leadership / admin edit these in War Room
-- settings.
ALTER TABLE public.war_room_config_v2
  ADD COLUMN IF NOT EXISTS surge_alerts_enabled   boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS surge_enemy_threshold  integer DEFAULT 3   NOT NULL,
  ADD COLUMN IF NOT EXISTS surge_enemy_window_sec integer DEFAULT 60  NOT NULL,
  ADD COLUMN IF NOT EXISTS surge_our_threshold    integer DEFAULT 4   NOT NULL,
  ADD COLUMN IF NOT EXISTS surge_our_window_sec   integer DEFAULT 60  NOT NULL,
  ADD COLUMN IF NOT EXISTS surge_cooldown_sec     integer DEFAULT 300 NOT NULL;
