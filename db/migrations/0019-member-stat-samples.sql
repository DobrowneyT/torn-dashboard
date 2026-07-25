-- #227: append-only intraday sample series for competition-relevant stats.
-- Idempotent — brings an existing faction DB up to the template shape.
CREATE TABLE IF NOT EXISTS public.member_stat_samples (
  id            bigserial PRIMARY KEY,
  member_id     text NOT NULL REFERENCES public.members(member_id) ON DELETE CASCADE,
  captured_at   timestamp with time zone NOT NULL DEFAULT now(),
  stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
  gym_strength  bigint,
  gym_speed     bigint,
  gym_dexterity bigint,
  gym_defense   bigint,
  gym_energy    bigint
);

CREATE INDEX IF NOT EXISTS member_stat_samples_member_time_idx
  ON public.member_stat_samples (member_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS member_stat_samples_captured_idx
  ON public.member_stat_samples (captured_at);
