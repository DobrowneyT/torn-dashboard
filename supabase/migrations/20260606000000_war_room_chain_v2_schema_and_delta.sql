-- Phase 7a — War Room chain telemetry table + delta RPC.
--
-- Single source of truth for chain state. Singleton (id = 1) holds:
--   * our chain fields from /v2/faction/10739/chain
--   * chain-save claim (separate from member-target dibs)
--   * enemy chain readout (value + cooldown only) as jsonb
--   * per-side "last fetched" timestamps so the cron tick can throttle
--     polling (ours 5s / enemy 30s) and force when timeout is near.
--
-- RLS: matches the strict_*_faction_select pattern locked in the previous
-- migration. Authenticated faction members read; service-role writes bypass.

-- ── Table ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.war_room_chain_v2 (
  id                       int PRIMARY KEY DEFAULT 1,

  -- Our chain (singleton, from /v2/faction/10739/chain)
  current                  int,
  max                      int,
  modifier                 numeric,
  timeout                  bigint,   -- unix seconds: when chain drops
  start_ts                 bigint,   -- unix seconds: chain start
  cooldown                 bigint,   -- unix seconds: cooldown ends (0 = none)
  end_ts                   bigint,   -- unix seconds: chain ended (0 = active)

  -- Chain-save claim
  save_claimed_by          bigint,
  save_claimed_name        text,
  save_claimed_at          timestamptz,

  -- Enemy chain (value + cooldown only)
  enemy                    jsonb,

  -- Per-side polling watermarks (cron tick uses these to throttle)
  our_last_fetched_at      timestamptz,
  enemy_last_fetched_at    timestamptz,

  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT war_room_chain_v2_singleton CHECK (id = 1)
);

CREATE INDEX IF NOT EXISTS war_room_chain_v2_updated_at_idx
  ON public.war_room_chain_v2 (updated_at);

-- Seed singleton so the cron tick + delta RPC always have a row to work with.
INSERT INTO public.war_room_chain_v2 (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Reuse the existing touch_updated_at_v2 trigger function (defined in
-- 20260601000000_war_room_v2_tables.sql) so any UPDATE bumps updated_at.
DROP TRIGGER IF EXISTS touch_updated_at_chain_v2 ON public.war_room_chain_v2;
CREATE TRIGGER touch_updated_at_chain_v2
  BEFORE INSERT OR UPDATE ON public.war_room_chain_v2
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_v2();

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.war_room_chain_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "strict_war_room_chain_v2_faction_select"
  ON public.war_room_chain_v2;

CREATE POLICY "strict_war_room_chain_v2_faction_select"
  ON public.war_room_chain_v2 FOR SELECT
  TO authenticated
  USING (current_faction_id() = '10739'::text);

-- ── Delta RPC ───────────────────────────────────────────────────────────────
-- Same shape as the other three delta RPCs so useWarRoomPoll can drop it in.

CREATE OR REPLACE FUNCTION public.war_room_chain_v2_delta(p_since timestamptz)
RETURNS TABLE (
  rows       jsonb,
  server_now timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(jsonb_agg(to_jsonb(c.*)), '[]'::jsonb) AS rows,
    v_now                                            AS server_now
  FROM public.war_room_chain_v2 c
  WHERE c.updated_at > COALESCE(p_since, '-infinity'::timestamptz)
    AND c.updated_at <= v_now;
END;
$$;

GRANT EXECUTE ON FUNCTION public.war_room_chain_v2_delta(timestamptz)
  TO anon, authenticated;
