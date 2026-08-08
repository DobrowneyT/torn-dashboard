-- #359: a second push-surge detector, watching members turn their revives ON.
--
-- The existing detector (#208) fires when N members become Okay — by which
-- point the push has already started. Nobody enables revives casually mid-war;
-- they do it because they expect to be hospitalised and want a hired reviver to
-- bring them straight back. A cluster of that is a push being SET UP.
--
-- Its own columns rather than reusing the status ones: the two signals have
-- genuinely different rates. Cycling through hospital happens constantly during
-- a chain, while enabling revives is deliberate and rare, so it wants a longer
-- window at a similar threshold. Sharing a window would force one of them to be
-- tuned wrong.
--
-- Defaults are OFF, like every other alerting feature — leadership opts in.

ALTER TABLE public.war_room_config_v2
  ADD COLUMN IF NOT EXISTS surge_revive_alerts_enabled boolean DEFAULT false NOT NULL,
  -- Enemy: "a push is being set up against us".
  ADD COLUMN IF NOT EXISTS surge_revive_enemy_threshold integer DEFAULT 3 NOT NULL,
  ADD COLUMN IF NOT EXISTS surge_revive_enemy_window_sec integer DEFAULT 300 NOT NULL,
  -- Ours: readiness signal for a lead organising a push.
  ADD COLUMN IF NOT EXISTS surge_revive_our_threshold integer DEFAULT 4 NOT NULL,
  ADD COLUMN IF NOT EXISTS surge_revive_our_window_sec integer DEFAULT 300 NOT NULL,
  -- Longer than the status cooldown (300s): revive prep is a slower event, and
  -- re-alerting on the same preparation is noise.
  ADD COLUMN IF NOT EXISTS surge_revive_cooldown_sec integer DEFAULT 600 NOT NULL;
