-- Idempotent migration: schema added since the original template snapshot
-- (slices #67–#73). template.sql is the source of truth for NEW faction
-- DBs; EXISTING DBs (created before these slices) get the same shape by
-- running db/migrate.mjs. Everything here is safe to re-run.

-- Scraper core (#67): run log + per-job flags.
CREATE TABLE IF NOT EXISTS public.scraper_runs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  job_name text NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  finished_at timestamp with time zone,
  status text DEFAULT 'running' NOT NULL,
  rows_written integer DEFAULT 0 NOT NULL,
  error text,
  details jsonb
);

CREATE TABLE IF NOT EXISTS public.scraper_jobs (
  job_name text NOT NULL,
  cron_schedule text NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scraper_runs_pkey') THEN
    ALTER TABLE scraper_runs ADD CONSTRAINT scraper_runs_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scraper_runs_status_check') THEN
    ALTER TABLE scraper_runs ADD CONSTRAINT scraper_runs_status_check
      CHECK (status IN ('running', 'success', 'failure'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scraper_jobs_pkey') THEN
    ALTER TABLE scraper_jobs ADD CONSTRAINT scraper_jobs_pkey PRIMARY KEY (job_name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scraper_runs_job_started
  ON public.scraper_runs USING btree (job_name, started_at DESC);

-- Key-pool rotation marker (#67).
ALTER TABLE public.member_secrets
  ADD COLUMN IF NOT EXISTS last_claimed_at timestamp with time zone;

-- Wars-sync progress flags (#70).
ALTER TABLE public.ranked_wars
  ADD COLUMN IF NOT EXISTS report_fetched boolean DEFAULT false NOT NULL;
ALTER TABLE public.ranked_wars
  ADD COLUMN IF NOT EXISTS report_unavailable boolean DEFAULT false NOT NULL;
