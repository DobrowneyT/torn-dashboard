-- Whether a live event recolours the WHOLE site in its theme colour, not just
-- its own page (MonChoon, 2026-10-17: "if there's an event and we specify some
-- colour it changes for the entire site"). On by default; a per-event switch so
-- the experiment can be turned off without touching anything else.
ALTER TABLE public.faction_events ADD COLUMN IF NOT EXISTS site_accent boolean NOT NULL DEFAULT true;
