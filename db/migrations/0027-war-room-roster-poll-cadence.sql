-- #339: configurable roster refresh cadence.
--
-- The roster sync ran on every ticker tick with the ticker hardcoded at 1 Hz —
-- no setting existed anywhere. (The client-side "UI Refresh" slider looked like
-- this control but was never wired to anything.)
--
-- Milliseconds, not seconds like the other cadences: leads want to push this to
-- 2 Hz during a live chain, which a whole-second column cannot express. Floored
-- at 500ms in CONFIG_BOUNDS and again in the ticker's gate, because each sync is
-- two Torn calls (their roster + ours) and 2 Hz is already 240 calls a minute.
--
-- Default 1000 = the 1 Hz the board has always run at, so this changes nothing
-- until a lead moves it.

ALTER TABLE public.war_room_config_v2
  ADD COLUMN IF NOT EXISTS roster_poll_interval_ms integer DEFAULT 1000 NOT NULL;
