-- #471: how well the derived ending map actually fits.
--
-- The map is now produced by forward-simulating the flowchart and matching the
-- simulated distribution to the API's, so for the first time there IS a measure
-- of how good the match is — and it must be stored, because an assignment
-- always returns *something*. Without a residual a confidently wrong mapping is
-- indistinguishable from a right one, and the wrongness is the expensive kind:
-- each ending carries a DIFFERENT ending's money and every figure stays
-- plausible.
--
-- ⚠️ Two separate facts, deliberately not collapsed into one flag:
--   • `ending_map_ok` — every ending the API reports got a node. Pricing needs
--     this and nothing more.
--   • `ending_map_confident` — the numbers behind that assignment line up.
--     Ten of 31 scenarios are the first without being the second: their
--     successChance is reproduced EXACTLY while the split between endings is
--     not, so the map is complete and the per-ending money is not yet
--     trustworthy.
ALTER TABLE public.oc_scenarios
  ADD COLUMN IF NOT EXISTS ending_map_residual numeric,
  ADD COLUMN IF NOT EXISTS ending_map_confident boolean;
