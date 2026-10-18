-- #1007 — where a Chain Watch sign-up came from: the website, or the Discord
-- board's Sign up button. Leadership asked to be able to tell them apart.
ALTER TABLE public.chain_watch_signups ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'web';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chain_watch_signups_via_chk') THEN
    ALTER TABLE public.chain_watch_signups
      ADD CONSTRAINT chain_watch_signups_via_chk CHECK (via IN ('web', 'discord'));
  END IF;
END $$;
