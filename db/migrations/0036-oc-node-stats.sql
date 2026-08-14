-- #440: observed money and respect per diagram node.
--
-- The SSE feed that serves the flowchart also emits an `event: stats` frame
-- keyed BY NODE ID — the same ids oc_scenario_endings.node_id holds. We were
-- already receiving it on that connection and discarding it, which is the only
-- reason E(x) was ever going to be hand-entered.
--
-- Joining these through the derived mapping gives Break the Bank a perfectly
-- monotonic payout ladder ($375.8M → $216.8M, respect 450 → 270 in steps of
-- exactly 45), which independently confirms the #390 position-3/4 swap from a
-- signal — money — completely unrelated to what derived it.
CREATE TABLE IF NOT EXISTS public.oc_scenario_node_stats (
  scenario_name text NOT NULL REFERENCES public.oc_scenarios(name) ON DELETE CASCADE,
  node_id       text NOT NULL,
  -- ⚠️ Observation count, and it must reach the UI. Across the real feed this
  -- ranges from 1 to 6,419. A node with n = 1 has an "average" payout from a
  -- single run and will look exactly as authoritative as one from six thousand
  -- unless the count travels with it.
  n             integer NOT NULL DEFAULT 0,
  -- min/max are real spread, not rounding: Pet Project's best ending observed
  -- $730k–$810k. A range is more honest than a point estimate wherever there
  -- is room to show one.
  money_min     bigint,
  money_max     bigint,
  money_avg     bigint,
  respect_min   numeric,
  respect_max   numeric,
  respect_avg   numeric,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_name, node_id)
);
