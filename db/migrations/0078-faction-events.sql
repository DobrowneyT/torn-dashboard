-- #969 — a faction event (Halloween first), and the page that hosts it.
--
-- ⚠️ SEPARATE from `chain_events`, and linked to it rather than merged into it.
-- `chain_events` is Chain Watch's sign-up board for ONE chain; a faction event
-- is the page around it, and will not always have a chain at all. Chain Watch
-- deliberately shares nothing with other features, and this keeps that true:
-- the event points at a chain event, never the other way round.
CREATE TABLE IF NOT EXISTS public.faction_events (
  id               bigserial PRIMARY KEY,
  name             text NOT NULL,

  -- The page's accent, e.g. #f97316 for Halloween. A 6-digit hex, so the
  -- frontend can use it directly and a typo cannot reach a style attribute.
  theme_color      text NOT NULL DEFAULT '#f97316'
                   CHECK (theme_color ~ '^#[0-9a-fA-F]{6}$'),

  -- When the event opens — and when the page becomes the landing page.
  starts_at        timestamptz NOT NULL,

  -- Where "day one" begins for daily figures. ⚠️ NOT starts_at: members may
  -- start their own chain anywhere from 10:00 to 16:00 TCT on the first day, so
  -- day one would be unequal. Daily runs from the next midnight TCT instead.
  daily_from       timestamptz NOT NULL,

  -- ⚠️ The END IS NOT A DATE. The event lasts at least until min_ends_at, and
  -- after that, while `ends_with_chain` is set, until the chain finishes or
  -- breaks (MonChoon: "The event will end when our chain reaches 100k or when
  -- the chain dies... at minimum the event will last until November 1 16:00
  -- TCT."). So "is it live" is a question, never a comparison against a stored
  -- end — see eventLifecycle.ts.
  min_ends_at      timestamptz NOT NULL,
  ends_with_chain  boolean NOT NULL DEFAULT true,

  -- Set when the event is over: by a lead, or by the lifecycle once the chain
  -- has ended past min_ends_at. NULL while it has not ended.
  ended_at         timestamptz,

  -- The Chain Watch board for this event's chain, if there is one. ⚠️ SET NULL
  -- on delete: removing a Chain Watch event must never delete the faction event.
  chain_event_id   bigint REFERENCES public.chain_events(id) ON DELETE SET NULL,

  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT faction_events_daily_after_start CHECK (daily_from >= starts_at),
  CONSTRAINT faction_events_min_end_after_start CHECK (min_ends_at > starts_at)
);

-- The page asks "what is the current event?" on every load.
CREATE INDEX IF NOT EXISTS faction_events_open_idx
  ON public.faction_events (starts_at)
  WHERE ended_at IS NULL;
