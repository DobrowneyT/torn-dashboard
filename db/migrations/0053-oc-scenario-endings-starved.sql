-- #473 — "starved" good endings: the API reports an ending, the diagram
-- draws no matching terminal for it (Blast from the Past, Counter Offer;
-- confirmed with tornprobability's maintainer 2026-08-28). The mirror's
-- reward tracking is keyed strictly by diagram node id, so a starved ending
-- can never be priced from this source no matter how well it is "mapped" —
-- MonChoon: "let's softly mark those endings as 0s for the moment."
--
-- A real column rather than sniffing the `problem` text: `resolved` stays
-- false (accurate — no node was found), `starved` is the separate, explicit
-- signal that the gap is CONFIRMED rather than merely unresolved, so pricing
-- can treat it as $0 instead of a permanent lower bound.
ALTER TABLE public.oc_scenario_endings
  ADD COLUMN IF NOT EXISTS starved boolean NOT NULL DEFAULT false;
