-- #965 — event bingo. One card per event, the SAME card for every member; each
-- member crosses squares off their own copy.
--
-- ⚠️ The card IMAGE is a skin. The squares are data (`event_bingo_tiles`), so a
-- square can be ticked automatically, reviewed and audited whatever the art
-- looks like, and a different image is just another upload. The grid is laid
-- over the image at `grid_*`, as percentages of its width and height.
CREATE TABLE IF NOT EXISTS public.event_bingo_cards (
  event_id     bigint PRIMARY KEY REFERENCES public.faction_events(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT false,
  rows         integer NOT NULL DEFAULT 5 CHECK (rows BETWEEN 1 AND 10),
  cols         integer NOT NULL DEFAULT 5 CHECK (cols BETWEEN 1 AND 10),
  grid_left    numeric(5,2) NOT NULL DEFAULT 0   CHECK (grid_left BETWEEN 0 AND 100),
  grid_top     numeric(5,2) NOT NULL DEFAULT 0   CHECK (grid_top BETWEEN 0 AND 100),
  grid_right   numeric(5,2) NOT NULL DEFAULT 100 CHECK (grid_right BETWEEN 0 AND 100),
  grid_bottom  numeric(5,2) NOT NULL DEFAULT 100 CHECK (grid_bottom BETWEEN 0 AND 100),
  image        bytea,
  image_type   text,
  image_updated_at timestamptz,
  updated_by   bigint,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per square, row-major from the top left.
CREATE TABLE IF NOT EXISTS public.event_bingo_tiles (
  event_id bigint NOT NULL REFERENCES public.faction_events(id) ON DELETE CASCADE,
  idx      integer NOT NULL CHECK (idx >= 0),
  label    text NOT NULL DEFAULT '',
  -- proof: the member submits proof, leadership reviews it.
  -- auto:  the dashboard ticks it from data it already has (`rule`).
  -- free:  crossed for everybody.
  kind     text NOT NULL DEFAULT 'proof' CHECK (kind IN ('proof', 'auto', 'free')),
  rule     text,
  PRIMARY KEY (event_id, idx)
);

-- Every cross on every member's card, and every request for one.
CREATE TABLE IF NOT EXISTS public.event_bingo_marks (
  id               bigserial PRIMARY KEY,
  event_id         bigint NOT NULL REFERENCES public.faction_events(id) ON DELETE CASCADE,
  idx              integer NOT NULL,
  member_id        text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  -- proof: the member asked; auto: the dashboard saw it; council: a lead crossed it.
  source           text NOT NULL CHECK (source IN ('proof', 'auto', 'council')),
  proof_text       text,
  proof_image      bytea,
  proof_image_type text,
  -- What the dashboard saw, for an automatic cross: an attack id, a count.
  evidence         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  reviewed_by      bigint,
  reviewed_at      timestamptz,
  review_note      text
);

-- ⚠️ At most one LIVE mark per square per member: a square is either waiting
-- for review or crossed. A rejected request does not block a new one.
CREATE UNIQUE INDEX IF NOT EXISTS event_bingo_marks_live
  ON public.event_bingo_marks (event_id, idx, member_id)
  WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS event_bingo_marks_pending
  ON public.event_bingo_marks (event_id, created_at)
  WHERE status = 'pending';

-- The automatic squares. ⚠️ Zero Torn calls — it reads what attacks-sync, the
-- attack-log archive, Chain Watch and the activity sampler already stored —
-- so it is on from the start.
INSERT INTO public.scraper_jobs (job_name, cron_schedule, enabled)
VALUES ('event-bingo', NULL, true)
ON CONFLICT (job_name) DO NOTHING;
