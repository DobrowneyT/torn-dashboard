-- #459: per-member Torn event start windows, behind their own consent scope.
--
-- Each Torn player picks a personal event start hour. During an event everyone's
-- 48-hour window opens at their own time, so where each member's window sits is
-- real coordination information and nothing in the dashboard shows it.
--
-- ⚠️ **The consent is separate from the key's consent, and that is the entire
-- point of this migration.** Members already consented to a stated list of uses
-- when they enrolled their key. Reading `/user/calendar` is not on that list.
-- Widening what an existing key is used for without asking again is exactly
-- what a consent record exists to prevent — so this scope is recorded
-- separately, defaults to absent, and the scraper only ever touches keys that
-- have it.
--
-- Deliberately NOT done by bumping `consent_version`: that gates the whole key
-- pool, so a bump would take every scraper offline until each member logged in
-- again. Punishing the faction's data collection to add an optional feature is
-- the wrong trade.
ALTER TABLE public.member_secrets
  ADD COLUMN IF NOT EXISTS calendar_scope_at timestamptz,
  ADD COLUMN IF NOT EXISTS calendar_scope_version text;

-- The observed value. One row per member who opted in.
--
-- ⚠️ Deleted on withdrawal, never merely hidden — hence a separate table rather
-- than columns on member_secrets, where a stale value could outlive the consent
-- that permitted collecting it. `ON DELETE CASCADE` also means removing a key
-- removes the data it gathered.
CREATE TABLE IF NOT EXISTS public.member_event_settings (
  member_id  text PRIMARY KEY,
  -- Stored exactly as Torn states it ("11:30 TCT"). Not parsed into a time on
  -- write: if Torn ever changes the format, a wrong parse would be silently
  -- wrong on every member at once, and the raw string can always be re-read.
  start_time text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
