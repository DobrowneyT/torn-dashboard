-- #188: pin competitions to the dashboard. Multiple can be pinned at once; the
-- dashboard renders a compact card per pinned competition.
ALTER TABLE public.competitions
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
