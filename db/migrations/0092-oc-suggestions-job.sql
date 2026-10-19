-- #1022 / #1023 — the OC action feed's producers. ⚠️ Enabled from the start:
-- they spend no Torn calls, reading only what other jobs already stored.
INSERT INTO public.scraper_jobs (job_name, cron_schedule, enabled)
VALUES ('oc-suggestions', NULL, true)
ON CONFLICT (job_name) DO NOTHING;
