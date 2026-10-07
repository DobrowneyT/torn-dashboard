-- #922 — remove the deprecated `visitor` role.
--
-- A read-only outsider profile for leaders of the other TNL family factions. It
-- was superseded by per-faction `role_assignments`, and had become a term that
-- every newly gated surface had to reason about ("is it acceptable for a visitor
-- to see this?") for a role **nobody held**. Confirmed empty on 2026-10-06 across
-- all six databases — ascension, capacityx, forge, forge_dev, mayhem, tnl.
--
-- ⚠️ **The DELETE must come first.** A visitor assignment on a database nobody
-- checked would make the narrowed constraint fail to apply, and because one
-- database failing aborts the migration run, that stops the deploy for EVERY
-- tenant — the 0070 outage shape. Probed: removing this line reproduces
-- `check constraint "role_assignments_role_check" is violated by some row`.
-- A migration that only works because somebody checked by hand does not work.
DELETE FROM public.role_assignments WHERE role = 'visitor';

-- ⚠️ `DROP ... IF EXISTS` then a plain `ADD` is what makes this idempotent, and
-- it is the whole trick: the constraint is always absent by the time `ADD` runs,
-- on a second pass and on a freshly provisioned database alike. (`ADD
-- CONSTRAINT` has no `IF NOT EXISTS`, so without the DROP it would need a
-- `pg_constraint` lookup — I wrote one first, then probed it and found it never
-- fired. Dead guards are worse than none: they claim a hazard is handled
-- somewhere other than where it actually is.)
--
-- ⚠️ Atomic despite being two statements: `db/migrate.mjs` sends each file as a
-- single multi-statement query, which Postgres runs as one implicit
-- transaction — so there is no window where the table sits unconstrained.
ALTER TABLE public.role_assignments
  DROP CONSTRAINT IF EXISTS role_assignments_role_check;

ALTER TABLE public.role_assignments
  ADD CONSTRAINT role_assignments_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'leadership'::text, 'warlead'::text, 'ocmanager'::text]));
