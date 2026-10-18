-- The event's wanted board (MonChoon, 2026-10-18): outsiders who keep coming at
-- the same member. Part of the event, not a standing page — for now.
--
-- How many attacks on ONE member make someone wanted. Per event, editable in
-- Settings (default 3, MonChoon's starting point).
ALTER TABLE public.faction_events ADD COLUMN IF NOT EXISTS wanted_min_attacks integer NOT NULL DEFAULT 3;

-- Leadership's "not actually wanted" list. ⚠️ A member who PAYS someone for
-- defends or losses gets attacked over and over on purpose; that attacker must
-- not end up as a target. Removal is per event and reversible.
CREATE TABLE IF NOT EXISTS public.event_wanted_dismissed (
  event_id     bigint NOT NULL REFERENCES public.faction_events(id) ON DELETE CASCADE,
  attacker_id  bigint NOT NULL,
  note         text,
  dismissed_by bigint,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, attacker_id)
);
