-- #473: does the flowchart model each ROLE the way the service's own model does?
--
-- The simulator has only ever been validated against successChance at ONE point
-- (every role at CPR 99), where it is exact for all 31 scenarios. Asking the
-- same oracle at a dropped CPR shows twelve of the thirty-one disagree, several
-- catastrophically -- Window of Opportunity's Looter 1 at CPR 1 reads 0.9804
-- from the service and 0.3897 from the diagram.
--
-- That is an upstream disagreement between the two things we mirror, so it is
-- recorded per scenario rather than papered over: a crime that fails this names
-- the roles whose numbers cannot be trusted.
ALTER TABLE oc_scenarios ADD COLUMN IF NOT EXISTS role_fidelity_error numeric;
ALTER TABLE oc_scenarios ADD COLUMN IF NOT EXISTS role_fidelity_roles jsonb;
