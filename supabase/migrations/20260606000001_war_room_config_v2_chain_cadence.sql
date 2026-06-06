-- Phase 7c.5 — make chain poll cadence configurable per leadership panel.
--
-- Defaults match the plan (ours = 5s, enemy = 30s). The Edge Function's
-- chainSidePollDecision() reads these on every cron tick; leadership can
-- adjust without code+redeploy. Clamped to [1, 600] server-side.

ALTER TABLE public.war_room_config_v2
  ADD COLUMN IF NOT EXISTS chain_poll_interval_ours_sec  int NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS chain_poll_interval_enemy_sec int NOT NULL DEFAULT 30;
