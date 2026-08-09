-- #358: index faction_revives for the rolling 24-hour window.
--
-- The table has only ever been read one war at a time (WHERE rw_id = $1), so
-- the primary key on revive_id was enough. The standing revives feed added in
-- this change is read differently: "every revive our members received since
-- <epoch seconds>", with no war filter, on every War Room poll.
--
-- Without an index that is a sequential scan over the entire revive history to
-- return a day of it — and the history only grows, so the scan gets slower
-- every war while the answer stays the same size.
--
-- target_id leads because the per-member lookup ("this member's recent
-- revives", for the chance estimate and its tooltip) is the narrower of the
-- two reads; the trailing timestamp still serves the range predicate within a
-- target. The second index covers the whole-window read that has no target.

CREATE INDEX IF NOT EXISTS idx_faction_revives_target_ts
  ON public.faction_revives USING btree (target_id, "timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_faction_revives_ts
  ON public.faction_revives USING btree ("timestamp" DESC);
