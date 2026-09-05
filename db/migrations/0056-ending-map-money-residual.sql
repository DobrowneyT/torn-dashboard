-- #473: the mass-weighted ending-map residual.
--
-- `ending_map_residual` is scale-free by design, which is right for choosing an
-- assignment and misleading for judging the per-ending MONEY: an ending at 1e-4
-- simulated at 3e-4 moves it as much as the dominant ending being wrong by half,
-- while costing nothing in E(x). Measured across all 31 scenarios the two
-- disagree in both directions -- Mob Mentality reads 0.145 plain and 0.003
-- weighted -- so both are stored and each answers its own question.
--
-- NULL until the next oc-scenarios-mirror run fills it in. Deliberately not
-- backfilled from the existing residual, which would assert a number we have
-- not measured.
ALTER TABLE oc_scenarios ADD COLUMN IF NOT EXISTS ending_map_money_residual numeric;
ALTER TABLE oc_scenarios ADD COLUMN IF NOT EXISTS ending_map_money_confident boolean;
