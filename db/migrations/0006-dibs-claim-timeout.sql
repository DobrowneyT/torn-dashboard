-- #159: a dib on an already-alive (Okay) target auto-releases N seconds after
-- the claim if the holder still hasn't killed them, so a stalled claim can't
-- lock everyone else out. N is a war-room setting (default 30s), leadership-
-- editable; it lives on the config singleton beside the chain-poll cadences.
-- The existing per-tick sweep (#106/#107) does the releasing — this only adds
-- the knob and the claim-time deadline.
ALTER TABLE public.war_room_config_v2
  ADD COLUMN IF NOT EXISTS dibs_expiry_seconds integer NOT NULL DEFAULT 30;
