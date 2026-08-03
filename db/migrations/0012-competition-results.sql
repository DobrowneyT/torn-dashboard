-- #185: resolved competition standings — the durable, payout-referenceable
-- record. Resolving a competition materialises its current standings into one
-- row per member, sharing a resolution_seq (1,2,3… per competition — a fixed
-- competition resolves once, a rolling one accretes a resolution per draw).
-- The top-ranked member of each resolution is flagged winner. Self-contained by
-- design (window + value + rank travel with each row) so a future payout can
-- read it without recomputation.
CREATE TABLE IF NOT EXISTS public.competition_results (
  id             bigserial PRIMARY KEY,
  competition_id bigint NOT NULL,
  resolution_seq integer NOT NULL,
  resolved_at    timestamp with time zone NOT NULL DEFAULT now(),
  resolved_by    text,
  window_start   date NOT NULL,
  window_end     date NOT NULL,
  member_id      text NOT NULL,
  member_name    text,
  value          double precision NOT NULL,
  rank           integer NOT NULL,
  partial        boolean NOT NULL DEFAULT false,
  winner         boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS competition_results_competition_idx
  ON public.competition_results (competition_id, resolution_seq);
