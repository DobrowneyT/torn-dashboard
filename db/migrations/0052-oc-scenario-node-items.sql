-- Item pricing for OC scenario endings (#441 follow-up, MonChoon 2026-08-28).
--
-- The mirror's stats frame carries a per-node `items` array (name,
-- occurrences, avg quantity) that probabilityClient.ts was discarding — only
-- money and respect were read. Crimes that pay in items (Window of
-- Opportunity, and everything paysInItems() already flags — Best of the Lot,
-- Crane Reaction, Gaslight the Way, Stage Fright) showed as unpriced despite
-- the source data existing all along.
ALTER TABLE public.oc_scenario_node_stats
  ADD COLUMN IF NOT EXISTS items jsonb NOT NULL DEFAULT '[]'::jsonb;
