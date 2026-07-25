-- #229: competition windows move from date to timestamptz so contests can have
-- an exact time-of-day start/end. Existing date-only competitions are preserved:
-- window_start -> start of that day (00:00:00 UTC), window_end -> end of that day
-- (23:59:59.999999 UTC), so a date-based contest still covers its whole last day.
-- Idempotent: only converts columns still typed `date`.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'competitions' AND column_name = 'window_start') = 'date' THEN
    ALTER TABLE public.competitions
      ALTER COLUMN window_start TYPE timestamptz USING (window_start::timestamp AT TIME ZONE 'UTC'),
      ALTER COLUMN window_end   TYPE timestamptz USING (((window_end + 1)::timestamp - interval '1 microsecond') AT TIME ZONE 'UTC');
  END IF;

  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'competition_results' AND column_name = 'window_start') = 'date' THEN
    ALTER TABLE public.competition_results
      ALTER COLUMN window_start TYPE timestamptz USING (window_start::timestamp AT TIME ZONE 'UTC'),
      ALTER COLUMN window_end   TYPE timestamptz USING (((window_end + 1)::timestamp - interval '1 microsecond') AT TIME ZONE 'UTC');
  END IF;
END $$;
